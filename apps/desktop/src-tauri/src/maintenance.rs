use crate::{Bridge, main_only};
use std::{
    io::{Read, Write},
    path::PathBuf,
    process::Stdio,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{State, Webview};
use workpilot_contracts::*;
#[derive(Default)]
pub struct Maintenance {
    data: Mutex<Option<PathBuf>>,
}

#[tauri::command]
pub async fn maintenance_apply(
    view: Webview,
    bridge: State<'_, Bridge>,
    state: State<'_, Maintenance>,
    request: MaintenanceApply,
) -> Result<serde_json::Value, String> {
    main_only(&view)?;
    request.selection.validate().map_err(str::to_owned)?;
    let confirmation = if matches!(request.selection, MaintenanceSelection::Reset) {
        "RESET"
    } else {
        "DELETE"
    };
    if request.confirmation != confirmation {
        return Err("确认文字不匹配。".into());
    }
    let previous = state.data.lock().map_err(|_| "维护状态不可用")?.clone();
    let data = if let Some(data) = previous {
        data
    } else {
        let response = bridge
            .request(Request {
                request_id: uuid::Uuid::new_v4().to_string(),
                command: Command::Read {
                    query: Query::Workspace {
                        query: WorkspaceQuery::Overview,
                    },
                },
            })
            .await?;
        let Response::Workspace { data } = response else {
            return Err("无法核对数据目录。".into());
        };
        let WorkspaceData::Overview { data_dir, .. } = *data else {
            return Err("无法核对数据目录。".into());
        };
        let path = PathBuf::from(data_dir)
            .canonicalize()
            .map_err(|_| "数据目录不可用")?;
        *state.data.lock().map_err(|_| "维护状态不可用")? = Some(path.clone());
        path
    };
    let exe = std::env::current_exe().map_err(|_| "无法定位程序")?;
    let sidecar = exe.parent().ok_or("无法定位程序")?.join(if cfg!(windows) {
        "workpilot-sidecar.exe"
    } else {
        "workpilot-sidecar"
    });
    if !sidecar.is_file() {
        return Err("维护助手缺失，程序尚未停止。".into());
    }
    bridge.shutdown();
    tauri::async_runtime::spawn_blocking(move || run(sidecar, data, request))
        .await
        .map_err(|_| "维护助手中断；请重新启动 WorkPilot。".to_owned())?
}
fn run(
    sidecar: PathBuf,
    data: PathBuf,
    request: MaintenanceApply,
) -> Result<serde_json::Value, String> {
    let mut command = std::process::Command::new(sidecar);
    command
        .arg("--maintenance")
        .arg(&data)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    // Keep the offline helper owned by this desktop process, just like the
    // regular engine. Closing the application must not leave a cleaner running.
    let mut helper = workpilot_platform::process::ManagedEngine::spawn(&mut command)
        .map_err(|_| "无法启动维护助手，请重启 WorkPilot。")?;
    let child = &mut helper.child;
    let output = child.stdout.take().ok_or("维护结果不可用")?;
    let (sender, reader) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(read_output(output));
    });
    let mut input = child.stdin.take().ok_or("维护输入不可用")?;
    let bytes =
        zeroize::Zeroizing::new(serde_json::to_vec(&request).map_err(|_| "无法编码维护请求")?);
    input.write_all(&bytes).map_err(|_| "无法写入维护请求")?;
    drop(input);
    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        match child.try_wait().map_err(|_| "维护进程不可用")? {
            Some(_) => break,
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("维护超时。请重启检查结果；已确认的未完成清空会继续处理。".into());
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    }
    let result = reader
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| "维护输出未正常关闭，请重启检查结果。")??;
    let result: serde_json::Value = serde_json::from_slice(&result)
        .map_err(|_| "维护结果不完整，请重新启动 WorkPilot 检查。")?;
    if result["ok"] != true {
        return Err(result["error"].as_str().unwrap_or("维护未完成").into());
    }
    Ok(result["result"].clone())
}
fn read_output(mut reader: impl Read) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    let mut buffer = [0; 8192];
    let mut overflow = false;
    loop {
        let n = reader.read(&mut buffer).map_err(|_| "无法读取维护结果")?;
        if n == 0 {
            break;
        }
        if output.len() + n > 64 * 1024 {
            overflow = true;
        } else if !overflow {
            output.extend_from_slice(&buffer[..n]);
        }
    }
    if overflow {
        Err("维护输出超出显示上限。请重启检查结果；已确认的清空会继续处理。".into())
    } else {
        Ok(output)
    }
}
#[tauri::command]
pub fn maintenance_restart(view: Webview, app: tauri::AppHandle) -> Result<(), String> {
    main_only(&view)?;
    app.restart();
}
#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn oversized_helper_output_is_drained_while_child_is_running() {
        let shell = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let mut command = std::process::Command::new(shell);
        command
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[Console]::Out.Write('x' * 262144)",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
        let mut child = workpilot_platform::process::spawn_command(&mut command).unwrap();
        let output = child.stdout.take().unwrap();
        let reader = std::thread::spawn(move || read_output(output));
        let deadline = Instant::now() + Duration::from_secs(10);
        while child.try_wait().unwrap().is_none() {
            if Instant::now() > deadline {
                let _ = child.kill();
                panic!("child blocked on a full output pipe");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(reader.join().unwrap().unwrap_err().contains("超出"));
    }
}
