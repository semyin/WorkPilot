//! Workbench read requests and approval/operation dispatch.
use super::*;

impl State {
    pub(super) async fn handle(
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
                WorkbenchAction::Media { effect } => (
                    "media",
                    format!(
                        "{} · {}",
                        if matches!(effect, MediaEffect::GenerateImage { .. }) {
                            "生成图片 / Generate image"
                        } else {
                            "生成文件 / Generate file"
                        },
                        effect.paths().join(", ")
                    ),
                    None,
                ),
                WorkbenchAction::Extension { effect } => (
                    "extension",
                    format!(
                        "扩展操作 / Extension · {}",
                        match effect {
                            ExtensionEffect::Discover { server_id, .. } =>
                                format!("检查工具 {server_id}"),
                            ExtensionEffect::Call {
                                server_id, tool, ..
                            } => format!("{server_id} / {tool}"),
                            ExtensionEffect::RunScript { path, .. } => format!("运行 {path}"),
                            ExtensionEffect::CopyResource { destination, .. } =>
                                format!("复制到 {destination}"),
                        }
                    ),
                    None,
                ),
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
                let (context, fresh) = match self.prepare(task, prepared.action.clone()).await {
                    Ok(value) => value,
                    Err(e)
                        if matches!(
                            prepared.action,
                            WorkbenchAction::Extension { .. } | WorkbenchAction::Media { .. }
                        ) =>
                    {
                        op.state = "failed".into();
                        op.error = Some(e.clone());
                        self.save_operation(&op, false).await?;
                        return Err(e);
                    }
                    Err(e) => return Err(e),
                };
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
                    WorkbenchAction::ReadDocument { path, expected } => {
                        self.media
                            .import_project(task, root, &path, &expected)
                            .await
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
