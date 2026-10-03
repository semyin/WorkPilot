use crate::vault::Result;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use workpilot_platform::tool_process::{self, ProcessInput, ProcessSpec};
const BUILD: &str = "bce0998afefdbc355585ca324285661a2170ba77";
const CACHE_BYTES: usize = 64 * 1024 * 1024;
#[derive(Default)]
pub struct Converter {
    state: tokio::sync::Mutex<State>,
}
#[derive(Default)]
struct State {
    runtime: Option<Runtime>,
    files: VecDeque<(String, Arc<Vec<u8>>)>,
    bytes: usize,
}
#[derive(Clone)]
struct Runtime {
    root: PathBuf,
    program: PathBuf,
    fingerprint: String,
}
pub struct Pdf {
    pub bytes: Arc<Vec<u8>>,
    pub cached: bool,
    pub renderer: String,
}
pub fn format(mime: &str) -> Option<&'static str> {
    match mime {
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => Some("docx"),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => Some("xlsx"),
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" => Some("pptx"),
        _ => None,
    }
}
fn stopped(stop: &AtomicBool) -> Result<()> {
    if stop.load(Ordering::SeqCst) {
        Err("版式预览已停止 / Layout preview stopped".into())
    } else {
        Ok(())
    }
}
fn read_result(path: &Path, limit: u64) -> Result<Vec<u8>> {
    // The isolated worker is no longer alive here. Still treat its directory
    // as untrusted: an output must not redirect the host to another file.
    let metadata = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("Office renderer output must be a regular file".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("Office renderer output cannot be a reparse point".into());
        }
    }
    if metadata.len() == 0 || metadata.len() > limit {
        return Err("Office renderer output exceeds its size limit".into());
    }
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.is_empty() || bytes.len() as u64 > limit {
        return Err("Office renderer output exceeds its size limit".into());
    }
    Ok(bytes)
}
fn runtime(stop: &AtomicBool) -> Result<Runtime> {
    if !cfg!(windows) {
        return Err(
            "此系统的 Office 预览尚未验证 / Office preview is not verified on this platform".into(),
        );
    }
    let root = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .ok_or("Missing application directory")?
        .join("office-runtime");
    let manifest = root.join("runtime-manifest.json");
    if !manifest.is_file() {
        return Err(
            "Office 预览组件缺失，请保留完整程序目录 / Office preview runtime is missing".into(),
        );
    }
    if std::fs::metadata(&manifest)
        .map_err(|e| e.to_string())?
        .len()
        > 5 * 1024 * 1024
    {
        return Err("Office runtime manifest exceeds limit".into());
    }
    let bytes = std::fs::read(manifest).map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if value["buildId"] != BUILD {
        return Err("Office renderer version is not supported".into());
    }
    let files = value["files"]
        .as_array()
        .ok_or("Missing Office inventory")?;
    for name in [
        "workpilot-office.exe",
        "mergedlo.dll",
        "sal3.dll",
        "cppu3.dll",
        "cppuhelper3MSC.dll",
        "python313.dll",
        "pyuno.pyd",
        "uno.py",
        "unohelper.py",
    ] {
        let relative = format!("office/program/{name}");
        let expected = files
            .iter()
            .find(|v| v["path"] == relative)
            .ok_or("Incomplete Office runtime inventory")?;
        let mut file = std::fs::File::open(root.join(&relative))
            .map_err(|e| format!("Office component missing: {name}: {e}"))?;
        if Some(file.metadata().map_err(|e| e.to_string())?.len()) != expected["bytes"].as_u64() {
            return Err("Office component size mismatch".into());
        }
        let mut hash = Sha256::new();
        let mut buffer = vec![0u8; 256 * 1024];
        loop {
            stopped(stop)?;
            let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            hash.update(&buffer[..n]);
        }
        if expected["sha256"] != format!("{:x}", hash.finalize()) {
            return Err("Office component verification failed".into());
        }
    }
    Ok(Runtime {
        program: root.join("office/program/workpilot-office.exe"),
        root,
        fingerprint: format!("{:x}", Sha256::digest(bytes)),
    })
}
impl Converter {
    pub async fn pdf(
        &self,
        data: &Path,
        key: &str,
        format: &str,
        bytes: &[u8],
        stop: Arc<AtomicBool>,
    ) -> Result<Pdf> {
        if !matches!(format, "docx" | "xlsx" | "pptx") {
            return Err("Unsupported Office format".into());
        }
        let mut state = tokio::select! {
            value=self.state.lock()=>value,
            _=async{while !stop.load(Ordering::SeqCst){tokio::time::sleep(std::time::Duration::from_millis(40)).await;}}=>return Err("版式预览等待已取消 / Preview cancelled while waiting".into()),
        };
        stopped(&stop)?;
        if state.runtime.is_none() {
            let cancellation = stop.clone();
            state.runtime = Some(
                tokio::task::spawn_blocking(move || runtime(&cancellation))
                    .await
                    .map_err(|e| e.to_string())??,
            );
        }
        let runtime = state.runtime.as_ref().unwrap().clone();
        let cache_key = format!("{key}:{}", runtime.fingerprint);
        let renderer = format!("LibreOfficeKit 26.8.0 · {}", &runtime.fingerprint[..12]);
        if let Some(index) = state.files.iter().position(|(key, _)| key == &cache_key) {
            let cached = state.files.remove(index).unwrap();
            let bytes = cached.1.clone();
            state.files.push_back(cached);
            return Ok(Pdf {
                bytes,
                cached: true,
                renderer,
            });
        }
        let data = data.to_owned();
        let format = format.to_owned();
        let bytes = bytes.to_vec();
        let cancellation = stop.clone();
        let pdf = tokio::task::spawn_blocking(move || {
            convert(&runtime, &data, &format, &bytes, cancellation)
        })
        .await
        .map_err(|e| e.to_string())??;
        stopped(&stop)?;
        while state.bytes + pdf.len() > CACHE_BYTES || state.files.len() >= 4 {
            if let Some((_, old)) = state.files.pop_front() {
                state.bytes -= old.len();
            } else {
                break;
            }
        }
        state.bytes += pdf.len();
        let bytes = Arc::new(pdf);
        state.files.push_back((cache_key, bytes.clone()));
        Ok(Pdf {
            bytes,
            cached: false,
            renderer,
        })
    }
}
fn convert(
    runtime: &Runtime,
    data: &Path,
    format: &str,
    bytes: &[u8],
    stop: Arc<AtomicBool>,
) -> Result<Vec<u8>> {
    stopped(&stop)?;
    let jobs = data.join("media/office-jobs");
    std::fs::create_dir_all(&jobs).map_err(|e| e.to_string())?;
    let job = tempfile::tempdir_in(jobs).map_err(|e| e.to_string())?;
    std::fs::write(job.path().join(format!("input.{format}")), bytes).map_err(|e| e.to_string())?;
    let (tx, rx) = std::sync::mpsc::channel();
    drop(tx);
    let result = tool_process::run_interactive(
        ProcessSpec {
            program: runtime.program.clone(),
            args: vec![],
            cwd: job.path().to_owned(),
            sandboxed: true,
            timeout_ms: 90000,
            output_limit: 128 * 1024,
            ledger_dir: data.join("tool-sandboxes"),
        },
        stop,
        None,
        ProcessInput {
            messages: rx,
            read_roots: vec![runtime.root.clone()],
            environment: vec![
                ("SAL_DISABLESKIA".into(), "1".to_string().into()),
                ("SAL_DISABLE_OPENCL".into(), "1".to_string().into()),
            ],
        },
    )
    .map_err(|e| e.to_string())?;
    if !result.cleanup_errors.is_empty() {
        return Err("Office 预览进程清理未完成 / Office worker cleanup incomplete".into());
    }
    if let Some(reason) = result.stopped {
        return Err(format!(
            "Office 预览已停止 / Office preview stopped: {reason}"
        ));
    }
    let report = job.path().join("report.json");
    let report: Value =
        serde_json::from_slice(&read_result(&report, 16384)?).map_err(|e| e.to_string())?;
    if result.exit_code != 0 || report["ok"] != true {
        return Err(report["error"]
            .as_str()
            .unwrap_or("Office conversion failed")
            .to_owned());
    }
    let output = job.path().join("preview.pdf");
    let bytes = read_result(&output, 32 * 1024 * 1024)?;
    if !bytes.starts_with(b"%PDF-") {
        return Err("Office 转换结果不是 PDF / Office renderer output is not a PDF".into());
    }
    Ok(bytes)
}
