#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::{HashMap, VecDeque},
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::Command as ProcessCommand,
    sync::{Arc, Mutex},
};
use tauri::{
    LogicalPosition, LogicalSize, Manager, State, Webview, WebviewUrl,
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    webview::WebviewBuilder,
};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;
use workpilot_contracts::{Command, Event, Query, Request, Response, Snapshot, Wire};
use workpilot_platform::process::ManagedEngine;

#[derive(Default)]
struct History {
    events: VecDeque<Event>,
    alive: bool,
    error: Option<String>,
}
struct Bridge {
    engine: Mutex<Option<ManagedEngine>>,
    history: Arc<Mutex<History>>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Response>>>>,
}
struct TrayLabels {
    open: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
}
#[tauri::command]
async fn pick_project_folder(
    view: Webview,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    main_only(&view)?;
    let (sender, receiver) = oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = sender.send(path);
    });
    let path = receiver.await.map_err(|_| "Folder dialog was closed")?;
    path.map(|p| {
        p.into_path()
            .map(|p| p.to_string_lossy().into_owned())
            .map_err(|e| e.to_string())
    })
    .transpose()
}
#[tauri::command]
async fn pick_history_archive(
    view: Webview,
    app: tauri::AppHandle,
    save: bool,
) -> Result<Option<String>, String> {
    pick_transfer_archive(view, app, save, "wphistory", "WorkPilot-history.wphistory").await
}
#[tauri::command]
async fn pick_settings_archive(
    view: Webview,
    app: tauri::AppHandle,
    save: bool,
) -> Result<Option<String>, String> {
    pick_transfer_archive(
        view,
        app,
        save,
        "wpsettings",
        "WorkPilot-project.wpsettings",
    )
    .await
}
#[tauri::command]
async fn pick_extension_archive(
    view: Webview,
    app: tauri::AppHandle,
    save: bool,
) -> Result<Option<String>, String> {
    pick_transfer_archive(
        view,
        app,
        save,
        "wpextensions",
        "WorkPilot-extensions.wpextensions",
    )
    .await
}
async fn pick_transfer_archive(
    view: Webview,
    app: tauri::AppHandle,
    save: bool,
    extension: &'static str,
    filename: &'static str,
) -> Result<Option<String>, String> {
    main_only(&view)?;
    let (sender, receiver) = oneshot::channel();
    let dialog = app
        .dialog()
        .file()
        .add_filter("WorkPilot backup", &[extension]);
    if save {
        dialog.set_file_name(filename).save_file(move |path| {
            let _ = sender.send(path);
        });
    } else {
        dialog.pick_file(move |path| {
            let _ = sender.send(path);
        });
    }
    let path = receiver.await.map_err(|_| "Archive dialog closed")?;
    path.map(|p| {
        p.into_path()
            .map(|p| p.to_string_lossy().into_owned())
            .map_err(|e| e.to_string())
    })
    .transpose()
}
#[tauri::command]
fn set_desktop_locale(
    view: Webview,
    labels: State<'_, TrayLabels>,
    language: String,
) -> Result<(), String> {
    main_only(&view)?;
    labels
        .open
        .set_text(if language == "en" {
            "Open WorkPilot"
        } else {
            "打开 WorkPilot"
        })
        .map_err(|e| e.to_string())?;
    labels
        .quit
        .set_text(if language == "en" {
            "Quit WorkPilot"
        } else {
            "彻底退出 WorkPilot"
        })
        .map_err(|e| e.to_string())
}
impl Bridge {
    fn start() -> Result<Self, Box<dyn std::error::Error>> {
        let executable = std::env::current_exe()?;
        let engine_path = executable
            .parent()
            .ok_or("application path has no parent")?
            .join(if cfg!(windows) {
                "workpilot-sidecar.exe"
            } else {
                "workpilot-sidecar"
            });
        if !engine_path.is_file() {
            return Err(format!("Engine missing: {}", engine_path.display()).into());
        }
        let mut command = ProcessCommand::new(&engine_path);
        if let Some(root) = std::env::var_os("WORKPILOT_DATA_DIR") {
            command.arg("--data-root").arg(PathBuf::from(root));
        }
        if let Ok(channel) = std::env::var("WORKPILOT_CHANNEL") {
            command.args(["--channel", &channel]);
        }
        let mut engine = ManagedEngine::spawn(&mut command)?;
        let output = engine
            .child
            .stdout
            .take()
            .ok_or("engine stdout unavailable")?;
        let history = Arc::new(Mutex::new(History {
            alive: true,
            ..Default::default()
        }));
        let target = history.clone();
        let pending = Arc::new(Mutex::new(
            HashMap::<String, oneshot::Sender<Response>>::new(),
        ));
        let replies = pending.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let event = line.map_err(|e| e.to_string()).and_then(|line| {
                    serde_json::from_str::<Wire>(&line)
                        .map_err(|_| "Invalid engine frame".to_owned())
                });
                let mut state = target.lock().unwrap_or_else(|e| e.into_inner());
                match event {
                    Ok(Wire::Event { event }) => {
                        state.events.push_back(*event);
                        if state.events.len() > 512 {
                            state.events.pop_front();
                        }
                    }
                    Ok(Wire::Reply {
                        request_id,
                        response,
                    }) => {
                        if let Some(sender) = replies
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .remove(&request_id)
                        {
                            let _ = sender.send(response);
                        }
                    }
                    Err(error) => {
                        state.error = Some(error);
                    }
                }
            }
            target.lock().unwrap_or_else(|e| e.into_inner()).alive = false;
            replies.lock().unwrap_or_else(|e| e.into_inner()).clear();
        });
        Ok(Self {
            engine: Mutex::new(Some(engine)),
            history,
            pending,
        })
    }
    async fn request(&self, request: Request) -> Result<Response, String> {
        request.validate().map_err(str::to_owned)?;
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.pending.lock().map_err(|e| e.to_string())?;
            if pending.len() >= 64 || pending.contains_key(&request.request_id) {
                return Err("Too many pending requests".into());
            }
            pending.insert(request.request_id.clone(), sender);
        }
        if let Err(error) = self.send(&request) {
            self.pending
                .lock()
                .map_err(|e| e.to_string())?
                .remove(&request.request_id);
            return Err(error);
        }
        let seconds = if matches!(
            &request.command,
            Command::Media { .. }
                | Command::HistoryTransfer { .. }
                | Command::ProjectTransfer { .. }
                | Command::ExtensionTransfer { .. }
                | Command::InspectInstallation { .. }
                | Command::Workbench {
                    action: workpilot_contracts::WorkbenchAction::ReadDocument { .. },
                    ..
                }
        ) {
            120
        } else if matches!(
            &request.command,
            Command::Workspace {
                action: workpilot_contracts::WorkspaceAction::ExportRecords { .. }
            }
        ) {
            180
        } else {
            20
        };
        let reply = tokio::time::timeout(std::time::Duration::from_secs(seconds), receiver).await;
        self.pending
            .lock()
            .map_err(|e| e.to_string())?
            .remove(&request.request_id);
        match reply {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(_)) => {
                Err("Engine connection closed; saved commands will not be resubmitted".into())
            }
            Err(_) => {
                Err("Engine response timed out; check the saved command before retrying".into())
            }
        }
    }
    fn send(&self, request: &Request) -> Result<(), String> {
        request.validate().map_err(str::to_owned)?;
        if serde_json::to_vec(request)
            .map_err(|_| "Invalid request")?
            .len()
            > workpilot_contracts::MAX_COMMAND_BYTES
        {
            return Err("Request exceeds the supported size".into());
        }
        let mut guard = self.engine.lock().map_err(|e| e.to_string())?;
        let engine = guard.as_mut().ok_or("Engine is stopped")?;
        let input = engine
            .child
            .stdin
            .as_mut()
            .ok_or("Engine input is closed")?;
        let json = serde_json::to_vec(request).map_err(|e| e.to_string())?;
        input
            .write_all(&json)
            .and_then(|_| input.write_all(b"\n"))
            .and_then(|_| input.flush())
            .map_err(|e| e.to_string())
    }
    fn shutdown(&self) {
        let _ = self.send(&Request {
            request_id: "host-shutdown".into(),
            command: Command::Shutdown,
        });
        if let Ok(mut guard) = self.engine.lock()
            && let Some(mut engine) = guard.take()
        {
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(1500);
            while std::time::Instant::now() < deadline {
                if matches!(engine.child.try_wait(), Ok(Some(_))) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            // Drop kills any surviving descendants even if the engine already exited.
        }
    }
}
fn main_only(view: &Webview) -> Result<(), String> {
    if view.label() == "main" {
        Ok(())
    } else {
        Err("Only the main application view can control WorkPilot".into())
    }
}

#[tauri::command]
fn browser_extension_folder(view: Webview) -> Result<(), String> {
    main_only(&view)?;
    let folder =
        workpilot_platform::browser_setup::extension_directory().map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let windows = std::env::var_os("SystemRoot").ok_or("Windows directory is unavailable")?;
        ProcessCommand::new(std::path::PathBuf::from(windows).join("explorer.exe"))
            .arg(folder)
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        let _ = folder;
        return Err("Browser setup is not implemented on this platform".into());
    }
    #[cfg(windows)]
    Ok(())
}
#[tauri::command]
fn extension_open_login(view: Webview, url: String) -> Result<(), String> {
    main_only(&view)?;
    let parsed = tauri::Url::parse(&url).map_err(|_| "无效登录地址。")?;
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || url.len() > 16384
        || !(parsed.scheme() == "https"
            || (parsed.scheme() == "http"
                && matches!(parsed.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))))
    {
        return Err("登录页面必须使用 HTTPS 或本机测试地址。".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        ProcessCommand::new("explorer.exe")
            .arg(parsed.as_str())
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|_| "无法打开默认浏览器。")?;
    }
    #[cfg(target_os = "macos")]
    {
        ProcessCommand::new("/usr/bin/open")
            .arg("--")
            .arg(parsed.as_str())
            .spawn()
            .map_err(|_| "无法打开默认浏览器。")?;
    }
    #[cfg(target_os = "linux")]
    {
        ProcessCommand::new("xdg-open")
            .arg(parsed.as_str())
            .spawn()
            .map_err(|_| "无法打开默认浏览器。")?;
    }
    Ok(())
}
#[tauri::command]
async fn project_open_external(
    view: Webview,
    bridge: State<'_, Bridge>,
    task_id: String,
    path: String,
    folder: bool,
) -> Result<(), String> {
    main_only(&view)?;
    let response = bridge
        .request(Request {
            request_id: uuid::Uuid::new_v4().to_string(),
            command: Command::Workbench {
                task_id,
                action: workpilot_contracts::WorkbenchAction::ResolvePath { path },
            },
        })
        .await?;
    let Response::Workbench { data } = response else {
        return Err("无法核对要打开的项目路径。".into());
    };
    let target = PathBuf::from(data["path"].as_str().ok_or("项目路径不可用。")?);
    let target = if folder && target.is_file() {
        target.parent().ok_or("没有父目录。")?.to_path_buf()
    } else {
        target
    };
    if !target.is_absolute() {
        return Err("项目路径必须是绝对路径。".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        ProcessCommand::new("explorer.exe")
            .arg(target)
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        ProcessCommand::new("/usr/bin/open")
            .arg("--")
            .arg(target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        ProcessCommand::new("xdg-open")
            .arg(target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[tauri::command]
async fn project_preview_open(
    view: Webview,
    app: tauri::AppHandle,
    bridge: State<'_, Bridge>,
    task_id: String,
    operation_id: String,
) -> Result<(), String> {
    main_only(&view)?;
    let response = bridge
        .request(Request {
            request_id: uuid::Uuid::new_v4().to_string(),
            command: Command::Workbench {
                task_id,
                action: workpilot_contracts::WorkbenchAction::Preview { operation_id },
            },
        })
        .await?;
    let data = match response {
        Response::Workbench { data } => data,
        Response::Error { message, .. } => return Err(message),
        _ => return Err("预览验证失败。".into()),
    };
    let url: tauri::Url = data["url"]
        .as_str()
        .ok_or("预览地址不可用。")?
        .parse()
        .map_err(|_| "预览地址格式不正确。")?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") {
        return Err("只允许本任务的本机预览服务。".into());
    }
    let port = url.port();
    if let Some(window) = app.get_webview_window("project-preview") {
        window.close().map_err(|e| e.to_string())?;
    }
    tauri::WebviewWindowBuilder::new(&app, "project-preview", WebviewUrl::External(url))
        .title("WorkPilot · Project preview")
        .inner_size(1000.0, 720.0)
        .on_navigation(move |url| {
            url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == port
        })
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
fn project_preview_close(view: Webview, app: tauri::AppHandle) -> Result<(), String> {
    main_only(&view)?;
    if let Some(window) = app.get_webview_window("project-preview") {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn engine_snapshot(
    view: Webview,
    bridge: State<'_, Bridge>,
    after: u64,
) -> Result<Snapshot, String> {
    main_only(&view)?;
    let (alive, error) = {
        let state = bridge.history.lock().map_err(|e| e.to_string())?;
        (state.alive, state.error.clone())
    };
    if !alive {
        return Ok(Snapshot {
            events: vec![],
            alive,
            error,
            next_after: after,
            has_more: false,
            history_truncated: false,
        });
    }
    let response = bridge
        .request(Request {
            request_id: uuid::Uuid::new_v4().to_string(),
            command: Command::Read {
                query: Query::Events {
                    after,
                    task_id: None,
                    limit: 256,
                },
            },
        })
        .await?;
    match response {
        Response::Events { page } => Ok(Snapshot {
            events: page.events,
            alive,
            error,
            next_after: page.next_after,
            has_more: page.has_more,
            history_truncated: false,
        }),
        Response::Error { message, .. } => Err(message),
        _ => Err("Unexpected engine response".into()),
    }
}
#[tauri::command]
async fn engine_command(
    view: Webview,
    bridge: State<'_, Bridge>,
    request: Request,
) -> Result<Response, String> {
    main_only(&view)?;
    if matches!(request.command, Command::Shutdown) {
        return Err("Use the application exit action".into());
    }
    bridge.request(request).await
}
#[tauri::command]
fn hide_window(view: Webview, app: tauri::AppHandle) -> Result<(), String> {
    main_only(&view)?;
    app.get_window("main")
        .ok_or("main window missing")?
        .hide()
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn show_window(view: Webview, app: tauri::AppHandle) -> Result<(), String> {
    main_only(&view)?;
    show_main(&app);
    Ok(())
}
#[tauri::command]
fn exit_app(view: Webview, app: tauri::AppHandle) -> Result<(), String> {
    main_only(&view)?;
    app.exit(0);
    Ok(())
}
#[tauri::command]
fn preview_close(view: Webview, app: tauri::AppHandle) -> Result<(), String> {
    main_only(&view)?;
    if let Some(preview) = app.get_webview("browser-preview") {
        preview.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[tauri::command]
async fn preview_open(
    view: Webview,
    app: tauri::AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    main_only(&view)?;
    if ![x, y, width, height]
        .iter()
        .all(|v| v.is_finite() && *v >= 0.0 && *v < 10_000.0)
        || width < 50.0
        || height < 50.0
    {
        return Err("Invalid preview bounds".into());
    }
    if let Some(preview) = app.get_webview("browser-preview") {
        preview
            .set_position(LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        preview
            .set_size(LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    let window = app.get_window("main").ok_or("main window missing")?;
    // Fixed P00 presentation probe, not a general browser tool. No remote IPC.
    let builder = WebviewBuilder::new(
        "browser-preview",
        WebviewUrl::External("https://example.com".parse().unwrap()),
    )
    .on_navigation(|url| url.scheme() == "https" && url.host_str() == Some("example.com"));
    window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width, height),
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}
fn show_main(app: &tauri::AppHandle) {
    // Once a child webview exists, this is a multi-webview Window rather
    // than a single WebviewWindow. Always address the owning window.
    if let Some(window) = app.get_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}
fn main() {
    let bridge = match Bridge::start() {
        Ok(bridge) => bridge,
        Err(error) => {
            let message = error.to_string();
            eprintln!("{message}");
            Bridge {
                engine: Mutex::new(None),
                pending: Arc::new(Mutex::new(HashMap::new())),
                history: Arc::new(Mutex::new(History {
                    error: Some(message),
                    ..Default::default()
                })),
            }
        }
    };
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(bridge)
        .invoke_handler(tauri::generate_handler![
            engine_snapshot,
            engine_command,
            pick_history_archive,
            pick_extension_archive,
            pick_settings_archive,
            project_open_external,
            extension_open_login,
            browser_extension_folder,
            project_preview_open,
            project_preview_close,
            hide_window,
            exit_app,
            show_window,
            preview_open,
            preview_close,
            pick_project_folder,
            set_desktop_locale
        ])
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "打开 / Open WorkPilot", true, None::<&str>)?;
            let quit =
                MenuItem::with_id(app, "quit", "彻底退出 / Quit WorkPilot", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            app.manage(TrayLabels { open, quit });
            TrayIconBuilder::with_id("workpilot")
                .icon(
                    app.default_window_icon()
                        .ok_or("application icon missing")?
                        .clone(),
                )
                .tooltip("WorkPilot")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(event, TrayIconEvent::DoubleClick { .. }) {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main"
                && let tauri::WindowEvent::CloseRequested { api, .. } = event
            {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build WorkPilot desktop");
    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            app.state::<Bridge>().shutdown();
        }
    });
}
