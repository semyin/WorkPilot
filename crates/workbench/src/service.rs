mod execution;
mod preparation;
mod requests;
use crate::{
    git,
    history::{self, Capture},
    vault::{Result, Vault},
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::{
    sync::{Notify, mpsc},
    task::JoinHandle,
};
use workpilot_contracts::*;
use workpilot_platform::tool_process::{self, ProcessProgress, ProcessSpec};
use workpilot_storage::Storage;
use workpilot_tools::{
    binary::{EXCLUDED, user_path},
    files::Root,
};

pub struct Service {
    state: Arc<State>,
    requests: Vec<JoinHandle<()>>,
}
#[derive(Clone)]
pub struct Client(Arc<State>);
impl Client {
    pub async fn media(&self, task: Option<String>, action: MediaAdmin) -> Result<Value> {
        self.0.media.admin(task, action).await
    }
    pub async fn media_context(
        &self,
        task: &str,
        delivered: &str,
        images: bool,
    ) -> Result<Vec<ModelContent>> {
        self.0.media.model_context(task, delivered, images).await
    }
    pub async fn media_assets(&self, task: &str, delivered: &str) -> Result<Vec<MediaAsset>> {
        self.0.media.model_assets(task, delivered).await
    }
    pub async fn extensions(&self, task: Option<String>, action: ExtensionAdmin) -> Result<Value> {
        let scope = self.0.extension_scope(task).await?;
        self.0.extensions.admin(scope, action).await
    }
    pub async fn extension_definitions(
        &self,
        task: &str,
        mode: WorkMode,
    ) -> Result<Vec<ToolDefinition>> {
        let scope = self.0.extension_scope(Some(task.into())).await?;
        self.0.extensions.definitions(scope.as_deref(), mode).await
    }
    pub async fn extension_input(
        &self,
        task: &str,
        name: &str,
        arguments: Value,
    ) -> Result<ExtensionEffect> {
        let scope = self.0.extension_scope(Some(task.into())).await?;
        self.0
            .extensions
            .resolve(scope.as_deref(), name, arguments)
            .await
    }
    pub async fn skill_draft(
        &self,
        task: &str,
        id: &str,
        project: bool,
        files: Vec<SkillDraftFile>,
    ) -> Result<Value> {
        let scope = self.0.extension_scope(Some(task.into())).await?;
        let scope = if project {
            Some(scope.ok_or("当前任务没有绑定项目文件夹。")?)
        } else {
            None
        };
        Ok(json!(self.0.extensions.draft(id, scope, files).await?))
    }
    pub async fn request(
        &self,
        task: String,
        id: String,
        action: WorkbenchAction,
    ) -> Result<Value> {
        let state = self.0.clone();
        let runtime = tokio::runtime::Handle::current();
        let browser_epoch = state.browser.epoch();
        tokio::task::spawn_blocking(move || {
            runtime.block_on(state.handle(&id, &task, action, browser_epoch))
        })
        .await
        .map_err(|e| e.to_string())?
    }
    pub async fn operation(&self, task: &str, id: &str) -> Result<WorkbenchOperation> {
        self.0.operation(id, task).await
    }
    pub async fn result(&self, operation: &WorkbenchOperation) -> Result<Value> {
        let reference = operation
            .output
            .as_ref()
            .ok_or("browser operation has no saved result")?;
        let mut text = String::new();
        let mut offset = 0;
        while offset < reference.bytes {
            let id = reference.object_id.clone();
            let response = self
                .0
                .storage
                .call(move |s| {
                    s.query(&Query::Content {
                        object_id: id,
                        offset,
                        limit: 65536,
                    })
                })
                .await
                .map_err(|e| e.to_string())?;
            let Response::Content { page } = response else {
                return Err("browser result unavailable".into());
            };
            offset = page.next_offset;
            text.push_str(&page.text);
            if text.len() > 8 * 1024 * 1024 {
                return Err("browser result exceeds limit".into());
            }
        }
        serde_json::from_str(&text).map_err(|e| e.to_string())
    }
    pub fn set_image(&self, task: &str, image: String) {
        self.0.images.lock().unwrap().insert(task.into(), image);
    }
    pub fn take_image(&self, task: &str) -> Option<String> {
        self.0.images.lock().unwrap().remove(task)
    }
}
struct State {
    transfer: crate::transfer::Manager,
    storage: Storage,
    data: PathBuf,
    out: mpsc::Sender<Wire>,
    live: Mutex<HashMap<String, Arc<Live>>>,
    jobs: Mutex<Vec<JoinHandle<()>>>,
    browser: crate::browser::BrowserDriver,
    extensions: workpilot_extensions::Manager,
    media: crate::media::Manager,
    images: Mutex<HashMap<String, String>>,
}
struct Live {
    task: String,
    ancestors: Vec<String>,
    stop: Arc<AtomicBool>,
    notify: Notify,
    view: Mutex<LiveView>,
}
#[derive(Default)]
struct LiveView {
    pid: Option<u32>,
    owned: Vec<u32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Prepared {
    action: WorkbenchAction,
    task: String,
    root_path: String,
    root_identity: String,
    epoch: String,
    scope: Value,
}
struct Context {
    root: Root,
    policy: ToolSettingsView,
    mode: WorkMode,
    ancestors: Vec<String>,
}
fn hash(value: &impl Serialize) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).map_err(|e| e.to_string())?)
    ))
}
fn error(message: impl ToString) -> Response {
    Response::Error {
        code: ErrorCode::InvalidRequest,
        message: message.to_string(),
    }
}
impl Service {
    pub async fn new(storage: Storage, data: PathBuf, out: mpsc::Sender<Wire>) -> Self {
        let service = Self {
            state: Arc::new(State {
                transfer: crate::transfer::Manager::new(storage.clone(), data.clone(), out.clone()),
                media: crate::media::Manager::new(storage.clone(), data.clone()),
                extensions: workpilot_extensions::Manager::new(storage.clone(), data.clone()),
                storage,
                browser: crate::browser::BrowserDriver::new(data.clone()),
                images: Mutex::new(HashMap::new()),
                data,
                out,
                live: Mutex::new(HashMap::new()),
                jobs: Mutex::new(vec![]),
            }),
            requests: vec![],
        };
        let state = service.state.clone();
        let runtime = tokio::runtime::Handle::current();
        let _ =
            tokio::task::spawn_blocking(move || runtime.block_on(state.recover_captures())).await;
        service
    }
    pub fn client(&self) -> Client {
        Client(self.state.clone())
    }
    pub fn dispatch(&mut self, request: &Request) -> bool {
        if matches!(
            &request.command,
            Command::HistoryTransfer { .. }
                | Command::FileTransfer { .. }
                | Command::MediaTransfer { .. }
                | Command::ProjectTransfer { .. }
                | Command::ExtensionTransfer { .. }
        ) {
            self.requests.retain(|j| !j.is_finished());
            let (state, id, command) = (
                self.state.clone(),
                request.request_id.clone(),
                request.command.clone(),
            );
            if self.requests.len() >= 8 {
                let _ = state.out.try_send(Wire::Reply {
                    request_id: id,
                    response: error("历史管理忙，请稍后重试 / History management is busy"),
                });
                return true;
            }
            let runtime = tokio::runtime::Handle::current();
            self.requests.push(tokio::task::spawn_blocking(move || {
                runtime.block_on(async move {
                    let result = match command {
                        Command::MediaTransfer { task_id, action } => {
                            state
                                .transfer
                                .handle_media(task_id, action, &state.media)
                                .await
                        }
                        Command::FileTransfer { task_id, action } => {
                            match state.transfer.handle_files(task_id.clone(), action).await {
                                Ok(crate::transfer::files::FileReply::Data(data)) => Ok(data),
                                Ok(crate::transfer::files::FileReply::Ready { id, action }) => {
                                    state
                                        .handle(&id, &task_id, action, state.browser.epoch())
                                        .await
                                }
                                Err(e) => Err(e),
                            }
                        }
                        Command::HistoryTransfer { task_id, action } => {
                            state.transfer.handle(task_id, action).await
                        }
                        Command::ProjectTransfer { action } => {
                            state.transfer.handle_project(action).await
                        }
                        Command::ExtensionTransfer { task_id, action } => {
                            state
                                .transfer
                                .handle_extensions(task_id, action, &state.extensions)
                                .await
                        }
                        _ => unreachable!(),
                    };
                    let response = match result {
                        Ok(data) => Response::Workbench { data },
                        Err(e) => error(e),
                    };
                    let _ = state
                        .out
                        .send(Wire::Reply {
                            request_id: id,
                            response,
                        })
                        .await;
                })
            }));
            return true;
        }
        match &request.command {
            Command::ConfigureToolDefaults { .. } => self.cancel_all(),
            Command::Cancel { task_id }
            | Command::ConfigureTaskTools { task_id, .. }
            | Command::ConfigureExecution { task_id, .. } => self.cancel_task(task_id),
            _ => {}
        }
        if let Command::Media { task_id, action } = &request.command {
            self.requests.retain(|j| !j.is_finished());
            let (state, id, task, action) = (
                self.state.clone(),
                request.request_id.clone(),
                task_id.clone(),
                action.clone(),
            );
            if self.requests.len() >= 8 {
                let _ = state.out.try_send(Wire::Reply {
                    request_id: id,
                    response: error("文件处理忙，请稍后重试 / File processing is busy"),
                });
                return true;
            }
            let runtime = tokio::runtime::Handle::current();
            self.requests.push(tokio::task::spawn_blocking(move || {
                runtime.block_on(async move {
                    let response = match state.media.admin(task, action).await {
                        Ok(data) => Response::Workbench { data },
                        Err(e) => error(e),
                    };
                    let _ = state
                        .out
                        .send(Wire::Reply {
                            request_id: id,
                            response,
                        })
                        .await;
                })
            }));
            return true;
        }
        if let Command::Extensions { task_id, action } = &request.command {
            self.requests.retain(|j| !j.is_finished());
            let (state, id, task, action) = (
                self.state.clone(),
                request.request_id.clone(),
                task_id.clone(),
                action.clone(),
            );
            if self.requests.len() >= 8 {
                let _ = state.out.try_send(Wire::Reply {
                    request_id: id,
                    response: error("扩展管理正在处理其他操作，请稍后重试。"),
                });
                return true;
            }
            let runtime = tokio::runtime::Handle::current();
            self.requests.push(tokio::task::spawn_blocking(move || {
                runtime.block_on(async move {
                    let result = async {
                        let scope = state.extension_scope(task).await?;
                        state.extensions.admin(scope, action).await
                    }
                    .await;
                    let response = match result {
                        Ok(data) => Response::Workbench { data },
                        Err(e) => error(e),
                    };
                    let _ = state
                        .out
                        .send(Wire::Reply {
                            request_id: id,
                            response,
                        })
                        .await;
                })
            }));
            return true;
        }
        let Command::Workbench { task_id, action } = &request.command else {
            return false;
        };
        self.requests.retain(|j| !j.is_finished());
        self.state.jobs.lock().unwrap().retain(|j| !j.is_finished());
        let (state, id, task, action) = (
            self.state.clone(),
            request.request_id.clone(),
            task_id.clone(),
            action.clone(),
        );
        if self.requests.len() >= 8 {
            let _ = state.out.try_send(Wire::Reply {
                request_id: id,
                response: Response::Error {
                    code: ErrorCode::Busy,
                    message: "文件工作区正在处理其它操作，请稍后重试。".into(),
                },
            });
            return true;
        }
        let runtime = tokio::runtime::Handle::current();
        let browser_epoch = state.browser.epoch();
        self.requests.push(tokio::task::spawn_blocking(move || {
            runtime.block_on(async move {
                let response = match state.handle(&id, &task, action, browser_epoch).await {
                    Ok(data) => Response::Workbench { data },
                    Err(e) => error(e),
                };
                let _ = state
                    .out
                    .send(Wire::Reply {
                        request_id: id,
                        response,
                    })
                    .await;
            })
        }));
        true
    }
    fn cancel_task(&self, task: &str) {
        self.state.media.cancel_task(task);
        self.state.transfer.cancel_task(task);
        self.state.browser.cancel_task(task);
        self.state.images.lock().unwrap().remove(task);
        for live in self.state.live.lock().unwrap().values() {
            if live.task == task || live.ancestors.iter().any(|v| v == task) {
                live.stop.store(true, Ordering::SeqCst);
                live.notify.notify_one();
            }
        }
    }
    pub fn cancel_all(&self) {
        self.state.transfer.cancel_all();
        self.state.media.cancel_all();
        self.state.browser.cancel_all();
        self.state.extensions.cancel_all();
        self.state.images.lock().unwrap().clear();
        for live in self.state.live.lock().unwrap().values() {
            live.stop.store(true, Ordering::SeqCst);
            live.notify.notify_one();
        }
    }
    pub async fn shutdown(mut self) {
        self.begin_shutdown();
        self.cancel_all();
        for request in std::mem::take(&mut self.requests) {
            let _ = request.await;
        }
        self.cancel_all();
        let jobs = std::mem::take(&mut *self.state.jobs.lock().unwrap());
        for job in jobs {
            let _ = job.await;
        }
        self.state.browser.shutdown();
    }
    pub fn begin_shutdown(&self) {
        self.state.transfer.shutdown();
        self.cancel_all();
    }
}
