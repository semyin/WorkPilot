use crate::vault::Result;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, atomic::AtomicBool},
};
use workpilot_contracts::PluginRuntime;
use workpilot_platform::tool_process::{self, ProcessInput, ProcessSpec};

#[derive(Default)]
pub struct Worker {
    gate: tokio::sync::Mutex<()>,
}
pub struct Output {
    pub report: Value,
    pub bytes: Option<Vec<u8>>,
}
fn checked_hash(bytes: &[u8], stop: &AtomicBool) -> Result<String> {
    let mut hash = Sha256::new();
    for chunk in bytes.chunks(256 * 1024) {
        if stop.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("操作已停止 / Operation stopped".into());
        }
        hash.update(chunk);
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn runtime(data: &Path, stop: &AtomicBool) -> Result<(PathBuf, PathBuf)> {
    let installed = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .ok_or("missing application directory")?
        .join("document-runtime");
    let resources = if installed.join("worker.mjs").is_file() {
        installed
    } else if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../services/documents")
            .canonicalize()
            .map_err(|e| e.to_string())?
    } else {
        return Err("文档运行环境缺失，请保留完整程序目录 / Document runtime is missing".into());
    };
    let (original, _) =
        workpilot_extensions::runtime_command(PluginRuntime::Node, &resources.join("worker.mjs"))?;
    let bytes = std::fs::read(original).map_err(|e| e.to_string())?;
    let hash = checked_hash(&bytes, stop)?;
    let folder = data.join("media/runtime").join(&hash);
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let program = folder.join(if cfg!(windows) { "node.exe" } else { "node" });
    if !program.exists() {
        let mut temp = tempfile::NamedTempFile::new_in(&folder).map_err(|e| e.to_string())?;
        temp.write_all(&bytes)
            .and_then(|_| temp.as_file().sync_all())
            .map_err(|e| e.to_string())?;
        match temp.persist_noclobber(&program) {
            Ok(_) => {}
            Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    if checked_hash(&std::fs::read(&program).map_err(|e| e.to_string())?, stop)? != hash {
        return Err("文档运行环境校验失败 / Runtime verification failed".into());
    }
    Ok((program, resources))
}
impl Worker {
    pub async fn run(
        &self,
        data: &Path,
        job: Value,
        input: Option<&[u8]>,
        stop: Arc<AtomicBool>,
    ) -> Result<Output> {
        let _guard = tokio::select! {
            guard=self.gate.lock()=>guard,
            _=async {loop {if stop.load(std::sync::atomic::Ordering::SeqCst){break;}tokio::time::sleep(std::time::Duration::from_millis(40)).await;}}=>return Err("文档等待已取消 / Document operation cancelled while waiting".into()),
        };
        if stop.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("操作已停止 / Operation stopped".into());
        }
        let data = data.to_owned();
        let input = input.map(<[u8]>::to_vec);
        tokio::task::spawn_blocking(move || {
            let (program, resources) = runtime(&data, &stop)?;
            let root = data.join("media/jobs");
            std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
            let temp = tempfile::tempdir_in(root).map_err(|e| e.to_string())?;
            std::fs::write(
                temp.path().join("job.json"),
                serde_json::to_vec(&job).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            if let Some(input) = input {
                std::fs::write(temp.path().join("input.bin"), input).map_err(|e| e.to_string())?;
            }
            let (tx, rx) = std::sync::mpsc::channel();
            drop(tx);
            let result = tool_process::run_interactive(
                ProcessSpec {
                    program,
                    args: vec![
                        "--max-old-space-size=512".into(),
                        "--preserve-symlinks".into(),
                        "--preserve-symlinks-main".into(),
                        resources
                            .join("worker.mjs")
                            .to_string_lossy()
                            .replace(r"\\?\", ""),
                    ],
                    cwd: temp.path().to_path_buf(),
                    sandboxed: true,
                    timeout_ms: 90000,
                    output_limit: 128 * 1024,
                    ledger_dir: data.join("tool-sandboxes"),
                },
                stop,
                None,
                ProcessInput {
                    messages: rx,
                    read_roots: vec![resources],
                    environment: vec![],
                },
            )
            .map_err(|e| e.to_string())?;
            if let Some(reason) = result.stopped {
                return Err(format!(
                    "文档处理已停止 / Document processing stopped: {reason}"
                ));
            }
            let report_path = temp.path().join("report.json");
            if !report_path.is_file() {
                return Err(format!(
                    "文档处理程序未返回结果 / Document worker did not return a result ({}): {}",
                    result.exit_code,
                    result.stderr.chars().take(500).collect::<String>()
                ));
            }
            if std::fs::metadata(&report_path)
                .map_err(|e| e.to_string())?
                .len()
                > 12 * 1024 * 1024
            {
                return Err("文档解析结果超限 / Parsed document exceeds limits".into());
            }
            let report: Value =
                serde_json::from_slice(&std::fs::read(report_path).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            if report["ok"] != true || result.exit_code != 0 {
                return Err(report["error"]
                    .as_str()
                    .unwrap_or("Document processing failed")
                    .to_owned());
            }
            let output = temp.path().join(if job["kind"] == "preview" {
                "preview.png"
            } else {
                "output.bin"
            });
            let bytes = if output.is_file() {
                if std::fs::metadata(&output).map_err(|e| e.to_string())?.len() > 32 * 1024 * 1024 {
                    return Err("Generated file exceeds 32 MiB".into());
                }
                Some(std::fs::read(output).map_err(|e| e.to_string())?)
            } else {
                None
            };
            if !result.cleanup_errors.is_empty() {
                return Err(
                    "文档进程权限清理未完成 / Document process cleanup was incomplete".into(),
                );
            }
            Ok(Output { report, bytes })
        })
        .await
        .map_err(|e| e.to_string())?
    }
}
