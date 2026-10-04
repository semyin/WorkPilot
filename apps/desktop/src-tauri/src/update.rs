use crate::{Bridge, main_only};
use std::{
    path::PathBuf,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::{State, Webview};
use workpilot_contracts::{Command, Query, Request, Response, WorkspaceData, WorkspaceQuery};
use workpilot_platform::update::{self, Prepared, Preview};
#[derive(Default)]
pub struct Updates {
    busy: AtomicBool,
    prepared: Mutex<Option<Prepared>>,
}
struct Busy<'a>(&'a AtomicBool);
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
fn begin(state: &Updates) -> Result<Busy<'_>, String> {
    if state.busy.swap(true, Ordering::AcqRel) {
        return Err("另一更新操作仍在进行。".into());
    }
    Ok(Busy(&state.busy))
}
pub fn directory() -> Result<PathBuf, String> {
    let executable = std::env::current_exe().map_err(|_| "无法定位当前安装。")?;
    executable
        .parent()
        .ok_or_else(|| "无法定位当前安装。".into())
        .and_then(|p| p.canonicalize().map_err(|_| "无法定位当前安装。".into()))
}
#[tauri::command]
pub async fn update_inspect(
    view: Webview,
    state: State<'_, Updates>,
    source: String,
) -> Result<Preview, String> {
    main_only(&view)?;
    let _busy = begin(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        update::inspect_source(&source, env!("CARGO_PKG_VERSION"))
    })
    .await
    .map_err(|_| "更新检查被中断。")?
}
#[tauri::command]
pub async fn update_prepare(
    view: Webview,
    state: State<'_, Updates>,
    bridge: State<'_, Bridge>,
    source: String,
    fingerprint: String,
) -> Result<serde_json::Value, String> {
    main_only(&view)?;
    let _busy = begin(&state)?;
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
        return Err("无法核对当前使用的数据目录。".into());
    };
    let WorkspaceData::Overview { data_dir, .. } = *data else {
        return Err("无法核对当前使用的数据目录。".into());
    };
    let install = directory()?;
    let (prepared, recovery) = tauri::async_runtime::spawn_blocking(move || {
        let prepared = update::prepare(
            &install,
            &PathBuf::from(data_dir),
            &source,
            env!("CARGO_PKG_VERSION"),
            &fingerprint,
        )?;
        let recovery = update::create_recovery_entry(&prepared)?;
        Ok::<_, String>((prepared, recovery))
    })
    .await
    .map_err(|_| "更新准备被中断。")??;
    let mut preview = serde_json::to_value(&prepared.preview).map_err(|_| "无法读取更新预览。")?;
    preview["recovery"] = serde_json::json!({
        "executable": update::display_recovery_path(&recovery.executable),
        "instructions": update::display_recovery_path(&recovery.instructions),
    });
    *state.prepared.lock().map_err(|_| "更新状态不可用。")? = Some(prepared);
    Ok(preview)
}
#[tauri::command]
pub fn update_install(
    view: Webview,
    app: tauri::AppHandle,
    state: State<'_, Updates>,
    bridge: State<'_, Bridge>,
    fingerprint: String,
    confirmed: bool,
) -> Result<(), String> {
    main_only(&view)?;
    let _busy = begin(&state)?;
    if !confirmed {
        return Err("安装更新必须先明确确认停止任务并退出。".into());
    }
    let prepared = state
        .prepared
        .lock()
        .map_err(|_| "更新状态不可用。")?
        .take()
        .ok_or("请先准备已核验的更新。")?;
    if prepared.preview.fingerprint != fingerprint {
        return Err("确认的更新已变化，请重新准备。".into());
    }
    let recovery = update::validate_recovery_entry(&prepared)?;
    let mut command = std::process::Command::new(&recovery.executable);
    command
        .arg("--apply")
        .arg(prepared.job.join("prepared.json"))
        .arg("--wait")
        .arg(std::process::id().to_string());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    workpilot_platform::process::spawn_command(&mut command)
        .map_err(|_| "无法启动更新助手；程序继续运行。")?;
    bridge.shutdown(); // Stops new schedule claims and every managed task/process before the backup.
    app.exit(0);
    Ok(())
}
#[tauri::command]
pub fn update_open_recovery_folder(view: Webview, state: State<'_, Updates>) -> Result<(), String> {
    main_only(&view)?;
    let prepared = state.prepared.lock().map_err(|_| "更新状态不可用。")?;
    let entry = update::validate_recovery_entry(prepared.as_ref().ok_or("请先准备更新。")?)?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let windows = std::env::var_os("SystemRoot").ok_or("无法定位 Windows 文件管理器。")?;
        std::process::Command::new(PathBuf::from(windows).join("explorer.exe"))
            .arg(update::display_recovery_path(
                entry.executable.parent().ok_or("恢复入口位置无效。")?,
            ))
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|_| "无法打开恢复工具所在文件夹。")?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = entry;
        Err("本版恢复入口仅支持 Windows。".into())
    }
}
#[tauri::command]
pub fn update_status(view: Webview) -> Result<serde_json::Value, String> {
    main_only(&view)?;
    let result = update::recover_for_install(&directory()?)?;
    Ok(
        serde_json::json!({"current_version":env!("CARGO_PKG_VERSION"),"last_update":result,"supported":cfg!(windows)}),
    )
}
#[tauri::command]
pub async fn pick_update_package(
    view: Webview,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    crate::pick_transfer_archive(view, app, false, "wpupdate", "WorkPilot.wpupdate").await
}
async fn active_data(bridge: &Bridge) -> Result<PathBuf, String> {
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
        return Err("无法核对当前数据目录。".into());
    };
    let WorkspaceData::Overview { data_dir, .. } = *data else {
        return Err("无法核对当前数据目录。".into());
    };
    Ok(PathBuf::from(data_dir))
}
#[tauri::command]
pub async fn update_backups_preview(
    view: Webview,
    state: State<'_, Updates>,
    bridge: State<'_, Bridge>,
) -> Result<update::BackupCleanupPreview, String> {
    main_only(&view)?;
    let _busy = begin(&state)?;
    let data = active_data(&bridge).await?;
    let install = directory()?;
    tauri::async_runtime::spawn_blocking(move || update::preview_backups(&install, &data))
        .await
        .map_err(|_| "恢复副本预览被中断。")?
}
#[tauri::command]
pub async fn update_backups_delete(
    view: Webview,
    state: State<'_, Updates>,
    bridge: State<'_, Bridge>,
    fingerprint: String,
    confirmation: String,
) -> Result<update::BackupCleanupPreview, String> {
    main_only(&view)?;
    let _busy = begin(&state)?;
    if confirmation != "DELETE" {
        return Err("请输入 DELETE 明确确认永久删除恢复副本。".into());
    }
    let data = active_data(&bridge).await?;
    let install = directory()?;
    bridge.shutdown();
    tauri::async_runtime::spawn_blocking(move || {
        update::delete_backups(&install, &data, &fingerprint, &confirmation)
    })
    .await
    .map_err(|_| "恢复副本清理被中断，请重新打开后检查。")?
}
