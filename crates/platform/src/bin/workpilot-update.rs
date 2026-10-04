#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::path::Path;
use workpilot_platform::update;
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        let result = std::env::current_exe()
            .map_err(|_| "无法定位恢复工具。".into())
            .and_then(|path| update::recover_interactive(&path));
        if result.is_err() {
            std::process::exit(1);
        }
        return;
    }
    if args.len() == 2 && args[0] == "--create-recovery" {
        match update::prepare_recovery_entry(Path::new(&args[1])) {
            Ok(entry) => println!("{}", serde_json::to_string(&entry).unwrap()),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        return;
    }
    if args.len() == 2 && args[0] == "--uninstall-updated" {
        match update::remove_updated_files(Path::new(&args[1])) {
            Ok(files) => println!("{}", serde_json::json!({"removed_update_files":files})),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        return;
    }
    if args
        .first()
        .is_some_and(|a| a == "--prepare" || a == "--inspect")
    {
        if let Err(error) = prepare_cli(&args) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    let result = (|| -> Result<_, String> {
        if args.len() == 4 && args[0] == "--apply" && args[2] == "--wait" {
            let pid = args[3].parse::<u32>().map_err(|_| "无效的升级等待进程。")?;
            wait(pid)?;
            update::apply(Path::new(&args[1]))
        } else if args.len() == 2 && args[0] == "--recover" {
            update::recover(Path::new(&args[1]))
        } else {
            Err("请从 WorkPilot 设置页面准备并确认更新。".into())
        }
    })();
    if let Some(path) = args.get(1).map(Path::new).filter(|p| p.is_absolute())
        && let Some(parent) = path.parent()
    {
        let value = match &result {
            Ok(r) => serde_json::to_value(r).unwrap_or_default(),
            Err(e) => serde_json::json!({"state":"failed","message":e}),
        };
        let _ = std::fs::write(
            parent.join("update-result.json"),
            serde_json::to_vec_pretty(&value).unwrap_or_default(),
        );
    }
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
fn prepare_cli(args: &[String]) -> Result<(), String> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Input {
        install: std::path::PathBuf,
        data: std::path::PathBuf,
        source: String,
        current_version: String,
        fingerprint: Option<String>,
    }
    if args.len() != 2 {
        return Err("需要一个本机更新准备记录。".into());
    }
    let bytes = std::fs::read(&args[1]).map_err(|_| "无法读取更新准备参数。")?;
    if bytes.len() > 16384 {
        return Err("更新准备参数过大。".into());
    }
    let input: Input = serde_json::from_slice(&bytes).map_err(|_| "更新准备参数格式错误。")?;
    let preview = update::inspect_source(&input.source, &input.current_version)?;
    let value = if args[0] == "--prepare" {
        let fingerprint = input.fingerprint.ok_or("请先检查更新并核对预览指纹。")?;
        serde_json::to_value(update::prepare(
            &input.install,
            &input.data,
            &input.source,
            &input.current_version,
            &fingerprint,
        )?)
        .map_err(|_| "无法读取准备结果。")?
    } else {
        serde_json::to_value(preview).map_err(|_| "无法读取检查结果。")?
    };
    println!("{}", value);
    Ok(())
}
#[cfg(windows)]
fn wait(pid: u32) -> Result<(), String> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, WAIT_OBJECT_0},
        System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
    };
    if pid == std::process::id() || pid == 0 {
        return Err("升级等待目标无效。".into());
    }
    // No process is killed. A missing parent has already exited.
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            return Ok(());
        }
        let state = WaitForSingleObject(handle, 120000);
        CloseHandle(handle);
        if state != WAIT_OBJECT_0 {
            return Err("桌面尚未退出，升级没有开始。".into());
        }
    }
    Ok(())
}
#[cfg(not(windows))]
fn wait(_pid: u32) -> Result<(), String> {
    Err("本版签名安装切换只对 Windows 开放。".into())
}
