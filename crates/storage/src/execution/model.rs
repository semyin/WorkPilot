//! Model steps, message delivery and durable execution context.
use super::*;

impl Store {
    pub fn save_execution_context(
        &mut self,
        run: &str,
        context: &ExecutionContext,
        phase: &str,
    ) -> Result<Vec<Event>> {
        let content = self.save_json(serde_json::to_value(context)?)?;
        let tx = self.connection.transaction()?;
        guard(&tx, run, &["running"])?;
        let event = checkpoint(&tx, &self.redactor, run, &content, phase)?;
        tx.commit()?;
        Ok(vec![event])
    }
    pub fn deliver_execution_messages(
        &mut self,
        run: &str,
        steer_only: bool,
    ) -> Result<(ExecutionContext, Vec<Event>)> {
        let execution = self.execution_run(run)?;
        let snapshot = self.execution_snapshot(&execution.run.task_id)?;
        let mut messages: Vec<_> = snapshot
            .messages
            .into_iter()
            .filter(|m| {
                m.state == MessageState::SteerRequested
                    || (!steer_only && m.state == MessageState::Queued)
            })
            .collect();
        messages.sort_by_key(|m| (m.state != MessageState::SteerRequested, m.queue_position));
        let mut context = snapshot.context;
        let mut delivered = vec![];
        // A bounded batch is committed with the checkpoint. Delivery survives crashes exactly once.
        for message in messages.into_iter().take(16) {
            let text = self.read_text_value(&message.content)?;
            if context.directions.len() >= 256 {
                return Err(Error::Invalid("too many pinned user directions"));
            }
            context.directions.push(UserDirection {
                message_id: message.id.clone(),
                text: text.clone(),
                steered: message.state == MessageState::SteerRequested,
            });
            context.history.push(ModelHistoryItem::Message {
                message: ModelMessage {
                    role: "user".into(),
                    content: vec![ModelContent::Text { text }],
                },
            });
            context.question = None;
            delivered.push(message);
        }
        if delivered.is_empty() {
            return Ok((context, vec![]));
        }
        let content = self.save_json(serde_json::to_value(&context)?)?;
        let tx = self.connection.transaction()?;
        guard(&tx, run, &["running"])?;
        let mut events = vec![];
        for message in delivered {
            if tx.execute("UPDATE messages SET state='delivered' WHERE id=?1 AND state IN ('queued','steer_requested')",[&message.id])?!=1{return Err(Error::Conflict);}
            events.push(record(
                &tx,
                &self.redactor,
                Some(&execution.run.task_id),
                None,
                EventSource::User,
                Payload::MessageDelivered {
                    message_id: message.id,
                    run_id: run.into(),
                    steered: message.state == MessageState::SteerRequested,
                },
            )?);
        }
        events.push(checkpoint(
            &tx,
            &self.redactor,
            run,
            &content,
            "messages_delivered",
        )?);
        tx.commit()?;
        Ok((context, events))
    }
    pub fn has_execution_messages(&self, task: &str, steer_only: bool) -> Result<bool> {
        Ok(self.connection.query_row("SELECT EXISTS(SELECT 1 FROM messages WHERE task_id=?1 AND (state='steer_requested' OR (?2=0 AND state='queued')))",params![task,steer_only],|r|r.get(0))?)
    }
    pub fn begin_execution_model(
        &mut self,
        run: &str,
        input: &ModelInput,
    ) -> Result<(String, Vec<Event>)> {
        let content = self.save_json(serde_json::to_value(input)?)?;
        let execution = self.execution_run(run)?;
        let step = id();
        let tx = self.connection.transaction()?;
        guard(&tx, run, &["running"])?;
        tx.execute("INSERT INTO execution_steps(id,run_id,ordinal,kind,name,state,input_object_id,started_at_ms) SELECT ?1,?2,COALESCE(MAX(ordinal),0)+1,'model','model','running',?3,?4 FROM execution_steps WHERE run_id=?2",params![step,run,content.object_id,now_ms()])?;
        tx.execute(
            "UPDATE execution_runs SET steps=steps+1 WHERE run_id=?1",
            [run],
        )?;
        let event = record(
            &tx,
            &self.redactor,
            Some(&execution.run.task_id),
            None,
            EventSource::Provider,
            Payload::ExecutionStepChanged {
                run_id: run.into(),
                step_id: step.clone(),
                name: "model".into(),
                state: ExecutionStepState::Running,
                input: Some(content),
                output: None,
            },
        )?;
        tx.commit()?;
        Ok((step, vec![event]))
    }
    pub fn append_execution_text(
        &mut self,
        run: &str,
        step: &str,
        text: &str,
        reasoning: bool,
    ) -> Result<Vec<Event>> {
        if text.is_empty() {
            return Ok(vec![]);
        }
        let content = self.save_json(json!({"text":text}))?;
        let execution = self.execution_run(run)?;
        let tx = self.connection.transaction()?;
        guard(&tx, run, &["running"])?;
        let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM execution_steps WHERE id=?1 AND run_id=?2 AND state='running')",params![step,run],|r|r.get(0))?;
        if !active {
            return Err(Error::Conflict);
        }
        let event = record(
            &tx,
            &self.redactor,
            Some(&execution.run.task_id),
            None,
            EventSource::Provider,
            Payload::ExecutionText {
                run_id: run.into(),
                step_id: step.into(),
                content,
                reasoning,
            },
        )?;
        tx.commit()?;
        Ok(vec![event])
    }
    pub fn accept_execution_model(
        &mut self,
        run: &str,
        step: &str,
        output: &ModelOutput,
    ) -> Result<Vec<Event>> {
        let execution = self.execution_run(run)?;
        let mut context = self.execution_snapshot(&execution.run.task_id)?.context;
        let result = self.save_json(serde_json::to_value(output)?)?;
        context.last_text = output.text.clone();
        context.sources.push(ContextSource {
            step_id: step.into(),
            summary: output.text.chars().take(160).collect(),
            output: result.clone(),
            tool_call_ids: output.tool_calls.iter().map(|c| c.id.clone()).collect(),
        });
        let actions: Vec<_> = output
            .tool_calls
            .iter()
            .map(|call| Ok((id(), call, self.save_json(serde_json::to_value(call)?)?)))
            .collect::<Result<_>>()?;
        if actions.is_empty() {
            context.history.push(ModelHistoryItem::Exchange {
                continuation: output.continuation.clone(),
                tool_results: vec![],
            });
        } else {
            context.pending = Some(PendingBatch {
                model_step_id: step.into(),
                response: output.clone(),
                action_ids: actions.iter().map(|x| x.0.clone()).collect(),
                next: 0,
                results: vec![],
            });
        }
        let content = self.save_json(serde_json::to_value(&context)?)?;
        let tx = self.connection.transaction()?;
        guard(&tx, run, &["running"])?;
        if tx.execute("UPDATE execution_steps SET state='completed',output_object_id=?3,ended_at_ms=?4 WHERE id=?1 AND run_id=?2 AND state='running'",params![step,run,result.object_id,now_ms()])?!=1{return Err(Error::Conflict);}
        let mut events = vec![record(
            &tx,
            &self.redactor,
            Some(&execution.run.task_id),
            None,
            EventSource::Provider,
            Payload::ExecutionStepChanged {
                run_id: run.into(),
                step_id: step.into(),
                name: "model".into(),
                state: ExecutionStepState::Completed,
                input: None,
                output: Some(result),
            },
        )?];
        for (id, call, content) in actions {
            tx.execute("INSERT INTO execution_steps(id,run_id,ordinal,kind,name,state,provider_call_id,input_object_id) SELECT ?1,?2,COALESCE(MAX(ordinal),0)+1,'tool',?3,'prepared',?4,?5 FROM execution_steps WHERE run_id=?2",params![id,run,call.name,call.id,content.object_id])?;
            events.push(record(
                &tx,
                &self.redactor,
                Some(&execution.run.task_id),
                None,
                EventSource::Engine,
                Payload::ExecutionStepChanged {
                    run_id: run.into(),
                    step_id: id,
                    name: call.name.clone(),
                    state: ExecutionStepState::Prepared,
                    input: Some(content),
                    output: None,
                },
            )?);
        }
        events.push(record(
            &tx,
            &self.redactor,
            Some(&execution.run.task_id),
            None,
            EventSource::Provider,
            Payload::UsageRecorded {
                usage: output.usage.clone(),
            },
        )?);
        events.push(checkpoint(
            &tx,
            &self.redactor,
            run,
            &content,
            if context.pending.is_some() {
                "tools_prepared"
            } else {
                "model_completed"
            },
        )?);
        tx.commit()?;
        Ok(events)
    }
    pub fn abandon_execution_model(&mut self, run: &str, step: &str) -> Result<Vec<Event>> {
        let execution = self.execution_run(run)?;
        let tx = self.connection.transaction()?;
        guard(&tx, run, &["running"])?;
        if tx.execute("UPDATE execution_steps SET state='cancelled',ended_at_ms=?2 WHERE id=?1 AND kind='model' AND state='running'",params![step,now_ms()])?!=1{return Err(Error::Conflict);}
        let event = record(
            &tx,
            &self.redactor,
            Some(&execution.run.task_id),
            None,
            EventSource::User,
            Payload::ExecutionStepChanged {
                run_id: run.into(),
                step_id: step.into(),
                name: "model".into(),
                state: ExecutionStepState::Cancelled,
                input: None,
                output: None,
            },
        )?;
        tx.commit()?;
        Ok(vec![event])
    }
    pub fn compact_execution_context(&mut self, run: &str, remove: usize) -> Result<Vec<Event>> {
        let execution = self.execution_run(run)?;
        let mut context = self.execution_snapshot(&execution.run.task_id)?.context;
        if remove == 0 || remove > context.history.len() {
            return Err(Error::Invalid("invalid compaction boundary"));
        }
        let removed: Vec<_> = context.history.drain(..remove).collect();
        let archive = self.save_json(
            json!({"history":removed,"sources":context.sources,"previous":context.digest}),
        )?;
        let recent: Vec<_> = context.sources.iter().rev().take(8).cloned().collect();
        let total = context
            .digest
            .as_ref()
            .map_or(0, |d| d.compacted_items)
            .saturating_add(remove as u32);
        context.digest = Some(ContextDigest {
            compacted_items: total,
            archive: archive.clone(),
            recent_sources: recent,
        });
        context.sources.clear();
        let content = self.save_json(serde_json::to_value(&context)?)?;
        let tx = self.connection.transaction()?;
        guard(&tx, run, &["running"])?;
        let events = vec![
            record(
                &tx,
                &self.redactor,
                Some(&execution.run.task_id),
                None,
                EventSource::Engine,
                Payload::ContextCompacted {
                    run_id: run.into(),
                    archive,
                    removed_items: remove as u32,
                },
            )?,
            checkpoint(&tx, &self.redactor, run, &content, "context_compacted")?,
        ];
        tx.commit()?;
        Ok(events)
    }
    pub fn read_execution_step_result(&self, run: &str, step_id: &str) -> Result<Value> {
        let current = self.execution_run(run)?;
        if let Some(value) = self.restored_step_result(&current.run.task_id, step_id)? {
            return Ok(value);
        }
        let step = self.execution_step(step_id)?;
        let previous = self.execution_run(&step.run_id)?;
        if current.session_id != previous.session_id {
            return Err(Error::Invalid("step belongs to another session"));
        }
        self.read_json(
            step.output
                .as_ref()
                .ok_or(Error::Invalid("step has no complete result"))?,
        )
    }
}
