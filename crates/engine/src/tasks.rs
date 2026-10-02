mod team_control;
use crate::models::{Handled, secret_for};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::Arc};
use tokio::{
    sync::{Semaphore, mpsc},
    task::JoinHandle,
};
use workpilot_contracts::*;
use workpilot_providers::{HttpBackend, diagnostic};
use workpilot_runtime::{
    Boundary, ExecutionEnvironment, FaultObserver, Reviewer, Signals, storage_error,
};
use workpilot_storage::Storage;
struct Job {
    signals: Signals,
    handle: JoinHandle<()>,
}
pub struct Tasks {
    storage: Storage,
    out: mpsc::Sender<Wire>,
    backend: HttpBackend,
    namespace: String,
    jobs: HashMap<String, Job>,
    slots: Arc<Semaphore>,
    root_slots: HashMap<String, Arc<Semaphore>>,
    fault: Option<String>,
    tool_ledger: std::path::PathBuf,
}
struct Observer {
    fault: Option<String>,
}
impl FaultObserver for Observer {
    async fn boundary(&self, point: Boundary) {
        let expected = match point {
            Boundary::BeforeTool => "before_tool",
            Boundary::DuringTool => "during_tool",
            Boundary::AfterEffect => "after_effect",
        };
        if self.fault.as_deref() == Some(expected) {
            std::process::exit(86);
        }
    }
}
impl Tasks {
    pub async fn new(
        storage: Storage,
        out: mpsc::Sender<Wire>,
        directory: &std::path::Path,
        test_mode: bool,
    ) -> Result<Self, &'static str> {
        let tool_ledger = directory.join("tool-sandboxes");
        let cleanup = workpilot_platform::tool_process::recover(&tool_ledger)
            .map_err(|_| "Tool sandbox recovery failed")?;
        if !cleanup.is_empty() {
            return Err("Tool sandbox cleanup requires inspection");
        }
        let scheduler = storage
            .call(|s| s.scheduler_settings())
            .await
            .map_err(|_| "Scheduler settings could not load")?;
        Ok(Self {
            root_slots: HashMap::new(),
            tool_ledger,
            storage,
            out,
            backend: HttpBackend::new().map_err(|_| "HTTP client could not start")?,
            namespace: format!(
                "models-{:x}",
                Sha256::digest(directory.to_string_lossy().as_bytes())
            ),
            jobs: HashMap::new(),
            slots: Arc::new(Semaphore::new(scheduler.max_running as usize)),
            fault: if test_mode {
                std::env::var("WORKPILOT_TEST_EXECUTION_CRASH").ok()
            } else {
                None
            },
        })
    }
    pub async fn dispatch(&mut self, request: &Request) -> Handled {
        self.jobs.retain(|_, job| !job.handle.is_finished());
        if matches!(
            &request.command,
            Command::ConfigureTaskTools { .. }
                | Command::ConfigureToolDefaults { .. }
                | Command::DecideToolApproval { .. }
        ) {
            let req = request.clone();
            match self.storage.call(move |s| s.cached_receipt(&req)).await {
                Ok(Some(receipt)) => {
                    return Handled::Reply(Box::new(Response::Receipt { receipt }));
                }
                Ok(None) => {}
                Err(e) => {
                    return Handled::Reply(Box::new(Response::ModelError {
                        diagnostic: storage_error(e),
                    }));
                }
            }
        }
        if let Some(result) = self.team_command(request).await {
            return Handled::Reply(Box::new(match result {
                Ok(r) => r,
                Err(diagnostic) => Response::ModelError { diagnostic },
            }));
        }
        let result = match &request.command {
            Command::Read {
                query: Query::ToolRegistry,
            } => Some(Ok(Response::ToolRegistry {
                tools: workpilot_tools::registry(),
            })),
            Command::ConfigureTaskTools { task_id, settings } => {
                Some(self.configure_tools(request, task_id, settings).await)
            }
            Command::ConfigureToolDefaults { settings } => {
                let (req, settings) = (request.clone(), settings.clone());
                let changed = self
                    .storage
                    .call(move |s| {
                        let events = s.configure_tool_defaults(&req, &settings)?;
                        s.pause_all_teams()?;
                        Ok(events)
                    })
                    .await;
                Some(match changed {
                    Ok(events) => {
                        for job in self.jobs.values() {
                            job.signals.stop.cancel();
                        }
                        emit(&self.out, events).await;
                        Ok(Response::Receipt {
                            receipt: Receipt {
                                request_id: request.request_id.clone(),
                                status: CommandStatus::Completed,
                                task_id: None,
                                duplicate: false,
                            },
                        })
                    }
                    Err(e) => Err(storage_error(e)),
                })
            }
            Command::DecideToolApproval {
                task_id,
                approval_id,
                fingerprint,
                approve,
            } => Some(
                self.approve_tool(request, task_id, approval_id, fingerprint, *approve)
                    .await,
            ),
            Command::CreateExecution { config } => {
                let (req, config) = (request.clone(), config.clone());
                Some(
                    match self
                        .storage
                        .call(move |s| s.create_execution(&req, &config))
                        .await
                    {
                        Ok((receipt, events)) => {
                            emit(&self.out, events).await;
                            Ok(Response::Receipt { receipt })
                        }
                        Err(e) => Err(storage_error(e)),
                    },
                )
            }
            Command::StartExecution { task_id } => Some(self.start(request, task_id, true).await),
            Command::ConfigureExecution {
                task_id,
                mode,
                profile_id,
                limits,
            } => {
                let (req, task, mode, profile, limits) = (
                    request.clone(),
                    task_id.clone(),
                    *mode,
                    profile_id.clone(),
                    limits.clone(),
                );
                Some(
                    match self
                        .storage
                        .call(move |s| {
                            s.configure_execution(&req, &task, mode, profile.as_deref(), &limits)
                        })
                        .await
                    {
                        Ok(events) => {
                            if let Err(e) = self.pause_tree(task_id).await {
                                return Handled::Reply(Box::new(Response::ModelError {
                                    diagnostic: e,
                                }));
                            }
                            emit(&self.out, events).await;
                            Ok(receipt(request, task_id))
                        }
                        Err(e) => Err(storage_error(e)),
                    },
                )
            }
            Command::ResolveExecutionAction {
                task_id,
                action_id,
                resolution,
            } => {
                let (req, task, action, resolution) = (
                    request.clone(),
                    task_id.clone(),
                    action_id.clone(),
                    resolution.clone(),
                );
                Some(
                    match self
                        .storage
                        .call(move |s| {
                            s.resolve_execution_action(&req, &task, &action, &resolution)
                        })
                        .await
                    {
                        Ok(events) => {
                            emit(&self.out, events).await;
                            Ok(receipt(request, task_id))
                        }
                        Err(e) => Err(storage_error(e)),
                    },
                )
            }
            Command::Enqueue { task_id, .. }
            | Command::Steer { task_id, .. }
            | Command::Cancel { task_id } => {
                let task = task_id.clone();
                let owns = match self.storage.call(move |s| s.is_execution(&task)).await {
                    Ok(owns) => owns,
                    Err(e) => {
                        return Handled::Reply(Box::new(Response::ModelError {
                            diagnostic: storage_error(e),
                        }));
                    }
                };
                if !owns {
                    return Handled::No;
                }
                if matches!(request.command, Command::Cancel { .. }) {
                    return Handled::Reply(Box::new(
                        match self.cancel_tree(request, task_id).await {
                            Ok(r) => r,
                            Err(diagnostic) => Response::ModelError { diagnostic },
                        },
                    ));
                }
                let req = request.clone();
                let task = task_id.clone();
                let cancel = matches!(request.command, Command::Cancel { .. });
                Some(
                    match self
                        .storage
                        .call(move |s| {
                            if cancel {
                                s.cancel_execution(&req, &task)
                            } else {
                                s.apply(&req)
                            }
                        })
                        .await
                    {
                        Ok((receipt, events)) => {
                            if !receipt.duplicate
                                && let Some(job) = self.jobs.get(task_id)
                            {
                                if cancel {
                                    job.signals.stop.cancel();
                                } else if matches!(request.command, Command::Steer { .. }) {
                                    job.signals.steer.notify_one();
                                }
                            }
                            emit(&self.out, events).await;
                            Ok(Response::Receipt { receipt })
                        }
                        Err(e) => Err(storage_error(e)),
                    },
                )
            }
            _ => None,
        };
        match result {
            None => Handled::No,
            Some(Ok(r)) => Handled::Reply(Box::new(r)),
            Some(Err(diagnostic)) => Handled::Reply(Box::new(Response::ModelError { diagnostic })),
        }
    }
    async fn start(
        &mut self,
        request: &Request,
        task: &str,
        user_start: bool,
    ) -> Result<Response, ModelDiagnostic> {
        let req = request.clone();
        if let Some(receipt) = self
            .storage
            .call(move |s| s.cached_receipt(&req))
            .await
            .map_err(storage_error)?
        {
            return Ok(Response::Receipt { receipt });
        }
        let target = task.to_owned();
        let (root, group_limit) = self
            .storage
            .call(move |s| {
                s.prepare_member_start(&target)?;
                Ok((
                    s.team_root(&target)?,
                    s.team_settings(&target)?.max_parallel,
                ))
            })
            .await
            .map_err(storage_error)?;
        let group = self
            .root_slots
            .entry(root)
            .or_insert_with(|| Arc::new(Semaphore::new(group_limit as usize)))
            .clone();
        let task_owned = task.to_owned();
        let profile = self
            .storage
            .call(move |s| {
                let snapshot = s.execution_snapshot(&task_owned)?;
                s.resolve_profile(Some(&task_owned), Some(&snapshot.agent_id), None)
            })
            .await
            .map_err(storage_error)?;
        workpilot_providers::config::validate_profile(&profile)?;
        if profile.model.is_empty() {
            return Err(diagnostic::detail(
                ModelErrorCode::Configuration,
                "请先选择模型名称",
            ));
        }
        let (req, task_owned, p) = (request.clone(), task.to_owned(), profile.clone());
        let (receipt, events) = self
            .storage
            .call(move |s| s.queue_execution(&req, &task_owned, &p))
            .await
            .map_err(storage_error)?;
        emit(&self.out, events).await;
        if user_start {
            let target = task.to_owned();
            let events = self
                .storage
                .call(move |s| s.team_set_enabled(&target, true, true))
                .await
                .map_err(storage_error)?;
            emit(&self.out, events).await;
        }
        let task_owned = task.to_owned();
        let run = self
            .storage
            .call(move |s| {
                Ok(s.execution_snapshot(&task_owned)?
                    .latest_run
                    .ok_or(workpilot_storage::Error::NotFound)?
                    .run
                    .id)
            })
            .await
            .map_err(storage_error)?;
        let signals = Signals::default();
        let controls = signals.clone();
        let (storage, out, backend, namespace, slots, fault) = (
            self.storage.clone(),
            self.out.clone(),
            self.backend.clone(),
            self.namespace.clone(),
            self.slots.clone(),
            self.fault.clone(),
        );
        let task_for_review = task.to_owned();
        let tool_ledger = self.tool_ledger.clone();
        let handle = tokio::spawn(async move {
            let group_permit = tokio::select! {biased;_=controls.stop.cancelled()=>None,p=group.acquire_owned()=>p.ok()};
            let _group_permit = group_permit;
            let permit = tokio::select! {biased;_=controls.stop.cancelled()=>None,p=slots.acquire_owned()=>p.ok()};
            let Some(_permit) = permit else {
                if let Ok(events) = storage
                    .call(move |s| {
                        s.finish_execution(&run, TaskState::Interrupted, "user_stop", None)
                    })
                    .await
                {
                    emit(&out, events).await;
                }
                return;
            };
            let secret = match secret_for(&namespace, &profile, &storage).await {
                Ok(secret) => secret,
                Err(e) => {
                    if let Ok(events) = storage
                        .call(move |s| {
                            s.finish_execution(&run, TaskState::Failed, "credential_error", Some(e))
                        })
                        .await
                    {
                        emit(&out, events).await;
                    }
                    return;
                }
            };
            let task = task_for_review;
            let primary = profile.clone();
            let review_profile = storage
                .call(move |s| {
                    let policy = s.tool_settings(&task)?;
                    if policy.effective_permission != PermissionMode::AutoReview {
                        return Ok(None);
                    }
                    match policy.review_profile_id {
                        Some(id) => s.profile_with_observations(&id).map(Some),
                        None => Ok(Some(primary)),
                    }
                })
                .await;
            let reviewer = match review_profile {
                Ok(Some(p)) => Some(match secret_for(&namespace, &p, &storage).await {
                    Ok(secret) => Reviewer::Ready {
                        profile: Box::new(p),
                        secret,
                    },
                    Err(e) => Reviewer::Unavailable(e),
                }),
                Ok(None) => None,
                Err(e) => Some(Reviewer::Unavailable(storage_error(e))),
            };
            ExecutionEnvironment {
                reviewer,
                tool_ledger,
                storage,
                events: out,
                backend,
                run_id: run,
                profile,
                secret,
                signals: controls,
                fault: Observer { fault },
            }
            .execute()
            .await;
        });
        self.jobs.insert(task.into(), Job { signals, handle });
        Ok(Response::Receipt { receipt })
    }
    pub async fn shutdown(&mut self) {
        for job in self.jobs.values() {
            job.signals.stop.cancel();
        }
        for (_, mut job) in self.jobs.drain() {
            if tokio::time::timeout(std::time::Duration::from_millis(500), &mut job.handle)
                .await
                .is_err()
            {
                job.handle.abort();
            }
        }
    }
    async fn configure_tools(
        &mut self,
        request: &Request,
        task: &str,
        settings: &ToolSettings,
    ) -> Result<Response, ModelDiagnostic> {
        let mut settings = settings.clone();
        let identity = if let Some(path) = settings.root_path.clone() {
            let root = tokio::task::spawn_blocking(move || {
                workpilot_tools::files::Root::open(&path, None)
            })
            .await
            .map_err(|_| diagnostic::error(ModelErrorCode::Configuration))?
            .map_err(|e| {
                diagnostic::detail(
                    ModelErrorCode::Configuration,
                    &format!("无法授权这个项目目录：{e}"),
                )
            })?;
            settings.root_path = Some(root.path.to_string_lossy().into_owned());
            Some(root.identity)
        } else {
            None
        };
        let (req, task_owned) = (request.clone(), task.to_owned());
        let events = self
            .storage
            .call(move |s| s.configure_task_tools(&req, &task_owned, &settings, identity))
            .await
            .map_err(storage_error)?;
        // Changing the authorized scope invalidates queued actions and stops owned work.
        self.pause_tree(task).await?;
        emit(&self.out, events).await;
        Ok(receipt(request, task))
    }
    async fn approve_tool(
        &self,
        request: &Request,
        task: &str,
        id: &str,
        fingerprint: &str,
        approve: bool,
    ) -> Result<Response, ModelDiagnostic> {
        let (approval_id, task_id) = (id.to_owned(), task.to_owned());
        let (approval, policy, mode) = self
            .storage
            .call(move |s| {
                Ok((
                    s.tool_approval(&approval_id)?,
                    s.tool_settings(&task_id)?,
                    s.task(&task_id)?.mode,
                ))
            })
            .await
            .map_err(storage_error)?;
        if approval.task_id != task || approval.fingerprint != fingerprint {
            return Err(diagnostic::error(ModelErrorCode::Permission));
        }
        if approve {
            let saved = approval.intent.clone();
            let actual = tokio::task::spawn_blocking(move || {
                let call = ModelToolCall {
                    id: "approval-check".into(),
                    name: saved.tool.clone(),
                    arguments: saved.arguments.clone(),
                    provider_item_id: None,
                };
                workpilot_tools::prepare(&saved.task_id, &saved.action_id, &call, mode, &policy)
            })
            .await
            .map_err(|_| diagnostic::error(ModelErrorCode::Configuration))?
            .map_err(|_| {
                diagnostic::detail(
                    ModelErrorCode::Configuration,
                    "审批对象已变化，请继续任务重新检查；原操作没有执行。",
                )
            })?;
            if workpilot_policy::fingerprint(&actual.intent)
                .map_err(|_| diagnostic::error(ModelErrorCode::Configuration))?
                != fingerprint
            {
                return Err(diagnostic::detail(
                    ModelErrorCode::Permission,
                    "参数、文件版本或权限已变化，旧审批不能放行。",
                ));
            }
        }
        let (req, task, id, fingerprint) = (
            request.clone(),
            task.to_owned(),
            id.to_owned(),
            fingerprint.to_owned(),
        );
        let reply = receipt(request, &task);
        let events = self
            .storage
            .call(move |s| {
                s.decide_tool_approval(Some(&req), &id, &task, &fingerprint, approve, "user")
            })
            .await
            .map_err(storage_error)?;
        emit(&self.out, events).await;
        Ok(reply)
    }
}
async fn emit(out: &mpsc::Sender<Wire>, events: Vec<Event>) {
    for event in events {
        if out
            .send(Wire::Event {
                event: Box::new(event),
            })
            .await
            .is_err()
        {
            break;
        }
    }
}
fn receipt(request: &Request, task: &str) -> Response {
    Response::Receipt {
        receipt: Receipt {
            request_id: request.request_id.clone(),
            status: CommandStatus::Completed,
            task_id: Some(task.into()),
            duplicate: false,
        },
    }
}
