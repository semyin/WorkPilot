use super::*;
use workpilot_storage::now_ms;

impl Tasks {
    pub(super) async fn schedule_command(&mut self, request: &Request) -> Handled {
        let req = request.clone();
        let result = self
            .storage
            .call(move |s| s.schedule_action(&req, now_ms()))
            .await;
        let response = match result {
            Ok((mut data, events)) => {
                emit(&self.out, events).await;
                if let ScheduleData::Run { occurrence } = &data
                    && occurrence.state == "claimed"
                {
                    let id = occurrence.id.clone();
                    self.launch_schedule(&id).await;
                    match self.storage.call(move |s| s.schedule_occurrence(&id)).await {
                        Ok(o) => {
                            data = ScheduleData::Run {
                                occurrence: Box::new(o),
                            }
                        }
                        Err(e) => {
                            return Handled::Reply(Box::new(Response::Error {
                                code: e.code(),
                                message: e.to_string(),
                            }));
                        }
                    }
                }
                Response::Schedules { data }
            }
            Err(e) => Response::Error {
                code: e.code(),
                message: e.to_string(),
            },
        };
        Handled::Reply(Box::new(response))
    }
    pub async fn schedule_tick(&mut self) {
        let now = now_ms();
        let instant = std::time::Instant::now();
        let gap = self.schedule_clock.is_some_and(|(last, wall)| {
            instant.duration_since(last).as_millis() > 5000 || now.saturating_sub(wall) > 5000
        });
        self.schedule_clock = Some((instant, now));
        let result = self
            .storage
            .call(move |s| {
                if !gap {
                    return s.schedule_tick(now, None);
                }
                let mut events = vec![];
                loop {
                    let (_, batch) = s.schedule_tick(now, Some("clock_jump_or_resume"))?;
                    if batch.is_empty() {
                        break;
                    }
                    events.extend(batch);
                }
                Ok((vec![], events))
            })
            .await;
        match result {
            Ok((ids, events)) => {
                self.schedule_error = false;
                emit(&self.out, events).await;
                for id in ids {
                    self.schedule_fault("schedule_after_claim");
                    self.launch_schedule(&id).await;
                }
            }
            Err(e) => {
                if !self.schedule_error {
                    self.schedule_error = true;
                    if let Ok(event) = self
                        .storage
                        .call(move |s| {
                            s.append(
                                None,
                                None,
                                Payload::Error {
                                    code: e.code(),
                                    message: format!("定时检查失败 / Schedule polling failed: {e}"),
                                },
                            )
                        })
                        .await
                    {
                        emit(&self.out, vec![event]).await;
                    }
                }
            }
        }
    }
    fn schedule_fault(&self, point: &str) {
        if self.fault.as_deref() == Some(point) {
            std::process::exit(86);
        }
    }
    async fn launch_schedule(&mut self, id: &str) {
        self.schedule_fault("schedule_after_claim");
        let result: Result<(), ModelDiagnostic> = async {
            let saved = id.to_owned();
            let p = self
                .storage
                .call(move |s| s.schedule_dispatch_plan(&saved))
                .await
                .map_err(storage_error)?;
            let config = ExecutionConfig {
                title: format!("⏰ {}", p.spec.title),
                goal: p.spec.goal.clone(),
                constraints: vec![],
                project_rules: String::new(),
                project_id: p.spec.project_id.clone(),
                profile_id: Some(p.spec.profile_id.clone()),
                mode: p.spec.mode,
                controlled_tools: false,
                limits: ExecutionLimits::default(),
            };
            let req = Request {
                request_id: format!("schedule-create-{id}"),
                command: Command::CreateExecution {
                    config: Box::new(config.clone()),
                },
            };
            let occurrence = id.to_owned();
            let (receipt, events) = self
                .storage
                .call(move |s| s.create_scheduled_execution(&req, &config, &occurrence))
                .await
                .map_err(storage_error)?;
            emit(&self.out, events).await;
            self.schedule_fault("schedule_after_create");
            let task = receipt
                .task_id
                .ok_or_else(|| diagnostic::error(ModelErrorCode::Configuration))?;
            let (occ, t) = (id.to_owned(), task.clone());
            let events = self
                .storage
                .call(move |s| s.schedule_attach(&occ, &t))
                .await
                .map_err(storage_error)?;
            emit(&self.out, events).await;
            let (path, identity) = if let Some(project) = p.spec.project_id {
                let (project, identity) = self
                    .storage
                    .call(move |s| s.project_creation_defaults(&project))
                    .await
                    .map_err(storage_error)?;
                let expected = identity.ok_or_else(|| {
                    diagnostic::detail(
                        ModelErrorCode::Configuration,
                        "请重新保存项目，确认实际目录 / Save the project to confirm its directory",
                    )
                })?;
                let root = tokio::task::spawn_blocking(move || {
                    workpilot_tools::files::Root::open(&project.settings.root_path, Some(&expected))
                })
                .await
                .map_err(|_| diagnostic::error(ModelErrorCode::Configuration))?
                .map_err(|e| {
                    diagnostic::detail(
                        ModelErrorCode::Configuration,
                        &format!(
                            "项目目录已变化或不可用 / Project directory changed or unavailable: {e}"
                        ),
                    )
                })?;
                (
                    Some(root.path.to_string_lossy().into_owned()),
                    Some(root.identity),
                )
            } else {
                (None, None)
            };
            let settings = ToolSettings {
                root_path: path,
                permission: Some(p.spec.permission),
                review_profile_id: p.spec.review_profile_id,
                commands_enabled: p.spec.commands_enabled,
                revision: 0,
            };
            let req = Request {
                request_id: format!("schedule-tools-{id}"),
                command: Command::ConfigureTaskTools {
                    task_id: task.clone(),
                    settings: settings.clone(),
                },
            };
            let t = task.clone();
            let events = self
                .storage
                .call(move |s| s.configure_task_tools(&req, &t, &settings, identity))
                .await
                .map_err(storage_error)?;
            emit(&self.out, events).await;
            let req = Request {
                request_id: format!("schedule-start-{id}"),
                command: Command::StartExecution {
                    task_id: task.clone(),
                },
            };
            self.start(&req, &task, true).await?;
            self.schedule_fault("schedule_after_start");
            Ok(())
        }
        .await;
        let err = result.err().map(|e| {
            format!(
                "{} / {}{}",
                e.message_zh,
                e.message_en,
                e.detail.map(|d| format!(": {d}")).unwrap_or_default()
            )
        });
        let id = id.to_owned();
        if let Ok(events) = self
            .storage
            .call(move |s| s.schedule_finish_dispatch(&id, err.as_deref()))
            .await
        {
            emit(&self.out, events).await;
        }
    }
}
