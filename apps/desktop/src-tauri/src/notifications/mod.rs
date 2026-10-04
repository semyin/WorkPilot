mod model;
mod persistence;
mod system;
#[cfg(test)]
mod tests;

use model::{Delivery, Ledger, Notice, Preferences};
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State, Webview};
use workpilot_contracts::{
    Command, Event, Payload, Query, Request, Response, WorkspaceData, WorkspaceQuery,
};

enum Signal {
    Ready(PathBuf, u64),
    Notice(Notice),
    Stop,
}
#[derive(Default)]
struct Data {
    ledger: Ledger,
    directory: Option<PathBuf>,
    data_lock: Option<std::fs::File>,
    active: bool,
    ready: bool,
    storage_error: bool,
    app: Option<AppHandle>,
    english: bool,
    open: Option<OpenRequest>,
    last_sent: Option<Instant>,
    last_delivery: Option<Delivery>,
}
struct Inner {
    data: Mutex<Data>,
    sender: mpsc::SyncSender<Signal>,
    worker: Mutex<Option<JoinHandle<()>>>,
    focused: AtomicBool,
    overflow: AtomicBool,
}
#[derive(Clone)]
pub struct Notifications(Arc<Inner>);
#[derive(Clone, Serialize)]
pub struct OpenRequest {
    token: String,
    id: Option<String>,
}
#[derive(Serialize)]
pub struct NotificationSnapshot {
    preferences: Preferences,
    entries: Vec<Notice>,
    unread: usize,
    ready: bool,
    active: bool,
    storage_error: bool,
    overflow: bool,
    system_available: bool,
    last_delivery: Option<Delivery>,
    open: Option<OpenRequest>,
}
#[derive(Serialize)]
pub struct Navigation {
    task_id: String,
    project_id: Option<String>,
}

impl Notifications {
    pub fn new() -> Self {
        // Filtered state transitions only, never tokens, content or request bodies.
        let (sender, receiver) = mpsc::sync_channel(512);
        let inner = Arc::new(Inner {
            data: Mutex::new(Data {
                active: true,
                ..Default::default()
            }),
            sender,
            worker: Mutex::new(None),
            focused: AtomicBool::new(true),
            overflow: AtomicBool::new(false),
        });
        let weak = Arc::downgrade(&inner);
        let worker = std::thread::spawn(move || {
            while let Ok(signal) = receiver.recv() {
                let Some(inner) = weak.upgrade() else {
                    break;
                };
                if matches!(signal, Signal::Stop) {
                    break;
                }
                Self(inner).receive(signal);
            }
        });
        *inner.worker.lock().unwrap_or_else(|e| e.into_inner()) = Some(worker);
        Self(inner)
    }
    pub fn event(&self, event: &Event) {
        let signal = if let Payload::Ready { data_dir, .. } = &event.payload {
            Some(Signal::Ready(PathBuf::from(data_dir), event.sequence))
        } else {
            Notice::from_event(event).map(Signal::Notice)
        };
        if let Some(signal) = signal
            && matches!(
                self.0.sender.try_send(signal),
                Err(mpsc::TrySendError::Full(_))
            )
        {
            self.0.overflow.store(true, Ordering::Relaxed);
        }
    }
    fn receive(&self, signal: Signal) {
        let mut data = self.0.data.lock().unwrap_or_else(|e| e.into_inner());
        if !data.active {
            return;
        }
        match signal {
            Signal::Ready(root, sequence) => {
                if data.ready {
                    return;
                }
                match workpilot_platform::update::data_update_lock(&root, false).and_then(|lock| {
                    persistence::directory(&root)
                        .and_then(|dir| persistence::load(&dir).map(|saved| (lock, dir, saved)))
                }) {
                    Ok((lock, dir, mut saved)) => {
                        for entry in &mut saved.entries {
                            if entry.delivery == Delivery::Pending {
                                entry.delivery = Delivery::Startup;
                            }
                        }
                        data.data_lock = Some(lock);
                        data.directory = Some(dir);
                        data.ledger.saved = saved;
                    }
                    Err(_) => data.storage_error = true,
                }
                // Anything committed before this engine startup is historical. Loaded
                // unread entries stay visible but never trigger a new OS notification.
                data.ledger.floor = sequence;
                data.ready = true;
                drop(data);
                self.render();
            }
            Signal::Notice(mut notice) => {
                if !data.ready {
                    return;
                }
                notice.delivery = model::policy(
                    &data.ledger.saved.preferences,
                    self.0.focused.load(Ordering::Relaxed),
                    data.app.is_some(),
                    data.last_sent
                        .is_some_and(|at| at.elapsed() < Duration::from_secs(2)),
                );
                let (id, kind, delivery) = (notice.id.clone(), notice.kind, notice.delivery);
                if !data.ledger.insert(notice) {
                    return;
                }
                // Record receipt before dispatch: failures never cause automatic retries.
                persist(&mut data);
                let app = data.app.clone();
                let english = data.english;
                drop(data);
                if delivery == Delivery::Pending
                    && let Some(app) = app
                {
                    let delivery = system::show(&app, Some(id.clone()), Some(kind), english);
                    let mut data = self.0.data.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(entry) = data.ledger.saved.entries.iter_mut().find(|n| n.id == id) {
                        entry.delivery = delivery;
                    }
                    data.last_delivery = Some(delivery);
                    data.last_sent = Some(Instant::now());
                    if data.active {
                        persist(&mut data);
                    }
                }
                self.render();
            }
            Signal::Stop => {}
        }
    }
    pub fn attach(&self, app: &AppHandle) {
        self.0.data.lock().unwrap_or_else(|e| e.into_inner()).app = Some(app.clone());
        self.render();
    }
    pub fn focus(&self, focused: bool) {
        self.0.focused.store(focused, Ordering::Relaxed);
    }
    pub fn locale(&self, english: bool) {
        self.0
            .data
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .english = english;
        self.render();
    }
    pub fn suspend(&self) {
        {
            let mut data = self.0.data.lock().unwrap_or_else(|e| e.into_inner());
            data.active = false;
            data.data_lock.take();
        }
        let _ = self.0.sender.send(Signal::Stop);
        if let Some(worker) = self
            .0
            .worker
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            let _ = worker.join();
        }
        self.render();
    }
    fn snapshot(&self) -> NotificationSnapshot {
        let data = self.0.data.lock().unwrap_or_else(|e| e.into_inner());
        NotificationSnapshot {
            preferences: data.ledger.saved.preferences.clone(),
            entries: data.ledger.saved.entries.iter().cloned().collect(),
            unread: data.ledger.saved.unread(),
            ready: data.ready,
            active: data.active,
            storage_error: data.storage_error,
            overflow: self.0.overflow.load(Ordering::Relaxed),
            system_available: system::available(),
            last_delivery: data.last_delivery,
            open: data.open.clone(),
        }
    }
    fn render(&self) {
        let data = self.0.data.lock().unwrap_or_else(|e| e.into_inner());
        let Some(app) = data.app.clone() else {
            return;
        };
        let count = if data.ledger.saved.preferences.tray {
            data.ledger.saved.unread()
        } else {
            0
        };
        let english = data.english;
        drop(data);
        let target = app.clone();
        // Never wait on the GUI thread from the engine reader / shutdown path.
        let _ = app.run_on_main_thread(move || {
            if let Some(labels) = target.try_state::<crate::TrayLabels>() {
                let text = if english {
                    format!("Notifications ({count})")
                } else {
                    format!("通知（{count}）")
                };
                let _ = labels.notifications.set_text(text);
            }
            if let Some(tray) = target.tray_by_id("workpilot") {
                let tooltip = if count == 0 {
                    "WorkPilot".into()
                } else if english {
                    format!("WorkPilot · {count} unread notifications")
                } else {
                    format!("WorkPilot · {count} 条未读通知")
                };
                let _ = tray.set_tooltip(Some(tooltip));
                if let Some(icon) = target.default_window_icon() {
                    let mut rgba = icon.rgba().to_vec();
                    let (width, height) = (icon.width(), icon.height());
                    if count > 0 {
                        let radius = (width.min(height) / 5).max(1) as i64;
                        for y in 0..height {
                            for x in 0..width {
                                let dx = x as i64 - (width as i64 - radius - 1);
                                let dy = y as i64 - radius;
                                if dx * dx + dy * dy <= radius * radius {
                                    let at = ((y * width + x) * 4) as usize;
                                    rgba[at..at + 4].copy_from_slice(&[233, 68, 68, 255]);
                                }
                            }
                        }
                    }
                    let _ =
                        tray.set_icon(Some(tauri::image::Image::new_owned(rgba, width, height)));
                }
            }
            let _ = target.emit_to("main", "workpilot-notifications", ());
        });
    }
}
fn persist(data: &mut Data) {
    if let Some(directory) = &data.directory {
        data.storage_error = persistence::save(directory, &data.ledger.saved).is_err();
    }
}
pub fn activate(app: &AppHandle, id: Option<String>) {
    if let Some(notifications) = app.try_state::<Notifications>() {
        let mut data = notifications
            .0
            .data
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // Activation carries only a previously issued local entry ID, never a path/command.
        let id = id.filter(|id| {
            data.ledger
                .saved
                .entries
                .iter()
                .any(|entry| &entry.id == id)
        });
        data.open = Some(OpenRequest {
            token: uuid::Uuid::new_v4().to_string(),
            id,
        });
        drop(data);
        notifications.render();
    }
    crate::show_main(app);
}
#[tauri::command]
pub fn notifications_snapshot(
    view: Webview,
    state: State<'_, Notifications>,
) -> Result<NotificationSnapshot, String> {
    crate::main_only(&view)?;
    Ok(state.snapshot())
}
#[tauri::command]
pub async fn notifications_save(
    view: Webview,
    state: State<'_, Notifications>,
    preferences: Preferences,
) -> Result<(), String> {
    crate::main_only(&view)?;
    let mut data = state.0.data.lock().unwrap_or_else(|e| e.into_inner());
    if !data.active || !data.ready || data.directory.is_none() {
        return Err("通知设置当前无法保存 / Notification settings are unavailable".into());
    }
    let mut next = data.ledger.saved.clone();
    next.preferences = preferences;
    persistence::save(data.directory.as_ref().unwrap(), &next)
        .map_err(|_| "通知设置未能保存，原设置保留 / Could not save notification settings")?;
    data.ledger.saved = next;
    data.storage_error = false;
    drop(data);
    state.render();
    Ok(())
}
#[tauri::command]
pub async fn notifications_read(
    view: Webview,
    state: State<'_, Notifications>,
    id: Option<String>,
) -> Result<(), String> {
    crate::main_only(&view)?;
    let mut data = state.0.data.lock().unwrap_or_else(|e| e.into_inner());
    if !data.active {
        return Err("请重新打开软件后管理通知 / Restart before changing notifications".into());
    }
    for entry in &mut data.ledger.saved.entries {
        if id.as_ref().is_none_or(|id| id == &entry.id) {
            entry.read = true;
        }
    }
    persist(&mut data);
    drop(data);
    state.render();
    Ok(())
}
#[tauri::command]
pub fn notifications_take_open(
    view: Webview,
    state: State<'_, Notifications>,
) -> Result<Option<OpenRequest>, String> {
    crate::main_only(&view)?;
    Ok(state
        .0
        .data
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .open
        .take())
}
#[tauri::command]
pub async fn notifications_open(
    view: Webview,
    state: State<'_, Notifications>,
    bridge: State<'_, crate::Bridge>,
    id: String,
) -> Result<Navigation, String> {
    crate::main_only(&view)?;
    let task_id = {
        let data = state.0.data.lock().unwrap_or_else(|e| e.into_inner());
        if !data.active {
            return Err("任务暂不可打开，请先重启软件 / Restart to open the task".into());
        }
        data.ledger
            .saved
            .entries
            .iter()
            .find(|n| n.id == id)
            .map(|n| n.task_id.clone())
            .ok_or("通知已不在当前记录中 / Notification is no longer available")?
    };
    // Query this live sidecar's database. A stale/deleted task or a copied record
    // cannot start an execution, change permissions, or switch to another data root.
    let reply = bridge
        .request(Request {
            request_id: uuid::Uuid::new_v4().to_string(),
            command: Command::Read {
                query: Query::Workspace {
                    query: WorkspaceQuery::Detail {
                        task_id: task_id.clone(),
                    },
                },
            },
        })
        .await?;
    let Response::Workspace { data: workspace } = reply else {
        return Err(
            "任务已删除或暂时无法打开，请查看任务列表 / Task was deleted or is unavailable".into(),
        );
    };
    let WorkspaceData::Detail { snapshot, .. } = *workspace else {
        return Err("任务暂时无法打开 / Task is unavailable".into());
    };
    if snapshot.task.id != task_id {
        return Err("任务记录不匹配 / Task record mismatch".into());
    }
    let mut data = state.0.data.lock().unwrap_or_else(|e| e.into_inner());
    if !data.active {
        return Err("请先重启软件 / Restart before opening the task".into());
    }
    if let Some(entry) = data.ledger.saved.entries.iter_mut().find(|n| n.id == id) {
        entry.read = true;
    }
    persist(&mut data);
    drop(data);
    state.render();
    Ok(Navigation {
        task_id,
        project_id: snapshot.task.project_id,
    })
}
#[tauri::command]
pub async fn notifications_test(
    view: Webview,
    app: AppHandle,
    state: State<'_, Notifications>,
) -> Result<Delivery, String> {
    crate::main_only(&view)?;
    let english = {
        let data = state.0.data.lock().unwrap_or_else(|e| e.into_inner());
        if !data.active {
            return Err("请先重新打开软件 / Restart first".into());
        }
        data.english
    };
    let delivery =
        tauri::async_runtime::spawn_blocking(move || system::show(&app, None, None, english))
            .await
            .map_err(|_| "通知测试未能发送 / Notification test failed")?;
    state
        .0
        .data
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .last_delivery = Some(delivery);
    state.render();
    Ok(delivery)
}
