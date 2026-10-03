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
    storage: Storage,
    data: PathBuf,
    out: mpsc::Sender<Wire>,
    live: Mutex<HashMap<String, Arc<Live>>>,
    jobs: Mutex<Vec<JoinHandle<()>>>,
    browser: crate::browser::BrowserDriver,
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
        match &request.command {
            Command::ConfigureToolDefaults { .. } => self.cancel_all(),
            Command::Cancel { task_id }
            | Command::ConfigureTaskTools { task_id, .. }
            | Command::ConfigureExecution { task_id, .. } => self.cancel_task(task_id),
            _ => {}
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
        self.state.browser.cancel_all();
        self.state.images.lock().unwrap().clear();
        for live in self.state.live.lock().unwrap().values() {
            live.stop.store(true, Ordering::SeqCst);
            live.notify.notify_one();
        }
    }
    pub async fn shutdown(mut self) {
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
}
impl State {
    async fn record_browser_read(
        &self,
        id: &str,
        task: &str,
        context: &Context,
        action: BrowserAction,
        value: &Value,
    ) -> Result<ContentRef> {
        let prepared = Prepared {
            action: WorkbenchAction::Browser { action },
            task: task.into(),
            root_path: context.root.path.to_string_lossy().into_owned(),
            root_identity: context.root.identity.clone(),
            epoch: context.policy.epoch.clone(),
            scope: Value::Null,
        };
        let blob = Vault::open(&self.data)?
            .put(&serde_json::to_vec(&prepared).map_err(|e| e.to_string())?)?;
        let mut op = WorkbenchOperation {
            id: id.into(),
            task_id: task.into(),
            fingerprint: hash(&prepared)?,
            kind: "browser".into(),
            summary: "read · 页面结构 / Page data".into(),
            state: "completed".into(),
            at_ms: workpilot_storage::now_ms(),
            input: None,
            output: None,
            stdout: None,
            stderr: None,
            error: None,
            pid: None,
            preview_port: None,
        };
        let input = serde_json::to_value(prepared).map_err(|e| e.to_string())?;
        let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
        let (reference, events) = self
            .storage
            .call(move |s| {
                let mut events = s.put_workbench_operation(&op, true)?;
                s.save_workbench_spec(&op.id, &blob)?;
                events.extend(s.attach_workbench_input(&mut op, input)?);
                let output = s.save_operation_output(&op.id, &text)?;
                op.output = Some(output.clone());
                events.extend(s.put_workbench_operation(&op, false)?);
                Ok((output, events))
            })
            .await
            .map_err(|e| e.to_string())?;
        self.events(events).await;
        Ok(reference)
    }
    async fn recover_captures(&self) {
        let Ok(items) = self.storage.call(|s| s.pending_file_captures()).await else {
            return;
        };
        for item in items {
            let attempt = async {
                let operation = item["operation"].as_str().ok_or("invalid capture")?;
                let task = item["task"].as_str().ok_or("invalid capture")?;
                let root = Root::open(
                    item["root_path"].as_str().ok_or("invalid capture")?,
                    item["root_identity"].as_str(),
                )
                .map_err(|e| e.to_string())?;
                let before = serde_json::from_value(item["images"]["images"].clone())
                    .map_err(|e| e.to_string())?;
                let paths = serde_json::from_value(item["images"]["paths"].clone())
                    .map_err(|e| e.to_string())?;
                let capture = Capture {
                    before,
                    vault: Vault::open(&self.data)?,
                    operation: operation.into(),
                    task: task.into(),
                    source: format!("recovered:{}", item["source"].as_str().unwrap_or("unknown")),
                    paths,
                };
                let events = capture.finish(&self.storage, &root).await?;
                self.events(events).await;
                Ok::<_, String>(())
            }
            .await;
            if let Err(error) = attempt {
                let task = item["task"].as_str().unwrap_or("").to_owned();
                if let Ok(event) = self
                    .storage
                    .call(move |s| {
                        s.append(
                            Some(&task),
                            None,
                            Payload::Error {
                                code: ErrorCode::Storage,
                                message: format!("中断操作的文件核对仍未完成：{error}"),
                            },
                        )
                    })
                    .await
                {
                    self.events(vec![event]).await;
                }
            }
        }
    }
    async fn events(&self, events: Vec<Event>) {
        for event in events {
            let _ = self
                .out
                .send(Wire::Event {
                    event: Box::new(event),
                })
                .await;
        }
    }
    async fn context(&self, task: &str, mutation: bool) -> Result<Context> {
        let task = task.to_owned();
        let (policy, mode, ancestors) = self
            .storage
            .call(move |s| {
                let snapshot = s.execution_snapshot(&task)?;
                if mutation && (s.task_archived(&task)? || snapshot.task.mode != WorkMode::Execute)
                {
                    return Err(workpilot_storage::Error::Invalid(
                        "切换为直接执行模式后再修改文件或运行命令；归档任务只能查看。",
                    ));
                }
                let policy = s.tool_settings(&task)?;
                let mut ancestors = vec![];
                let mut current = task.clone();
                while let Some(parent) = s.member_parent(&current)? {
                    ancestors.push(parent.clone());
                    current = parent;
                    if ancestors.len() > 16 {
                        return Err(workpilot_storage::Error::Invalid("member ancestry"));
                    }
                }
                Ok((policy, snapshot.task.mode, ancestors))
            })
            .await
            .map_err(|e| e.to_string())?;
        let root = Root::open(
            policy
                .settings
                .root_path
                .as_deref()
                .ok_or("此任务尚未绑定项目文件夹。")?,
            policy.root_identity.as_deref(),
        )
        .map_err(|e| e.to_string())?;
        Ok(Context {
            root,
            policy,
            mode,
            ancestors,
        })
    }
    async fn operation(&self, id: &str, task: &str) -> Result<WorkbenchOperation> {
        let id = id.to_owned();
        let op = self
            .storage
            .call(move |s| s.workbench_operation(&id))
            .await
            .map_err(|e| e.to_string())?
            .ok_or("找不到这项操作。")?;
        if op.task_id != task {
            return Err("操作不属于当前任务。".into());
        }
        Ok(op)
    }
    async fn read_prepared(&self, id: &str) -> Result<Prepared> {
        let id = id.to_owned();
        let blob = self
            .storage
            .call(move |s| s.workbench_spec(&id))
            .await
            .map_err(|e| e.to_string())?;
        serde_json::from_slice(&Vault::open(&self.data)?.read(&blob)?).map_err(|e| e.to_string())
    }
    async fn save_operation(&self, op: &WorkbenchOperation, insert: bool) -> Result<()> {
        let op = op.clone();
        let events = self
            .storage
            .call(move |s| s.put_workbench_operation(&op, insert))
            .await
            .map_err(|e| e.to_string())?;
        self.events(events).await;
        Ok(())
    }
    async fn prepare(&self, task: &str, action: WorkbenchAction) -> Result<(Context, Prepared)> {
        let context = self.context(task, true).await?;
        let scope = match &action {
            WorkbenchAction::Browser { action } => {
                let mut scope = self
                    .browser
                    .request(json!({"kind":"validate","task":task,"action":action}))?;
                if let BrowserAction::Upload { path, expected, .. }
                | BrowserAction::Download { path, expected, .. } = action
                {
                    user_path(path).map_err(|e| e.to_string())?;
                    let file = context
                        .root
                        .binary_snapshot(path)
                        .map_err(|e| e.to_string())?;
                    if &file.version != expected {
                        return Err("本地文件已变化，请重新读取后确认。".into());
                    }
                    if matches!(action, BrowserAction::Upload { .. })
                        && (!file.version.exists || file.bytes.len() > 512 * 1024)
                    {
                        return Err("当前浏览器上传支持不超过 512 KiB 的实际文件。".into());
                    }
                    scope["file"] = json!(file.version);
                }
                scope
            }
            WorkbenchAction::Edit { edit } => {
                let (paths, expected) = self.edit_paths(&context, edit).await?;
                let mut versions = serde_json::Map::new();
                for (index, path) in paths.iter().enumerate() {
                    user_path(path).map_err(|e| e.to_string())?;
                    let version = context
                        .root
                        .binary_snapshot(path)
                        .map_err(|e| e.to_string())?
                        .version;
                    if index == 0 && &version != expected {
                        return Err("文件已被外部修改。请先重新读取，再决定是否保存或恢复。".into());
                    }
                    if index > 0 && version.exists {
                        return Err("目标名称已存在，原文件未修改。".into());
                    }
                    versions.insert(path.clone(), json!(version));
                }
                Value::Object(versions)
            }
            WorkbenchAction::Terminal {
                program,
                args,
                timeout_ms,
                preview_port,
            } => {
                if preview_port.is_some()
                    && context.policy.effective_permission != PermissionMode::FullAccess
                {
                    return Err(
                        "本机服务预览需要当前任务使用完全访问；其它命令仍按当前权限隔离。".into(),
                    );
                }
                if let Some(port) = preview_port {
                    let address = std::net::SocketAddrV4::new(std::net::Ipv4Addr::LOCALHOST, *port);
                    if std::net::TcpStream::connect_timeout(
                        &address.into(),
                        std::time::Duration::from_millis(100),
                    )
                    .is_ok()
                    {
                        return Err(
                            "该预览端口已被占用，请换一个空闲端口，避免连接其它程序。".into()
                        );
                    }
                }
                let call = ModelToolCall {
                    id: "manual-terminal".into(),
                    provider_item_id: None,
                    name: "run_command".into(),
                    arguments: json!({"program":git::executable(program)?.to_string_lossy(),"args":args,"timeout_ms":(*timeout_ms).min(300000)}),
                };
                let prepared = workpilot_tools::prepare(
                    task,
                    "manual-terminal",
                    &call,
                    context.mode,
                    &context.policy,
                )
                .map_err(|e| e.to_string())?;
                json!(prepared.intent)
            }
            WorkbenchAction::GitCommit {
                expected_status, ..
            } => {
                let status = git::status(&context.root, &self.data)?;
                if status["fingerprint"].as_str() != Some(expected_status) {
                    return Err("Git 状态已变化，请刷新后重新选择。".into());
                }
                status
            }
            _ => return Err("不是可执行的文件工作区操作。".into()),
        };
        let prepared = Prepared {
            action,
            task: task.into(),
            root_path: context.root.path.to_string_lossy().into_owned(),
            root_identity: context.root.identity.clone(),
            epoch: context.policy.epoch.clone(),
            scope,
        };
        Ok((context, prepared))
    }
    async fn edit_paths<'a>(
        &self,
        context: &Context,
        edit: &'a FileEdit,
    ) -> Result<(Vec<String>, &'a FileVersion)> {
        match edit {
            FileEdit::Save { path, expected, .. } | FileEdit::Delete { path, expected } => {
                Ok((vec![path.clone()], expected))
            }
            FileEdit::Rename {
                path,
                destination,
                expected,
            } => Ok((vec![path.clone(), destination.clone()], expected)),
            FileEdit::Restore {
                revision_id,
                expected,
                ..
            } => {
                let (id, identity) = (revision_id.clone(), context.root.identity.clone());
                let revision = self
                    .storage
                    .call(move |s| s.file_revision(&id, &identity))
                    .await
                    .map_err(|e| e.to_string())?;
                Ok((vec![revision.path], expected))
            }
        }
    }
    async fn handle(
        self: &Arc<Self>,
        id: &str,
        task: &str,
        action: WorkbenchAction,
        browser_epoch: u64,
    ) -> Result<Value> {
        action.validate().map_err(str::to_owned)?;
        if action.mutates() {
            let old = id.to_owned();
            if let Some(op) = self
                .storage
                .call(move |s| s.workbench_operation(&old))
                .await
                .map_err(|e| e.to_string())?
            {
                if op.task_id != task
                    || serde_json::to_value(self.read_prepared(id).await?.action).ok()
                        != serde_json::to_value(&action).ok()
                {
                    return Err("请求编号已经用于其它操作。".into());
                }
                return Ok(json!({"kind":"operation","operation":op}));
            }
            let (context, prepared) = self.prepare(task, action).await?;
            let automatic = context.policy.effective_permission == PermissionMode::FullAccess;
            let (kind, summary, port) = match &prepared.action {
                WorkbenchAction::Browser { action } => (
                    "browser",
                    format!(
                        "{} · {}",
                        serde_json::to_value(action).map_err(|e| e.to_string())?["kind"]
                            .as_str()
                            .unwrap_or("action"),
                        match action {
                            BrowserAction::StartDedicated { channel } => channel.as_str(),
                            BrowserAction::Navigate { url, .. }
                            | BrowserAction::NewTab { url, .. } => url.as_str(),
                            BrowserAction::Upload { path, .. }
                            | BrowserAction::Download { path, .. } => path.as_str(),
                            _ => prepared.scope["element"]["name"]
                                .as_str()
                                .or_else(|| prepared.scope["url"].as_str())
                                .unwrap_or("当前页面 / Current page"),
                        }
                    ),
                    None,
                ),
                WorkbenchAction::Edit { edit } => (
                    "file",
                    match edit {
                        FileEdit::Save { path, .. } => format!("保存 {path}"),
                        FileEdit::Delete { path, .. } => format!("删除 {path}"),
                        FileEdit::Rename {
                            path, destination, ..
                        } => format!("重命名 {path} → {destination}"),
                        FileEdit::Restore { revision_id, .. } => {
                            format!("恢复文件版本 {revision_id}")
                        }
                    },
                    None,
                ),
                WorkbenchAction::Terminal {
                    program,
                    preview_port,
                    ..
                } => (
                    "terminal",
                    program.rsplit(['/', '\\']).next().unwrap_or(program).into(),
                    *preview_port,
                ),
                WorkbenchAction::GitCommit { paths, .. } => (
                    "git_commit",
                    format!("提交 {} 个已选文件", paths.len()),
                    None,
                ),
                _ => unreachable!(),
            };
            let mut op = WorkbenchOperation {
                id: id.into(),
                task_id: task.into(),
                fingerprint: hash(&prepared)?,
                kind: kind.into(),
                summary,
                state: if automatic {
                    "queued"
                } else {
                    "awaiting_approval"
                }
                .into(),
                at_ms: workpilot_storage::now_ms(),
                output: None,
                input: None,
                stdout: None,
                stderr: None,
                error: None,
                pid: None,
                preview_port: port,
            };
            let vault = Vault::open(&self.data)?;
            let blob = vault.put(&serde_json::to_vec(&prepared).map_err(|e| e.to_string())?)?;
            let (mut saved, key) = (op.clone(), id.to_owned());
            let input = serde_json::to_value(&prepared).map_err(|e| e.to_string())?;
            let (saved, events) = self
                .storage
                .call(move |s| {
                    let mut events = s.put_workbench_operation(&saved, true)?;
                    s.save_workbench_spec(&key, &blob)?;
                    events.extend(s.attach_workbench_input(&mut saved, input)?);
                    Ok((saved, events))
                })
                .await
                .map_err(|e| e.to_string())?;
            self.events(events).await;
            op = saved;
            let view = prepared_action_for_view(&prepared);
            if automatic
                && let Err(error) = self.start(op.clone(), prepared, context.ancestors).await
            {
                let mut failed = op.clone();
                failed.state = "failed".into();
                failed.error = Some(error.clone());
                self.save_operation(&failed, false).await?;
                return Err(error);
            }
            return Ok(json!({"kind":"operation","operation":op,"intent":view}));
        }
        match action {
            WorkbenchAction::Approve {
                operation_id,
                fingerprint,
            } => {
                let mut op = self.operation(&operation_id, task).await?;
                if op.fingerprint != fingerprint || op.state != "awaiting_approval" {
                    return Err("审批已失效或已被使用。".into());
                }
                let prepared = self.read_prepared(&operation_id).await?;
                let (context, fresh) = self.prepare(task, prepared.action.clone()).await?;
                if hash(&fresh)? != fingerprint {
                    return Err("文件或权限已变化，旧审批不会执行，请重新提交操作。".into());
                }
                op.state = "queued".into();
                self.start(op.clone(), prepared, context.ancestors).await?;
                Ok(json!({"kind":"operation","operation":op}))
            }
            WorkbenchAction::Stop { operation_id } => {
                let mut op = self.operation(&operation_id, task).await?;
                if op.kind == "browser" {
                    self.browser.cancel_task(task);
                }
                let live = self.live.lock().unwrap().get(&operation_id).cloned();
                if let Some(live) = live {
                    live.stop.store(true, Ordering::SeqCst);
                    live.notify.notify_one();
                    op.state = "stopping".into();
                } else if op.state == "awaiting_approval" {
                    op.state = "cancelled".into();
                    self.save_operation(&op, false).await?;
                }
                Ok(json!({"kind":"operation","operation":op}))
            }
            WorkbenchAction::Operations => {
                let task = task.to_owned();
                let ops = self
                    .storage
                    .call(move |s| s.workbench_operations(&task))
                    .await
                    .map_err(|e| e.to_string())?;
                let mut rows = vec![];
                for mut op in ops {
                    let live = self.live.lock().unwrap().get(&op.id).cloned();
                    let mut text = String::new();
                    if let Some(live) = live {
                        let view = live.view.lock().unwrap();
                        op.pid = view.pid;
                        let stdout = String::from_utf8_lossy(&view.stdout);
                        let stderr = String::from_utf8_lossy(&view.stderr);
                        text = format!("{stdout}\n{stderr}");
                        if live.stop.load(Ordering::SeqCst) {
                            op.state = "stopping".into();
                        }
                    }
                    let safe = self
                        .storage
                        .call(move |s| Ok(s.safe_workbench_text(&text)))
                        .await
                        .map_err(|e| e.to_string())?;
                    let tail = safe
                        .chars()
                        .rev()
                        .take(16000)
                        .collect::<String>()
                        .chars()
                        .rev()
                        .collect::<String>();
                    rows.push(json!({"operation":op,"live_output":tail}));
                }
                Ok(json!({"kind":"operations","items":rows}))
            }
            WorkbenchAction::Operation { operation_id } => {
                let op = self.operation(&operation_id, task).await?;
                let prepared = self.read_prepared(&operation_id).await?;
                Ok(
                    json!({"kind":"operation","operation":op,"intent":prepared_action_for_view(&prepared)}),
                )
            }
            WorkbenchAction::Preview { operation_id } => {
                let op = self.operation(&operation_id, task).await?;
                let port = op.preview_port.ok_or("此操作没有预览端口。")?;
                let live = self
                    .live
                    .lock()
                    .unwrap()
                    .get(&operation_id)
                    .cloned()
                    .ok_or("该服务已经停止。")?;
                if live.stop.load(Ordering::SeqCst) {
                    return Err("服务正在停止。".into());
                }
                let owned = live.view.lock().unwrap().owned.clone();
                let context = self.context(task, false).await?;
                let result = tool_process::run(
                    ProcessSpec {
                        program: PathBuf::from(
                            std::env::var("SystemRoot")
                                .map_err(|_| "preview ownership is Windows-only")?,
                        )
                        .join("System32/netstat.exe"),
                        args: vec!["-ano".into(), "-p".into(), "tcp".into()],
                        cwd: context.root.path,
                        sandboxed: false,
                        timeout_ms: 5000,
                        output_limit: 1024 * 1024,
                        ledger_dir: self.data.join("tool-sandboxes"),
                    },
                    Arc::new(AtomicBool::new(false)),
                )
                .map_err(|e| e.to_string())?;
                let bound = result.exit_code == 0
                    && result.stdout.lines().any(|line| {
                        let columns: Vec<_> = line.split_whitespace().collect();
                        columns.len() >= 5
                            && columns[1].rsplit(':').next() == Some(port.to_string().as_str())
                            && columns[3] == "LISTENING"
                            && columns[4]
                                .parse::<u32>()
                                .is_ok_and(|pid| owned.contains(&pid))
                    });
                if !bound {
                    return Err("服务尚未就绪，或端口不属于本任务启动的进程。".into());
                }
                Ok(
                    json!({"kind":"preview","url":format!("http://127.0.0.1:{port}/"),"operation_id":op.id}),
                )
            }
            other => {
                let context = self.context(task, false).await?;
                let root = &context.root;
                match other {
                    WorkbenchAction::BrowserControl { control } => {
                        let connecting = matches!(
                            control,
                            BrowserControl::Start { .. }
                                | BrowserControl::Pair { .. }
                                | BrowserControl::Resume { .. }
                        );
                        if connecting {
                            self.context(task, true).await?;
                        }
                        let value = json!({"kind":"control","task":task,"ancestors":context.ancestors,"control":control});
                        if connecting {
                            self.browser.request_guarded(value, browser_epoch)
                        } else {
                            self.browser.request(value)
                        }
                    }
                    WorkbenchAction::Browser { action } => {
                        let value = self
                            .browser
                            .request(json!({"kind":"perform","task":task,"action":action}))?;
                        let record = self
                            .record_browser_read(id, task, &context, action, &value)
                            .await?;
                        let mut value = value;
                        value["record"] = json!(record);
                        Ok(value)
                    }
                    WorkbenchAction::List { path } => Ok(
                        json!({"kind":"files","listing":root.list(&path).map_err(|e|e.to_string())?,"root_path":root.path,"excluded_from_command_history":EXCLUDED}),
                    ),
                    WorkbenchAction::ReadFile { path } => {
                        let file = root.binary_snapshot(&path).map_err(|e| e.to_string())?;
                        Ok(file_view(&path, &file.version, &file.bytes))
                    }
                    WorkbenchAction::Search { text } => Ok(
                        json!({"kind":"search","result":root.search(".",&text).map_err(|e|e.to_string())?}),
                    ),
                    WorkbenchAction::History {
                        path,
                        before,
                        limit,
                    } => {
                        let identity = root.identity.clone();
                        let rows = self
                            .storage
                            .call(move |s| {
                                s.import_managed_revisions(&identity)?;
                                s.file_history(&identity, path.as_deref(), before.as_deref(), limit)
                            })
                            .await
                            .map_err(|e| e.to_string())?;
                        Ok(
                            json!({"kind":"history","items":rows,"has_more":rows.len()==limit as usize}),
                        )
                    }
                    WorkbenchAction::Revision { revision_id } => {
                        let identity = root.identity.clone();
                        let revision = self
                            .storage
                            .call(move |s| s.file_revision(&revision_id, &identity))
                            .await
                            .map_err(|e| e.to_string())?;
                        let vault = Vault::open(&self.data)?;
                        let before =
                            history::image_bytes(&self.storage, &vault, &revision.before).await?;
                        let after =
                            history::image_bytes(&self.storage, &vault, &revision.after).await?;
                        Ok(
                            json!({"kind":"revision","current_version":root.binary_snapshot(&revision.path).map_err(|e|e.to_string())?.version,"before":file_view(&revision.path,&revision.before.version,&before),"after":file_view(&revision.path,&revision.after.version,&after),"revision":revision}),
                        )
                    }
                    WorkbenchAction::GitStatus => {
                        Ok(json!({"kind":"git","status":git::status(root,&self.data)?}))
                    }
                    WorkbenchAction::GitDiff { path } => {
                        Ok(json!({"kind":"git_diff","diff":git::diff(root,&self.data,&path)?}))
                    }
                    WorkbenchAction::ResolvePath { path } => {
                        if path != "." {
                            root.binary_snapshot(&path).map_err(|e| e.to_string())?;
                        }
                        Ok(
                            json!({"kind":"path","path":if path=="."{root.path.clone()}else{root.path.join(workpilot_tools::files::relative(&path,false).map_err(|e|e.to_string())?)}}),
                        )
                    }
                    _ => Err("unsupported workspace operation".into()),
                }
            }
        }
    }
    async fn start(
        self: &Arc<Self>,
        op: WorkbenchOperation,
        prepared: Prepared,
        ancestors: Vec<String>,
    ) -> Result<()> {
        let live = Arc::new(Live {
            task: op.task_id.clone(),
            ancestors,
            stop: Arc::new(AtomicBool::new(false)),
            notify: Notify::new(),
            view: Mutex::new(LiveView::default()),
        });
        {
            let mut items = self.live.lock().unwrap();
            if items.len() >= 4 || items.contains_key(&op.id) {
                return Err("最多同时运行 4 个工作区操作，请先停止或等待已有操作。".into());
            }
            items.insert(op.id.clone(), live.clone());
        }
        let claimed = op.clone();
        match self
            .storage
            .call(move |s| s.claim_workbench_operation(&claimed))
            .await
        {
            Ok(events) => self.events(events).await,
            Err(e) => {
                self.live.lock().unwrap().remove(&op.id);
                return Err(e.to_string());
            }
        }
        let (state, runtime) = (self.clone(), tokio::runtime::Handle::current());
        let job = tokio::task::spawn_blocking(move || {
            runtime.block_on(async move {
                let mut op = op;
                let result = state.execute(&mut op, &prepared, &live).await;
                match result {
                    Ok(value) => {
                        let failed = value["failed"] == true;
                        let text = serde_json::to_string_pretty(&value).unwrap_or_default();
                        let operation_id = op.id.clone();
                        match state
                            .storage
                            .call(move |s| s.save_operation_output(&operation_id, &text))
                            .await
                        {
                            Ok(output) => {
                                op.output = Some(output);
                                op.state = if live.stop.load(Ordering::SeqCst) {
                                    "cancelled"
                                } else if failed {
                                    "failed"
                                } else {
                                    "completed"
                                }
                                .into();
                                if failed {
                                    op.error =
                                        Some("命令未正常完成，请展开输出查看退出原因。".into());
                                }
                            }
                            Err(e) => {
                                op.state = "failed".into();
                                op.error = Some(format!("操作结果未能保存，请核对实际文件：{e}"));
                            }
                        }
                    }
                    Err(e) => {
                        op.error = Some(e);
                        op.state = if live.stop.load(Ordering::SeqCst) {
                            "cancelled"
                        } else {
                            "failed"
                        }
                        .into();
                    }
                }
                op.pid = live.view.lock().unwrap().pid;
                let _ = state.save_operation(&op, false).await;
                state.live.lock().unwrap().remove(&op.id);
            })
        });
        self.jobs.lock().unwrap().push(job);
        Ok(())
    }
    async fn execute(
        &self,
        op: &mut WorkbenchOperation,
        prepared: &Prepared,
        live: &Arc<Live>,
    ) -> Result<Value> {
        if live.stop.load(Ordering::SeqCst) {
            return Err("操作已停止。".into());
        }
        let browser_without_files = matches!(&prepared.action,WorkbenchAction::Browser{action} if !matches!(action,BrowserAction::Upload{..}|BrowserAction::Download{..}));
        let lock = workpilot_tools::mutation::acquire(
            Some(&prepared.root_identity),
            if browser_without_files {
                "browser"
            } else {
                "workbench"
            },
        );
        let _lease = tokio::select! {lease=lock=>lease,_=live.notify.notified()=>return Err("操作已停止。".into())};
        if live.stop.load(Ordering::SeqCst) {
            return Err("操作已停止。".into());
        }
        let (context, fresh) = self
            .prepare(&prepared.task, prepared.action.clone())
            .await?;
        if hash(&fresh)? != op.fingerprint {
            return Err("文件、命令或权限在等待期间发生变化；本次未执行。".into());
        }
        op.state = "running".into();
        self.save_operation(op, false).await?;
        let paths = if let WorkbenchAction::Browser {
            action: BrowserAction::Download { path, .. },
        } = &prepared.action
        {
            Some(vec![path.clone()])
        } else if let WorkbenchAction::Edit { edit } = &prepared.action {
            Some(self.edit_paths(&context, edit).await?.0)
        } else {
            None
        };
        let capture = if matches!(&prepared.action,WorkbenchAction::Browser{action} if !matches!(action,BrowserAction::Download{..}))
        {
            None
        } else {
            Some(
                Capture::begin(
                    &self.storage,
                    &self.data,
                    &context.root,
                    &op.id,
                    &op.task_id,
                    &op.kind,
                    paths,
                )
                .await?,
            )
        };
        let result = self
            .effect(&context, &prepared.action, &prepared.scope, live, op)
            .await;
        let versions = match capture {
            Some(capture) => capture.finish(&self.storage, &context.root).await,
            None => Ok(vec![]),
        };
        match versions {
            Ok(events) => self.events(events).await,
            Err(e) => {
                return Err(format!(
                    "操作后的文件核对未完成，请查看当前文件；不会自动重跑：{e}"
                ));
            }
        }
        result
    }
    async fn effect(
        &self,
        context: &Context,
        action: &WorkbenchAction,
        scope: &Value,
        live: &Arc<Live>,
        op: &mut WorkbenchOperation,
    ) -> Result<Value> {
        let root = &context.root;
        match action {
            WorkbenchAction::Browser { action } => {
                let mut wire = serde_json::to_value(action).map_err(|e| e.to_string())?;
                if let BrowserAction::Upload { path, expected, .. } = action {
                    let file = root.binary_snapshot(path).map_err(|e| e.to_string())?;
                    if &file.version != expected {
                        return Err("上传文件已变化，未发送。".into());
                    }
                    wire["bytes"] =
                        json!(base64::engine::general_purpose::STANDARD.encode(file.bytes));
                    wire["name"] = json!(
                        std::path::Path::new(path)
                            .file_name()
                            .ok_or("invalid upload filename")?
                            .to_string_lossy()
                    );
                }
                if live.stop.load(Ordering::SeqCst) {
                    return Err("浏览器操作已停止。".into());
                }
                let mut value = self
                    .browser
                    .request(json!({"kind":"perform","task":op.task_id,"ancestors":context.ancestors,"action":wire}))?;
                if live.stop.load(Ordering::SeqCst) {
                    self.browser.cancel_task(&op.task_id);
                    return Err("浏览器操作已停止；请核对页面上的实际结果。".into());
                }
                if let BrowserAction::Download { path, expected, .. } = action {
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(
                            value["bytes"]
                                .as_str()
                                .ok_or("download bytes unavailable")?,
                        )
                        .map_err(|_| "invalid download bytes")?;
                    if bytes.len() > 8 * 1024 * 1024 {
                        return Err("下载文件超过 8 MiB 上限。".into());
                    }
                    if live.stop.load(Ordering::SeqCst) {
                        return Err("下载已停止，未写入项目。".into());
                    }
                    let version = root
                        .replace_bytes(path, expected, &bytes)
                        .map_err(|e| e.to_string())?;
                    let blob = Vault::open(&self.data)?.put(&bytes)?;
                    let (task, saved_path, saved_version, url) = (
                        op.task_id.clone(),
                        path.clone(),
                        version.clone(),
                        value["url"].clone(),
                    );
                    let events = self
                        .storage
                        .call(move |s| {
                            s.register_browser_artifact(
                                &task,
                                &saved_path,
                                &saved_version,
                                &blob,
                                url,
                            )
                        })
                        .await
                        .map_err(|e| e.to_string())?;
                    self.events(events).await;
                    value
                        .as_object_mut()
                        .ok_or("invalid browser result")?
                        .remove("bytes");
                    value["path"] = json!(path);
                    value["version"] = json!(version);
                }
                Ok(value)
            }
            WorkbenchAction::Edit { edit } => {
                match edit {
                    FileEdit::Save {
                        path,
                        expected,
                        text,
                    } => {
                        root.replace_bytes(path, expected, text.as_bytes())
                            .map_err(|e| e.to_string())?;
                    }
                    FileEdit::Delete { path, expected } => {
                        root.delete_version(path, expected)
                            .map_err(|e| e.to_string())?;
                    }
                    FileEdit::Rename {
                        path,
                        destination,
                        expected,
                    } => {
                        root.rename_version(path, destination, expected)
                            .map_err(|e| e.to_string())?;
                    }
                    FileEdit::Restore {
                        revision_id,
                        before,
                        expected,
                    } => {
                        let (id, identity) = (revision_id.clone(), root.identity.clone());
                        let revision = self
                            .storage
                            .call(move |s| s.file_revision(&id, &identity))
                            .await
                            .map_err(|e| e.to_string())?;
                        let image = if *before {
                            revision.before
                        } else {
                            revision.after
                        };
                        if image.version.exists {
                            let vault = Vault::open(&self.data)?;
                            let bytes = history::image_bytes(&self.storage, &vault, &image).await?;
                            root.replace_bytes(&revision.path, expected, &bytes)
                                .map_err(|e| e.to_string())?;
                        } else if expected.exists {
                            root.delete_version(&revision.path, expected)
                                .map_err(|e| e.to_string())?;
                        }
                    }
                }
                Ok(json!({"saved":true,"history_recorded":true}))
            }
            WorkbenchAction::Terminal {
                program,
                args,
                timeout_ms,
                ..
            } => {
                let call = ModelToolCall {
                    id: "manual-terminal".into(),
                    provider_item_id: None,
                    name: "run_command".into(),
                    arguments: json!({"program":git::executable(program)?.to_string_lossy(),"args":args,"timeout_ms":(*timeout_ms).min(300000)}),
                };
                let guarded = workpilot_tools::prepare(
                    &op.task_id,
                    "manual-terminal",
                    &call,
                    context.mode,
                    &context.policy,
                )
                .map_err(|e| e.to_string())?;
                if serde_json::to_value(&guarded.intent).map_err(|e| e.to_string())? != *scope {
                    return Err("程序或项目文件已变化，命令没有启动。".into());
                }
                // Keep the executable's read handle alive through process creation and completion.
                let _guard = guarded;
                let view = live.clone();
                let observer = Arc::new(move |progress| {
                    let mut state = view.view.lock().unwrap();
                    match progress {
                        ProcessProgress::Started(pid) => state.pid = Some(pid),
                        ProcessProgress::OwnedProcesses(pids) => state.owned = pids,
                        ProcessProgress::Stdout(bytes) => state.stdout.extend(bytes),
                        ProcessProgress::Stderr(bytes) => state.stderr.extend(bytes),
                    }
                });
                let result = tool_process::run_observed(
                    ProcessSpec {
                        program: git::executable(program)?,
                        args: args.clone(),
                        cwd: root.path.clone(),
                        sandboxed: context.policy.effective_permission
                            != PermissionMode::FullAccess,
                        timeout_ms: *timeout_ms,
                        output_limit: 4 * 1024 * 1024,
                        ledger_dir: self.data.join("tool-sandboxes"),
                    },
                    live.stop.clone(),
                    Some(observer),
                )
                .map_err(|e| e.to_string())?;
                let failed = result.exit_code != 0
                    || result.stopped.is_some()
                    || !result.cleanup_errors.is_empty();
                let (id, stdout, stderr) =
                    (op.id.clone(), result.stdout.clone(), result.stderr.clone());
                let (out, err) = self
                    .storage
                    .call(move |s| {
                        Ok((
                            s.save_operation_output(&id, &stdout)?,
                            s.save_operation_output(&id, &stderr)?,
                        ))
                    })
                    .await
                    .map_err(|e| e.to_string())?;
                op.stdout = Some(out.clone());
                op.stderr = Some(err.clone());
                let mut record = serde_json::to_value(result).map_err(|e| e.to_string())?;
                record["stdout"] = json!(out);
                record["stderr"] = json!(err);
                Ok(json!({"process":record,"failed":failed}))
            }
            WorkbenchAction::GitCommit {
                paths,
                message,
                expected_status,
            } => git::commit(
                root,
                &self.data,
                paths,
                message,
                expected_status,
                live.stop.clone(),
            ),
            _ => Err("invalid workbench operation".into()),
        }
    }
}
fn prepared_action_for_view(p: &Prepared) -> Value {
    json!({"action":p.action,"root_path":p.root_path,"scope":p.scope})
}
fn file_view(path: &str, version: &FileVersion, bytes: &[u8]) -> Value {
    let text = if bytes.len() <= 256 * 1024 && !bytes.contains(&0) {
        std::str::from_utf8(bytes).ok()
    } else {
        None
    };
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else {
        None
    };
    let preview = if bytes.len() <= 4 * 1024 * 1024 {
        mime.map(|m| {
            format!(
                "data:{m};base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            )
        })
    } else {
        None
    };
    json!({"kind":"file","path":path,"version":version,"text":text,"editable":text.is_some(),"preview":preview,"hex_preview":bytes.iter().take(128).map(|b|format!("{b:02x}")).collect::<Vec<_>>().join(" "),"editor_limit":256*1024})
}
