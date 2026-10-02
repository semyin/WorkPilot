use super::*;
impl Tasks {
    pub(super) async fn team_command(
        &mut self,
        request: &Request,
    ) -> Option<Result<Response, ModelDiagnostic>> {
        let task = match &request.command {
            Command::ConfigureTeam { task_id, .. }
            | Command::AddTeamMembers { task_id, .. }
            | Command::OverrideTeamMember { task_id, .. }
            | Command::ReplaceTeamMember { task_id, .. }
            | Command::ReviewTeamMember { task_id, .. } => Some(task_id.clone()),
            Command::ConfigureScheduler { .. } => None,
            _ => return None,
        };
        let result = async {
            let req = request.clone();
            if let Some(r) = self
                .storage
                .call(move |s| s.cached_receipt(&req))
                .await
                .map_err(storage_error)?
            {
                return Ok(Response::Receipt { receipt: r });
            }
            if matches!(request.command, Command::ConfigureScheduler { .. })
                && !self.jobs.is_empty()
            {
                return Err(diagnostic::detail(
                    ModelErrorCode::Configuration,
                    "请先停止运行中的任务，再调整全局并发上限",
                ));
            }
            if let Command::ConfigureTeam { task_id, .. } = &request.command {
                let task = task_id.clone();
                let ids = self
                    .storage
                    .call(move |s| s.team_subtree(&task))
                    .await
                    .map_err(storage_error)?;
                if ids.iter().any(|id| self.jobs.contains_key(id)) {
                    return Err(diagnostic::detail(
                        ModelErrorCode::Configuration,
                        "请先停止本团队，再调整团队上限",
                    ));
                }
            }
            let req = request.clone();
            let events = self
                .storage
                .call(move |s| match &req.command {
                    Command::ConfigureTeam { task_id, settings } => {
                        s.configure_team(&req, task_id, settings)
                    }
                    Command::ConfigureScheduler { settings } => {
                        s.configure_scheduler(&req, settings)
                    }
                    Command::AddTeamMembers { task_id, members } => {
                        let (_, events) =
                            s.delegate_members(task_id, members, None, None, Some(&req))?;
                        Ok(events)
                    }
                    Command::OverrideTeamMember {
                        task_id,
                        member_id,
                        spec,
                    } => s.override_member(task_id, member_id, spec, Some(&req)),
                    Command::ReplaceTeamMember {
                        task_id,
                        member_id,
                        profile_id,
                        reason,
                    } => {
                        let (_, events) = s.replace_member(
                            task_id,
                            member_id,
                            profile_id.as_deref(),
                            reason,
                            None,
                            Some(&req),
                        )?;
                        Ok(events)
                    }
                    Command::ReviewTeamMember {
                        task_id,
                        member_id,
                        report_id,
                        accept,
                        reason,
                    } => {
                        s.review_member(task_id, member_id, report_id, *accept, reason, Some(&req))
                    }
                    _ => Err(workpilot_storage::Error::Invalid("unknown team control")),
                })
                .await
                .map_err(storage_error)?;
            if let Command::ConfigureScheduler { settings } = &request.command {
                self.slots = Arc::new(Semaphore::new(settings.max_running as usize));
            }
            if let Command::ConfigureTeam { task_id, .. } = &request.command {
                self.root_slots.remove(task_id);
            }
            emit(&self.out, events).await;
            Ok(Response::Receipt {
                receipt: Receipt {
                    request_id: request.request_id.clone(),
                    status: CommandStatus::Completed,
                    task_id: task,
                    duplicate: false,
                },
            })
        }
        .await;
        Some(result)
    }
    pub async fn tick(&mut self) {
        self.jobs.retain(|_, job| !job.handle.is_finished());
        self.root_slots
            .retain(|_, slots| Arc::strong_count(slots) > 1);
        if let Ok(events) = self.storage.call(|s| s.team_publish_reports()).await {
            emit(&self.out, events).await;
        }
        let running: Vec<_> = self.jobs.keys().cloned().collect();
        let stopped = self
            .storage
            .call(move |s| {
                running
                    .into_iter()
                    .filter_map(|id| match s.team_enabled(&id) {
                        Ok(false) => Some(Ok(id)),
                        Ok(true) => None,
                        Err(e) => Some(Err(e)),
                    })
                    .collect::<workpilot_storage::Result<Vec<_>>>()
            })
            .await;
        if let Ok(ids) = stopped {
            for id in ids {
                if let Some(job) = self.jobs.get(&id) {
                    job.signals.stop.cancel();
                }
            }
        }
        let Ok(candidates) = self.storage.call(|s| s.team_schedule_candidates()).await else {
            return;
        };
        for task in candidates.into_iter().take(32) {
            if self.jobs.len() >= 32 {
                break;
            }
            if self.jobs.contains_key(&task) {
                continue;
            }
            let request = Request {
                request_id: uuid::Uuid::new_v4().to_string(),
                command: Command::StartExecution {
                    task_id: task.clone(),
                },
            };
            if let Err(diagnostic) = self.start(&request, &task, false).await
                && let Ok(events) = self
                    .storage
                    .call(move |s| s.team_dispatch_failed(&task, diagnostic))
                    .await
            {
                emit(&self.out, events).await;
            }
        }
    }
    pub(super) async fn pause_tree(&mut self, task: &str) -> Result<(), ModelDiagnostic> {
        let task = task.to_owned();
        let (ids, events) = self
            .storage
            .call(move |s| {
                let ids = s.team_subtree(&task)?;
                let events = s.team_set_enabled(&task, false, true)?;
                Ok((ids, events))
            })
            .await
            .map_err(storage_error)?;
        for id in ids {
            if let Some(job) = self.jobs.get(&id) {
                job.signals.stop.cancel();
            }
        }
        emit(&self.out, events).await;
        Ok(())
    }
    pub(super) async fn cancel_tree(
        &mut self,
        request: &Request,
        task: &str,
    ) -> Result<Response, ModelDiagnostic> {
        let (req, task) = (request.clone(), task.to_owned());
        let (receipt, events, ids) = self
            .storage
            .call(move |s| {
                if let Some(r) = s.cached_receipt(&req)? {
                    return Ok((r, vec![], vec![]));
                }
                let ids = s.team_subtree(&task)?;
                let (receipt, mut events) = s.cancel_execution(&req, &task)?;
                for child in ids.iter().filter(|id| **id != task) {
                    let state = s.task(child)?.state;
                    if matches!(
                        state,
                        TaskState::Completed | TaskState::Failed | TaskState::Interrupted
                    ) {
                        continue;
                    }
                    let r = Request {
                        request_id: uuid::Uuid::new_v4().to_string(),
                        command: Command::Cancel {
                            task_id: child.clone(),
                        },
                    };
                    events.extend(s.cancel_execution(&r, child)?.1);
                }
                Ok((receipt, events, ids))
            })
            .await
            .map_err(storage_error)?;
        for id in ids {
            if let Some(job) = self.jobs.get(&id) {
                job.signals.stop.cancel();
            }
        }
        emit(&self.out, events).await;
        Ok(Response::Receipt { receipt })
    }
}
