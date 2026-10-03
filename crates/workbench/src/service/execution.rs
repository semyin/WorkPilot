//! Operation lifecycle and guarded effects for files, commands and integrations.
use super::*;

impl State {
    pub(super) async fn start(
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
                                    op.error = Some("操作未正常完成，请展开结果查看原因。".into());
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
    pub(super) async fn execute(
        &self,
        op: &mut WorkbenchOperation,
        prepared: &Prepared,
        live: &Arc<Live>,
    ) -> Result<Value> {
        if live.stop.load(Ordering::SeqCst) {
            return Err("操作已停止。".into());
        }
        let browser_without_files = matches!(&prepared.action,WorkbenchAction::Browser{action} if !matches!(action,BrowserAction::Upload{..}|BrowserAction::Download{..}));
        let extension_without_files =
            if let WorkbenchAction::Extension { effect } = &prepared.action {
                !matches!(effect, ExtensionEffect::CopyResource { .. })
                    && !self
                        .extensions
                        .is_local(effect, &prepared.root_identity)
                        .await?
            } else {
                false
            };
        let lock = workpilot_tools::mutation::acquire(
            Some(&prepared.root_identity),
            if browser_without_files || extension_without_files {
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
        let paths = if let WorkbenchAction::Media { effect } = &prepared.action {
            Some(effect.paths())
        } else if let WorkbenchAction::Browser {
            action: BrowserAction::Download { path, .. },
        } = &prepared.action
        {
            Some(vec![path.clone()])
        } else if let WorkbenchAction::Edit { edit } = &prepared.action {
            Some(self.edit_paths(&context, edit).await?.0)
        } else if let WorkbenchAction::Extension {
            effect: ExtensionEffect::CopyResource { destination, .. },
        } = &prepared.action
        {
            Some(vec![destination.clone()])
        } else {
            None
        };
        let capture = if extension_without_files
            || matches!(&prepared.action,WorkbenchAction::Browser{action} if !matches!(action,BrowserAction::Download{..}))
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
    pub(super) async fn effect(
        &self,
        context: &Context,
        action: &WorkbenchAction,
        scope: &Value,
        live: &Arc<Live>,
        op: &mut WorkbenchOperation,
    ) -> Result<Value> {
        let root = &context.root;
        match action {
            WorkbenchAction::Media { effect } => {
                let (value, events) = self
                    .media
                    .execute(&op.task_id, root, effect, &op.id, live.stop.clone())
                    .await?;
                self.events(events).await;
                Ok(value)
            }
            WorkbenchAction::Extension { effect } => {
                if let ExtensionEffect::CopyResource {
                    destination,
                    expected,
                    ..
                } = effect
                {
                    let bytes = self
                        .extensions
                        .copy_resource(effect, Some(&root.identity))
                        .await?;
                    if live.stop.load(Ordering::SeqCst) {
                        return Err("资源复制已停止。".into());
                    }
                    let version = root
                        .replace_bytes(destination, expected, &bytes)
                        .map_err(|e| e.to_string())?;
                    return Ok(
                        json!({"path":destination,"version":version,"history_recorded":true}),
                    );
                }
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
                self.extensions
                    .execute(
                        effect,
                        &root.identity,
                        &root.path,
                        context.policy.effective_permission == PermissionMode::FullAccess,
                        live.stop.clone(),
                        Some(observer),
                    )
                    .await
            }
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
