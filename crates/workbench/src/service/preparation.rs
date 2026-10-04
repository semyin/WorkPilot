//! Project scope, durable operation records, recovery and action preparation.
use super::*;

impl State {
    pub(super) async fn extension_scope(&self, task: Option<String>) -> Result<Option<String>> {
        let Some(task) = task else {
            return Ok(None);
        };
        let policy = self
            .storage
            .call(move |s| s.tool_settings(&task))
            .await
            .map_err(|e| e.to_string())?;
        match policy.settings.root_path.as_deref() {
            Some(path) => Ok(Some(
                Root::open(path, policy.root_identity.as_deref())
                    .map_err(|e| e.to_string())?
                    .identity,
            )),
            None => Ok(None),
        }
    }
    pub(super) async fn record_browser_read(
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
    pub(super) async fn recover_captures(&self) {
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
    pub(super) async fn events(&self, events: Vec<Event>) {
        for event in events {
            let _ = self
                .out
                .send(Wire::Event {
                    event: Box::new(event),
                })
                .await;
        }
    }
    pub(super) async fn context(&self, task: &str, mutation: bool) -> Result<Context> {
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
    pub(super) async fn operation(&self, id: &str, task: &str) -> Result<WorkbenchOperation> {
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
    pub(super) async fn read_prepared(&self, id: &str) -> Result<Prepared> {
        let id = id.to_owned();
        let blob = self
            .storage
            .call(move |s| s.workbench_spec(&id))
            .await
            .map_err(|e| e.to_string())?;
        serde_json::from_slice(&Vault::open(&self.data)?.read(&blob)?).map_err(|e| e.to_string())
    }
    pub(super) async fn save_operation(&self, op: &WorkbenchOperation, insert: bool) -> Result<()> {
        let op = op.clone();
        let events = self
            .storage
            .call(move |s| s.put_workbench_operation(&op, insert))
            .await
            .map_err(|e| e.to_string())?;
        self.events(events).await;
        Ok(())
    }
    pub(super) async fn prepare(
        &self,
        task: &str,
        action: WorkbenchAction,
    ) -> Result<(Context, Prepared)> {
        let context = self.context(task, true).await?;
        let scope = match &action {
            WorkbenchAction::ImportFiles { manifest_blob } => {
                self.transfer
                    .prepare_files(manifest_blob, task, &context.root)
                    .await?
            }
            WorkbenchAction::Media { effect } => {
                self.media.prepare(task, &context.root, effect).await?
            }
            WorkbenchAction::Extension { effect } => {
                let mut scope = self
                    .extensions
                    .prepare(
                        effect,
                        &context.root.identity,
                        context.policy.settings.commands_enabled,
                    )
                    .await?;
                if let ExtensionEffect::CopyResource {
                    destination,
                    expected,
                    ..
                } = effect
                {
                    user_path(destination).map_err(|e| e.to_string())?;
                    let version = context
                        .root
                        .binary_snapshot(destination)
                        .map_err(|e| e.to_string())?
                        .version;
                    if &version != expected {
                        return Err("目标文件已经变化，请重新读取再复制。".into());
                    }
                    scope["destination_version"] = json!(version);
                }
                scope
            }
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
    pub(super) async fn edit_paths<'a>(
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
}
