//! Basic task commands and synthetic probe completion.
use super::*;

impl Store {
    pub fn apply(&mut self, request: &Request) -> Result<(Receipt, Vec<Event>)> {
        request.validate().map_err(Error::Invalid)?;
        if !matches!(
            request.command,
            Command::Ping
                | Command::StartProbe { .. }
                | Command::Stop
                | Command::CreateTask { .. }
                | Command::Enqueue { .. }
                | Command::Steer { .. }
                | Command::Cancel { .. }
                | Command::DeleteTask { .. }
        ) {
            return Err(Error::Invalid("not a mutation"));
        }
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&request.command)?)
        );
        let existing = self
            .connection
            .query_row(
                "SELECT fingerprint,status,task_id FROM commands WHERE request_id=?1",
                [&request.request_id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional()?;
        if let Some((old, status, task_id)) = existing {
            if old != fingerprint {
                return Err(Error::Conflict);
            }
            return Ok((
                Receipt {
                    request_id: request.request_id.clone(),
                    status: parse_word(status)?,
                    task_id,
                    duplicate: true,
                },
                vec![],
            ));
        }
        let kind = serde_json::to_value(&request.command)?["kind"]
            .as_str()
            .unwrap()
            .to_owned();
        if self.redactor.text(&request.request_id) != request.request_id {
            return Err(Error::Invalid("secret in request identity"));
        }
        let new_task = matches!(
            request.command,
            Command::CreateTask { .. } | Command::StartProbe { .. }
        );
        let task_id = match &request.command {
            Command::CreateTask { .. } | Command::StartProbe { .. } => Some(id()),
            Command::Enqueue { task_id, .. }
            | Command::Steer { task_id, .. }
            | Command::Cancel { task_id }
            | Command::DeleteTask { task_id } => Some(task_id.clone()),
            _ => None,
        };
        if !new_task && let Some(task_id) = &task_id {
            self.task(task_id)?;
        }
        let deleting = if let Command::DeleteTask { task_id } = &request.command {
            if self.member_parent(task_id)?.is_some() {
                return Err(Error::Invalid(
                    "请从主任务删除整组协作记录 / Delete the group from its main task",
                ));
            }
            self.team_subtree(task_id)?
        } else {
            Vec::new()
        };
        let queued = if let Command::Enqueue { text, .. } = &request.command {
            let count:u32=self.connection.query_row("SELECT count(*) FROM messages WHERE task_id=?1 AND state IN ('queued','steer_requested')",[&task_id],|r|r.get(0))?;
            if count >= 128 {
                return Err(Error::Invalid("message queue is full"));
            }
            Some(self.text(text)?)
        } else {
            None
        };
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut events = vec![];
        let mut result = CommandStatus::Completed;
        let stamp = now_ms();
        if new_task {
            let (title, project, state) = match &request.command {
                Command::CreateTask { title, project_id } => {
                    (title.clone(), project_id.clone(), TaskState::Queued)
                }
                _ => ("P01 persistence probe".into(), None, TaskState::Running),
            };
            tx.execute("INSERT INTO tasks(id,project_id,title,state,mode,permission,created_at_ms,updated_at_ms) VALUES(?1,?2,?3,?4,'execute','request_approval',?5,?5)",
                params![task_id,project,self.redactor.text(&title),word(&state)?,stamp])?;
        }
        tx.execute("INSERT INTO commands(request_id,fingerprint,command_kind,status,task_id,accepted_at_ms) VALUES(?1,?2,?3,'accepted',?4,?5)",
            params![request.request_id,fingerprint,kind,task_id,stamp])?;
        events.push(record(
            &tx,
            &self.redactor,
            task_id.as_deref(),
            Some(&request.request_id),
            EventSource::User,
            Payload::CommandAccepted { command_kind: kind },
        )?);
        match &request.command {
            Command::CreateTask { title, .. } => events.push(record(
                &tx,
                &self.redactor,
                task_id.as_deref(),
                Some(&request.request_id),
                EventSource::Engine,
                Payload::TaskCreated {
                    title: title.clone(),
                },
            )?),
            Command::StartProbe { ticks, .. } => {
                let run = id();
                tx.execute(
                    "INSERT INTO runs(id,task_id,state,started_at_ms) VALUES(?1,?2,'running',?3)",
                    params![run, task_id, stamp],
                )?;
                result = CommandStatus::Accepted;
                events.push(record(
                    &tx,
                    &self.redactor,
                    task_id.as_deref(),
                    Some(&request.request_id),
                    EventSource::Engine,
                    Payload::ProbeStarted { ticks: *ticks },
                )?);
            }
            Command::Enqueue { task_id, .. } => {
                let message = id();
                let content = queued.unwrap();
                tx.execute("INSERT INTO messages(id,task_id,role,state,queue_position,object_id,created_at_ms) SELECT ?1,?2,'user','queued',COALESCE(MAX(queue_position),0)+1,?3,?4 FROM messages WHERE task_id=?2",
                    params![message, task_id, content.object_id, stamp])?;
                events.push(record(
                    &tx,
                    &self.redactor,
                    Some(task_id),
                    Some(&request.request_id),
                    EventSource::User,
                    Payload::MessageQueued {
                        message_id: message,
                        content,
                    },
                )?);
            }
            Command::Steer {
                task_id,
                message_id,
            } => {
                if tx.execute("UPDATE messages SET state='steer_requested' WHERE id=?1 AND task_id=?2 AND state='queued'", params![message_id,task_id])? != 1 { return Err(Error::Conflict); }
                events.push(record(
                    &tx,
                    &self.redactor,
                    Some(task_id),
                    Some(&request.request_id),
                    EventSource::User,
                    Payload::MessageSteered {
                        message_id: message_id.clone(),
                    },
                )?);
            }
            Command::Cancel { task_id } => {
                let active: bool = tx.query_row("SELECT state IN ('running','awaiting_input','awaiting_approval','queued') FROM tasks WHERE id=?1", [task_id], |r| r.get(0))?;
                if !active {
                    return Err(Error::Conflict);
                }
                tx.execute(
                    "UPDATE tasks SET state='stopping',updated_at_ms=?2 WHERE id=?1",
                    params![task_id, stamp],
                )?;
                events.push(record(
                    &tx,
                    &self.redactor,
                    Some(task_id),
                    Some(&request.request_id),
                    EventSource::User,
                    Payload::CancelRequested,
                )?);
                // Persists intent only; P03 dispatches cancellation to actual work.
            }
            Command::DeleteTask { task_id } => {
                let scheduling: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM team_control WHERE task_id=?1 AND enabled=1)",
                    [task_id],
                    |r| r.get(0),
                )?;
                if scheduling {
                    return Err(Error::Conflict);
                }
                for id in &deleting {
                    let unsafe_delete: bool = tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?1 AND state IN ('running','stopping'))
                        OR EXISTS(SELECT 1 FROM runs WHERE task_id=?1 AND state IN ('queued','running'))
                        OR EXISTS(SELECT 1 FROM tool_calls WHERE task_id=?1 AND state IN ('started','needs_review'))
                        OR EXISTS(SELECT 1 FROM workbench_operations WHERE task_id=?1 AND json_extract(data_json,'$.state') IN ('queued','running','stopping'))",
                        [id], |r| r.get(0))?;
                    if unsafe_delete {
                        return Err(Error::Conflict);
                    }
                }
                super::maintenance::deletion::delete_groups(&tx, &deleting)?;
                events.clear(); // Cascaded task events cannot be delivered as still-existing records.
            }
            Command::Ping => events.push(record(
                &tx,
                &self.redactor,
                None,
                Some(&request.request_id),
                EventSource::Engine,
                Payload::Pong,
            )?),
            Command::Stop => result = CommandStatus::Accepted,
            _ => unreachable!(),
        }
        if result != CommandStatus::Accepted {
            tx.execute(
                "UPDATE commands SET status=?2,finished_at_ms=?3 WHERE request_id=?1",
                params![request.request_id, word(&result)?, stamp],
            )?;
            let event_task = if matches!(request.command, Command::DeleteTask { .. }) {
                None
            } else {
                task_id.as_deref()
            };
            events.push(record(
                &tx,
                &self.redactor,
                event_task,
                Some(&request.request_id),
                EventSource::Engine,
                Payload::CommandFinished { status: result },
            )?);
        }
        tx.commit()?;
        Ok((
            Receipt {
                request_id: request.request_id.clone(),
                status: result,
                task_id,
                duplicate: false,
            },
            events,
        ))
    }
    pub fn finish_probe(
        &mut self,
        task: &str,
        request: &str,
        completed: bool,
    ) -> Result<Vec<Event>> {
        self.finish_probe_inner(task, request, completed, || {})
    }
    pub fn finish_control(&mut self, request: &str) -> Result<Vec<Event>> {
        let tx = self.connection.transaction()?;
        if tx.execute("UPDATE commands SET status='completed',finished_at_ms=?2 WHERE request_id=?1 AND status='accepted'",params![request,now_ms()])?!=1 {return Err(Error::Conflict);}
        let events = vec![
            record(
                &tx,
                &self.redactor,
                None,
                Some(request),
                EventSource::Engine,
                Payload::Pong,
            )?,
            record(
                &tx,
                &self.redactor,
                None,
                Some(request),
                EventSource::Engine,
                Payload::CommandFinished {
                    status: CommandStatus::Completed,
                },
            )?,
        ];
        tx.commit()?;
        Ok(events)
    }
    pub(super) fn finish_probe_inner(
        &mut self,
        task: &str,
        request: &str,
        completed: bool,
        between_writes: impl FnOnce(),
    ) -> Result<Vec<Event>> {
        let state = if completed {
            TaskState::Completed
        } else {
            TaskState::Interrupted
        };
        let command_state = if completed {
            CommandStatus::Completed
        } else {
            CommandStatus::Interrupted
        };
        let result = self.text(if completed {
            "Synthetic probe completed."
        } else {
            "Synthetic probe interrupted."
        })?;
        let tx = self.connection.transaction()?;
        let owned:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM commands WHERE request_id=?1 AND task_id=?2 AND status='accepted' AND command_kind='start_probe')",params![request,task],|r|r.get(0))?;
        if !owned {
            return Err(Error::Conflict);
        }
        if completed {
            let unresolved:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM tool_calls WHERE task_id=?1 AND state IN ('started','needs_review'))",[task],|r|r.get(0))?;
            if unresolved {
                return Err(Error::Conflict);
            }
        }
        // Completing the state, recording a result, and emitting events are one atomic unit.
        if tx.execute("UPDATE runs SET state=?2,ended_at_ms=?3,result_object_id=?4 WHERE task_id=?1 AND state='running'",
            params![task,word(&state)?,now_ms(),result.object_id])? != 1 {return Err(Error::Conflict);}
        tx.execute(
            "UPDATE tasks SET state=?2,updated_at_ms=?3 WHERE id=?1",
            params![task, word(&state)?, now_ms()],
        )?;
        between_writes();
        let events = vec![
            record(
                &tx,
                &self.redactor,
                Some(task),
                Some(request),
                EventSource::Engine,
                Payload::ProbeEnded {
                    reason: word(&state)?,
                },
            )?,
            record(
                &tx,
                &self.redactor,
                Some(task),
                Some(request),
                EventSource::Engine,
                Payload::TaskStateChanged {
                    state,
                    reason: None,
                },
            )?,
            record(
                &tx,
                &self.redactor,
                Some(task),
                Some(request),
                EventSource::Engine,
                Payload::CommandFinished {
                    status: command_state,
                },
            )?,
        ];
        tx.execute(
            "UPDATE commands SET status=?2,finished_at_ms=?3 WHERE request_id=?1",
            params![request, word(&command_state)?, now_ms()],
        )?;
        tx.commit()?;
        Ok(events)
    }
}
