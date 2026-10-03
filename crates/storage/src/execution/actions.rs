//! Tool action effects, completion and manual reconciliation.
use super::*;

impl Store {
    pub fn begin_execution_action(&mut self, run: &str, action: &str) -> Result<Vec<Event>> {
        let execution = self.execution_run(run)?;
        let step = self.execution_step(action)?;
        let tool = id();
        let tx = self.connection.transaction()?;
        guard_action(&tx, run, action)?;
        if tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM messages WHERE task_id=?1 AND state='steer_requested')",
            [&execution.run.task_id],
            |r| r.get::<_, bool>(0),
        )? {
            return Err(Error::Busy);
        }
        tx.execute("INSERT INTO tool_calls(id,task_id,run_id,agent_id,name,state,input_object_id,started_at_ms) VALUES(?1,?2,?3,?4,?5,'started',?6,?7)",
            params![tool,execution.run.task_id,run,execution.run.agent_id,step.name,step.input.object_id,now_ms()])?;
        if tx.execute("UPDATE execution_steps SET state='running',started_at_ms=?2,tool_call_id=?3 WHERE id=?1 AND state='prepared'",params![action,now_ms(),tool])?!=1{return Err(Error::Conflict);}
        tx.execute(
            "UPDATE execution_runs SET steps=steps+1 WHERE run_id=?1",
            [run],
        )?;
        let event = record(
            &tx,
            &self.redactor,
            Some(&execution.run.task_id),
            None,
            EventSource::Tool,
            Payload::ToolStarted {
                tool_call_id: tool,
                name: step.name,
                input: step.input,
            },
        )?;
        tx.commit()?;
        Ok(vec![event])
    }
    /// Only this synthetic tool writes here; it never writes a project file.
    pub fn apply_controlled_effect(
        &mut self,
        run: &str,
        action: &str,
        name: &str,
        text: &str,
    ) -> Result<ModelToolResult> {
        let step = self.execution_step(action)?;
        let execution = self.execution_run(run)?;
        let result = ModelToolResult {
            call_id: step.provider_call_id.clone().ok_or(Error::Conflict)?,
            output: encode(&json!({"sample_only":true,"name":name,"content":text}))?,
            is_error: false,
        };
        let content = self.save_json(serde_json::to_value(&result)?)?;
        let tx = self.connection.transaction()?;
        guard_action(&tx, run, action)?;
        let running: bool = tx.query_row(
            "SELECT state='running' FROM execution_steps WHERE id=?1",
            [action],
            |r| r.get(0),
        )?;
        if !running {
            return Err(Error::Conflict);
        }
        tx.execute("INSERT INTO controlled_effects(action_id,session_id,name,output_object_id,created_at_ms) VALUES(?1,?2,?3,?4,?5)",params![action,execution.session_id,name,content.object_id,now_ms()])?;
        tx.commit()?;
        Ok(result)
    }
    pub fn controlled_effect(&self, action: &str) -> Result<Option<ModelToolResult>> {
        let reference: Option<String> = self
            .connection
            .query_row(
                "SELECT output_object_id FROM controlled_effects WHERE action_id=?1",
                [action],
                |r| r.get(0),
            )
            .optional()?;
        reference
            .map(|id| self.read_json(&content_ref(&self.connection, &id)?))
            .transpose()
    }
    pub fn read_controlled_sample(&self, run: &str, name: &str) -> Result<Option<ModelToolResult>> {
        let execution = self.execution_run(run)?;
        let reference:Option<String>=self.connection.query_row("SELECT output_object_id FROM controlled_effects WHERE session_id=?1 AND name=?2 ORDER BY created_at_ms DESC,rowid DESC LIMIT 1",params![execution.session_id,name],|r|r.get(0)).optional()?;
        reference
            .map(|id| self.read_json(&content_ref(&self.connection, &id)?))
            .transpose()
    }
    pub fn complete_execution_action(
        &mut self,
        run: &str,
        action: &str,
        result: &ModelToolResult,
        plan: Option<Vec<PlanStep>>,
        question: Option<InputQuestion>,
        source: &str,
    ) -> Result<Vec<Event>> {
        let execution = self.execution_run(run)?;
        let step = self.execution_step(action)?;
        let mut context = self.execution_snapshot(&execution.run.task_id)?.context;
        let pending = context.pending.as_mut().ok_or(Error::Conflict)?;
        if pending
            .action_ids
            .get(pending.next as usize)
            .map(String::as_str)
            != Some(action)
            || step.provider_call_id.as_deref() != Some(&result.call_id)
        {
            return Err(Error::Conflict);
        }
        let output = self.save_json(serde_json::to_value(result)?)?;
        pending.results.push(result.clone());
        pending.next += 1;
        context.sources.push(ContextSource {
            step_id: action.into(),
            summary: if step.name == "memory_search" {
                "memory_search: historical search only; reload current memories before using preferences".into()
            } else { format!(
                "{}: {}",
                step.name,
                result.output.chars().take(160).collect::<String>()
            ) },
            output: output.clone(),
            tool_call_ids: vec![result.call_id.clone()],
        });
        if let Some(plan) = &plan {
            context.plan = plan.clone();
        }
        if let Some(question) = &question {
            context.question = Some(question.clone());
        }
        if pending.next as usize == pending.action_ids.len() {
            let pending = context.pending.take().unwrap();
            context.history.push(ModelHistoryItem::Exchange {
                continuation: pending.response.continuation,
                tool_results: pending.results,
            });
        }
        let content = self.save_json(serde_json::to_value(&context)?)?;
        let tx = self.connection.transaction()?;
        guard_action(&tx, run, action)?;
        if !matches!(
            step.state,
            ExecutionStepState::Running
                | ExecutionStepState::NeedsReview
                | ExecutionStepState::Prepared
        ) {
            return Err(Error::Conflict);
        }
        let status = if source == "steer" {
            ExecutionStepState::Skipped
        } else if result.is_error {
            ExecutionStepState::Failed
        } else {
            ExecutionStepState::Completed
        };
        tx.execute(
            "UPDATE execution_steps SET state=?2,output_object_id=?3,ended_at_ms=?4 WHERE id=?1",
            params![action, word(&status)?, output.object_id, now_ms()],
        )?;
        let mut events = vec![];
        if let Some(tool) = step.tool_call_id {
            let state = if result.is_error {
                ToolState::Failed
            } else {
                ToolState::Succeeded
            };
            tx.execute("UPDATE tool_calls SET state=?2,output_object_id=?3,ended_at_ms=?4 WHERE id=?1 AND state IN ('started','needs_review')",params![tool,word(&state)?,output.object_id,now_ms()])?;
            events.push(record(
                &tx,
                &self.redactor,
                Some(&execution.run.task_id),
                None,
                EventSource::Tool,
                Payload::ToolFinished {
                    tool_call_id: tool,
                    state,
                    output: output.clone(),
                },
            )?);
        }
        events.push(record(
            &tx,
            &self.redactor,
            Some(&execution.run.task_id),
            None,
            EventSource::Tool,
            Payload::ExecutionStepChanged {
                run_id: run.into(),
                step_id: action.into(),
                name: step.name,
                state: status,
                input: None,
                output: Some(output),
            },
        )?);
        if source == "receipt" || source == "user" {
            events.push(record(
                &tx,
                &self.redactor,
                Some(&execution.run.task_id),
                None,
                EventSource::Recovery,
                Payload::ActionReconciled {
                    action_id: action.into(),
                    resolution_source: source.into(),
                },
            )?);
        }
        if let Some(steps) = plan {
            events.push(record(
                &tx,
                &self.redactor,
                Some(&execution.run.task_id),
                None,
                EventSource::Engine,
                Payload::PlanUpdated { steps },
            )?);
        }
        if let Some(question) = question {
            events.push(record(
                &tx,
                &self.redactor,
                Some(&execution.run.task_id),
                None,
                EventSource::Engine,
                Payload::InputRequested { question },
            )?);
        }
        events.push(checkpoint(
            &tx,
            &self.redactor,
            run,
            &content,
            "tool_result_saved",
        )?);
        tx.commit()?;
        Ok(events)
    }
    pub fn resolve_execution_action(
        &mut self,
        request: &Request,
        task: &str,
        action: &str,
        resolution: &ActionResolution,
    ) -> Result<Vec<Event>> {
        if self.cached_receipt(request)?.is_some() {
            return Ok(vec![]);
        }
        let snapshot = self.execution_snapshot(task)?;
        let step = self.execution_step(action)?;
        if matches!(
            snapshot.task.state,
            TaskState::Running | TaskState::Stopping | TaskState::Queued
        ) || step.state != ExecutionStepState::NeedsReview
            || !snapshot.context.pending.as_ref().is_some_and(|p| {
                p.action_ids.get(p.next as usize).map(String::as_str) == Some(action)
            })
        {
            return Err(Error::Conflict);
        }
        if self.controlled_effect(action)?.is_some() {
            return Err(Error::Invalid(
                "a saved effect receipt already exists; continue to reconcile",
            ));
        }
        let output = match resolution {
            ActionResolution::Applied { output } => ModelToolResult {
                call_id: step.provider_call_id.clone().ok_or(Error::Conflict)?,
                output: output.clone(),
                is_error: false,
            },
            ActionResolution::NotApplied => ModelToolResult {
                call_id: step.provider_call_id.clone().ok_or(Error::Conflict)?,
                output: "User confirmed this action was not applied.".into(),
                is_error: true,
            },
        };
        let content = self.save_json(serde_json::to_value(&output)?)?;
        let tx = self.connection.transaction()?;
        let mut events = accept_command(&tx, &self.redactor, request, Some(task))?;
        match resolution {
            ActionResolution::Applied { .. } => {
                tx.execute("INSERT INTO execution_resolutions(action_id,output_object_id,request_id) VALUES(?1,?2,?3)",params![action,content.object_id,request.request_id])?;
            }
            ActionResolution::NotApplied => {
                if let Some(tool) = step.tool_call_id {
                    tx.execute("UPDATE tool_calls SET state='failed',output_object_id=?2,ended_at_ms=?3 WHERE id=?1",params![tool,content.object_id,now_ms()])?;
                    events.push(record(
                        &tx,
                        &self.redactor,
                        Some(task),
                        Some(&request.request_id),
                        EventSource::User,
                        Payload::ToolFinished {
                            tool_call_id: tool,
                            state: ToolState::Failed,
                            output: content,
                        },
                    )?);
                }
                tx.execute("UPDATE execution_steps SET state='prepared',tool_call_id=NULL,started_at_ms=NULL,ended_at_ms=NULL WHERE id=?1",[action])?;
            }
        }
        events.push(record(
            &tx,
            &self.redactor,
            Some(task),
            Some(&request.request_id),
            EventSource::User,
            Payload::ActionReconciled {
                action_id: action.into(),
                resolution_source: if matches!(resolution, ActionResolution::NotApplied) {
                    "user_not_applied"
                } else {
                    "user_reported_result"
                }
                .into(),
            },
        )?);
        events.extend(finish_control_tx(&tx, &self.redactor, request, task)?);
        tx.commit()?;
        Ok(events)
    }
    pub fn execution_action_receipt(
        &self,
        action: &str,
    ) -> Result<Option<(ModelToolResult, String)>> {
        if let Some(result) = self.controlled_effect(action)? {
            return Ok(Some((result, "receipt".into())));
        }
        let object: Option<String> = self
            .connection
            .query_row(
                "SELECT output_object_id FROM execution_resolutions WHERE action_id=?1",
                [action],
                |r| r.get(0),
            )
            .optional()?;
        object
            .map(|id| {
                Ok((
                    self.read_json(&content_ref(&self.connection, &id)?)?,
                    "user".into(),
                ))
            })
            .transpose()
    }
}
