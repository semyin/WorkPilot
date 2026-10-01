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
impl Bridge {
    fn start() -> Result<Self, Box<dyn std::error::Error>> {
        let executable = std::env::current_exe()?;
        let engine_path = executable
            .parent()
            .ok_or("application path has no parent")?
            .join(if cfg!(windows) {
                "workpilot-engine.exe"
            } else {
                "workpilot-engine"
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
        let reply = tokio::time::timeout(std::time::Duration::from_secs(20), receiver).await;
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
        .manage(bridge)
        .invoke_handler(tauri::generate_handler![
            engine_snapshot,
            engine_command,
            hide_window,
            exit_app,
            show_window,
            preview_open,
            preview_close
        ])
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "打开 / Open WorkPilot", true, None::<&str>)?;
            let quit =
                MenuItem::with_id(app, "quit", "彻底退出 / Quit WorkPilot", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
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
