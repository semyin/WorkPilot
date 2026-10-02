use super::providers::accept_command;
use super::*;
impl Store {
    fn bounded_tool_text(&mut self, text: &str) -> Result<ContentRef> {
        let content = objects::put_tool_text(&self.directory, text, &self.redactor)?;
        self.connection.execute(
            "INSERT OR IGNORE INTO objects(id,bytes,media_type) VALUES(?1,?2,?3)",
            params![content.object_id, content.bytes, content.media_type],
        )?;
        content_ref(&self.connection, &content.object_id)
    }
    pub fn tool_action_rejected(&self, action: &str) -> Result<bool> {
        Ok(self.connection.query_row("SELECT EXISTS(SELECT 1 FROM approvals a JOIN tool_approval_objects t ON t.approval_id=a.id WHERE t.action_id=?1 AND json_extract(a.data_json,'$.state')='rejected')", [action], |r|r.get(0))?)
    }
    pub fn read_command_output(
        &self,
        run: &str,
        step: &str,
        channel: &str,
        offset: u64,
        limit: u32,
    ) -> Result<serde_json::Value> {
        if !["stdout", "stderr"].contains(&channel) || limit == 0 || limit > 32768 {
            return Err(Error::Invalid("output page"));
        }
        let value = self.read_execution_step_result(run, step)?;
        if self.execution_step(step)?.name != "run_command" {
            return Err(Error::Invalid("not a command result"));
        }
        let result: ModelToolResult = serde_json::from_value(value)?;
        let data: serde_json::Value = serde_json::from_str(&result.output)?;
        let reference: ContentRef = serde_json::from_value(data[channel].clone())?;
        let owns: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM tool_result_objects WHERE action_id=?1 AND object_id=?2)",
            params![step, reference.object_id],
            |r| r.get(0),
        )?;
        if !owns {
            return Err(Error::Conflict);
        }
        Ok(serde_json::to_value(objects::read(
            &self.directory,
            &reference,
            offset,
            limit,
        )?)?)
    }
    pub fn save_tool_json(&mut self, action: &str, value: serde_json::Value) -> Result<ContentRef> {
        let content = self.save_json(value)?;
        self.connection.execute(
            "INSERT OR IGNORE INTO tool_result_objects(action_id,object_id) VALUES(?1,?2)",
            params![action, content.object_id],
        )?;
        Ok(content)
    }
    pub fn save_tool_text(&mut self, action: &str, text: &str) -> Result<ContentRef> {
        let content = self.bounded_tool_text(text)?;
        self.connection.execute(
            "INSERT OR IGNORE INTO tool_result_objects(action_id,object_id) VALUES(?1,?2)",
            params![action, content.object_id],
        )?;
        Ok(content)
    }
    pub fn tool_defaults(&self) -> Result<DefaultToolSettings> {
        let value: Option<String> = self
            .connection
            .query_row(
                "SELECT value_json FROM settings WHERE key='tool_defaults'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        Ok(value
            .map(|s| serde_json::from_str(&s))
            .transpose()?
            .unwrap_or_default())
    }
    pub fn tool_settings(&self, task: &str) -> Result<ToolSettingsView> {
        let t = self.task(task)?;
        let defaults = self.tool_defaults()?;
        let row: Option<(String, Option<String>)> = self
            .connection
            .query_row(
                "SELECT data_json,root_identity FROM task_tool_settings WHERE task_id=?1",
                [task],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let (settings, root_identity) = if let Some((value, identity)) = row {
            (serde_json::from_str::<ToolSettings>(&value)?, identity)
        } else {
            (ToolSettings::default(), None)
        };
        let project_mode = if let Some(project) = t.project_id {
            let raw: String = self.connection.query_row(
                "SELECT data_json FROM projects WHERE id=?1",
                [project],
                |r| r.get(0),
            )?;
            Some(serde_json::from_str::<Project>(&raw)?.permission)
        } else {
            None
        };
        let effective_permission = settings
            .permission
            .or(project_mode)
            .unwrap_or(defaults.permission);
        let review_profile_id = settings
            .review_profile_id
            .clone()
            .or(defaults.review_profile_id.clone());
        let epoch = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                &settings,
                &defaults,
                &root_identity,
                effective_permission
            ))?)
        );
        self.constrain_member_policy(
            task,
            ToolSettingsView {
                settings,
                defaults,
                effective_permission,
                review_profile_id,
                epoch,
                root_identity,
            },
        )
    }
    pub fn configure_task_tools(
        &mut self,
        request: &Request,
        task: &str,
        settings: &ToolSettings,
        root_identity: Option<String>,
    ) -> Result<Vec<Event>> {
        if self.cached_receipt(request)?.is_some() {
            return Ok(vec![]);
        }
        settings.validate().map_err(Error::Invalid)?;
        if self.member_parent(task)?.is_some() {
            return Err(Error::Invalid("成员继承父任务权限，请修改主任务设置"));
        }
        let old = self.tool_settings(task)?;
        if old.settings.revision != settings.revision {
            return Err(Error::Conflict);
        }
        if let Some(p) = &settings.review_profile_id {
            self.profile(p)?;
        }
        let mut settings = settings.clone();
        settings.revision = settings.revision.checked_add(1).ok_or(Error::Conflict)?;
        let tx = self.connection.transaction()?;
        let mut events = accept_command(&tx, &self.redactor, request, Some(task))?;
        tx.execute("INSERT INTO task_tool_settings(task_id,data_json,root_identity) VALUES(?1,?2,?3) ON CONFLICT(task_id) DO UPDATE SET data_json=excluded.data_json,root_identity=excluded.root_identity",params![task,encode(&settings)?,root_identity])?;
        tx.execute(
            "UPDATE tasks SET permission=?2 WHERE id=?1",
            params![
                task,
                word(&settings.permission.unwrap_or(old.defaults.permission))?
            ],
        )?;
        tx.execute("UPDATE approvals SET data_json=json_set(data_json,'$.state','expired') WHERE task_id=?1 AND json_extract(data_json,'$.consumed')=0 AND json_extract(data_json,'$.state') IN ('pending','approved')",[task])?;
        events.push(record(
            &tx,
            &self.redactor,
            Some(task),
            Some(&request.request_id),
            EventSource::User,
            Payload::ToolPolicyChanged {
                revision: settings.revision,
            },
        )?);
        events.push(finish(&tx, &self.redactor, request, Some(task))?);
        tx.commit()?;
        Ok(events)
    }
    pub fn configure_tool_defaults(
        &mut self,
        request: &Request,
        settings: &DefaultToolSettings,
    ) -> Result<Vec<Event>> {
        if self.cached_receipt(request)?.is_some() {
            return Ok(vec![]);
        }
        let old = self.tool_defaults()?;
        if settings.revision != old.revision {
            return Err(Error::Conflict);
        }
        if let Some(p) = &settings.review_profile_id {
            self.profile(p)?;
        }
        let mut settings = settings.clone();
        settings.revision = settings.revision.checked_add(1).ok_or(Error::Conflict)?;
        let tx = self.connection.transaction()?;
        let mut events = accept_command(&tx, &self.redactor, request, None)?;
        tx.execute("INSERT INTO settings(key,value_json) VALUES('tool_defaults',?1) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",[encode(&settings)?])?;
        tx.execute("UPDATE approvals SET data_json=json_set(data_json,'$.state','expired') WHERE json_extract(data_json,'$.consumed')=0 AND json_extract(data_json,'$.state') IN ('pending','approved')",[])?;
        events.push(record(
            &tx,
            &self.redactor,
            None,
            Some(&request.request_id),
            EventSource::User,
            Payload::ToolPolicyChanged {
                revision: settings.revision,
            },
        )?);
        events.push(finish(&tx, &self.redactor, request, None)?);
        tx.commit()?;
        Ok(events)
    }
    pub fn tool_approval(&self, id: &str) -> Result<ToolApproval> {
        let raw: String = self
            .connection
            .query_row("SELECT data_json FROM approvals WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .optional()?
            .ok_or(Error::NotFound)?;
        Ok(serde_json::from_str(&raw)?)
    }
    pub fn attach_execution_approval(&mut self, action: &str, approval: &str) -> Result<()> {
        self.connection.execute("UPDATE tool_calls SET approval_id=?2 WHERE id=(SELECT tool_call_id FROM execution_steps WHERE id=?1)",params![action,approval])?;
        Ok(())
    }
    pub fn note_tool_uncertainty(&mut self, action: &str, message: &str) -> Result<Vec<Event>> {
        let step = self.execution_step(action)?;
        let run = self.execution_run(&step.run_id)?;
        let output=self.save_json(serde_json::json!({"error":message,"effect":"not confirmed; inspect the actual result before continuing"}))?;
        let tx = self.connection.transaction()?;
        tx.execute(
            "UPDATE execution_steps SET state='needs_review',output_object_id=?2 WHERE id=?1",
            params![action, output.object_id],
        )?;
        if let Some(tool) = step.tool_call_id {
            tx.execute(
                "UPDATE tool_calls SET state='needs_review',output_object_id=?2 WHERE id=?1",
                params![tool, output.object_id],
            )?;
        }
        let e = record(
            &tx,
            &self.redactor,
            Some(&run.run.task_id),
            None,
            EventSource::Tool,
            Payload::ExecutionStepChanged {
                run_id: step.run_id,
                step_id: action.into(),
                name: step.name,
                state: ExecutionStepState::NeedsReview,
                input: None,
                output: Some(output),
            },
        )?;
        tx.commit()?;
        Ok(vec![e])
    }
    pub fn ensure_tool_approval(
        &mut self,
        intent: &ToolIntent,
    ) -> Result<(ToolApproval, Vec<Event>)> {
        let fingerprint = workpilot_policy::fingerprint(intent)?;
        let existing:Option<String>=self.connection.query_row("SELECT a.id FROM approvals a JOIN tool_approval_objects t ON t.approval_id=a.id WHERE t.action_id=?1 AND json_extract(a.data_json,'$.fingerprint')=?2 AND json_extract(a.data_json,'$.state')<>'expired' AND json_extract(a.data_json,'$.consumed')=0 ORDER BY a.rowid DESC LIMIT 1",params![intent.action_id,fingerprint],|r|r.get(0)).optional()?;
        if let Some(id) = existing {
            return Ok((self.tool_approval(&id)?, vec![]));
        }
        if self.tool_settings(&intent.task_id)?.epoch != intent.epoch {
            return Err(Error::Conflict);
        }
        let content = self.save_json(serde_json::to_value(intent)?)?;
        let approval = ToolApproval {
            id: id(),
            task_id: intent.task_id.clone(),
            action_id: intent.action_id.clone(),
            fingerprint,
            intent: intent.clone(),
            state: ApprovalState::Pending,
            decided_by: None,
            decided_at_ms: None,
            created_at_ms: now_ms(),
            consumed: false,
            review: None,
        };
        let tx = self.connection.transaction()?;
        let owns:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM execution_steps e JOIN runs r ON r.id=e.run_id WHERE e.id=?1 AND r.task_id=?2 AND e.state='prepared')",params![intent.action_id,intent.task_id],|r|r.get(0))?;
        if !owns {
            return Err(Error::Conflict);
        }
        tx.execute("UPDATE approvals SET data_json=json_set(data_json,'$.state','expired') WHERE id IN (SELECT approval_id FROM tool_approval_objects WHERE action_id=?1) AND json_extract(data_json,'$.consumed')=0",[&intent.action_id])?;
        tx.execute(
            "INSERT INTO approvals(id,task_id,data_json) VALUES(?1,?2,?3)",
            params![approval.id, approval.task_id, encode(&approval)?],
        )?;
        tx.execute("INSERT INTO tool_approval_objects(approval_id,action_id,intent_object_id) VALUES(?1,?2,?3)",params![approval.id,intent.action_id,content.object_id])?;
        let event = record(
            &tx,
            &self.redactor,
            Some(&intent.task_id),
            None,
            EventSource::Engine,
            Payload::ToolApprovalRequested {
                approval_id: approval.id.clone(),
                intent: content,
            },
        )?;
        tx.commit()?;
        Ok((approval, vec![event]))
    }
    pub fn decide_tool_approval(
        &mut self,
        request: Option<&Request>,
        id: &str,
        task: &str,
        fingerprint: &str,
        approved: bool,
        by: &str,
    ) -> Result<Vec<Event>> {
        if let Some(r) = request
            && self.cached_receipt(r)?.is_some()
        {
            return Ok(vec![]);
        }
        let mut approval = self.tool_approval(id)?;
        if approval.task_id != task
            || approval.fingerprint != fingerprint
            || approval.state != ApprovalState::Pending
            || approval.consumed
            || approval.intent.epoch != self.tool_settings(task)?.epoch
        {
            return Err(Error::Conflict);
        }
        approval.state = if approved {
            ApprovalState::Approved
        } else {
            ApprovalState::Rejected
        };
        approval.decided_by = Some(by.into());
        approval.decided_at_ms = Some(now_ms());
        let tx = self.connection.transaction()?;
        let mut events = if let Some(r) = request {
            accept_command(&tx, &self.redactor, r, Some(task))?
        } else {
            vec![]
        };
        tx.execute(
            "UPDATE approvals SET data_json=?2 WHERE id=?1",
            params![id, encode(&approval)?],
        )?;
        events.push(record(
            &tx,
            &self.redactor,
            Some(task),
            request.map(|r| r.request_id.as_str()),
            if request.is_some() {
                EventSource::User
            } else {
                EventSource::Engine
            },
            Payload::ToolApprovalDecided {
                approval_id: id.into(),
                approved,
                decided_by: by.into(),
            },
        )?);
        if let Some(r) = request {
            events.push(finish(&tx, &self.redactor, r, Some(task))?);
        }
        tx.commit()?;
        Ok(events)
    }
    pub fn record_tool_review(&mut self, id: &str, review: ApprovalReview) -> Result<Vec<Event>> {
        let mut a = self.tool_approval(id)?;
        if a.state != ApprovalState::Pending || a.consumed {
            return Err(Error::Conflict);
        }
        a.review = Some(review.clone());
        let mut value = serde_json::to_value(&a)?;
        self.redactor.value(&mut value);
        let tx = self.connection.transaction()?;
        tx.execute(
            "UPDATE approvals SET data_json=?2 WHERE id=?1",
            params![id, encode(&value)?],
        )?;
        let event = record(
            &tx,
            &self.redactor,
            Some(&a.task_id),
            None,
            EventSource::Provider,
            Payload::ToolReviewFinished {
                approval_id: id.into(),
                review,
            },
        )?;
        tx.commit()?;
        Ok(vec![event])
    }
    pub fn consume_tool_approval(&mut self, id: &str, intent: &ToolIntent) -> Result<()> {
        let mut a = self.tool_approval(id)?;
        if self.member_parent(&a.task_id)?.is_some() && !self.team_enabled(&a.task_id)? {
            return Err(Error::Conflict);
        }
        if a.task_id != intent.task_id
            || a.action_id != intent.action_id
            || a.fingerprint != workpilot_policy::fingerprint(intent)?
            || a.state != ApprovalState::Approved
            || a.consumed
            || self.tool_settings(&a.task_id)?.epoch != intent.epoch
        {
            return Err(Error::Conflict);
        }
        if matches!(
            self.task(&a.task_id)?.state,
            TaskState::Stopping | TaskState::Interrupted | TaskState::Failed
        ) {
            return Err(Error::Conflict);
        }
        a.consumed = true;
        self.connection.execute(
            "UPDATE approvals SET data_json=?2 WHERE id=?1",
            params![id, encode(&a)?],
        )?;
        Ok(())
    }
    pub fn tool_task_state(&self, task: &str) -> Result<ToolTaskState> {
        let policy = self.tool_settings(task)?;
        let mut q=self.connection.prepare("SELECT id FROM approvals WHERE task_id=?1 AND json_extract(data_json,'$.action_id') IS NOT NULL ORDER BY rowid DESC LIMIT 64")?;
        let ids = q
            .query_map([task], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let approvals = ids
            .iter()
            .map(|id| self.tool_approval(id))
            .collect::<Result<Vec<_>>>()?;
        let mut q=self.connection.prepare("SELECT action_id,path,before_json,after_json,before_object_id,after_object_id FROM managed_file_changes WHERE task_id=?1 AND after_json IS NOT NULL ORDER BY rowid DESC LIMIT 64")?;
        let changes = q
            .query_map([task], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, String>(5)?,
                ))
            })?
            .map(|row| {
                let (action_id, path, before, after, before_id, after_id) = row?;
                Ok(ManagedFileChange {
                    action_id,
                    path,
                    before: serde_json::from_str(&before)?,
                    after: serde_json::from_str(&after)?,
                    before_content: before_id
                        .map(|id| content_ref(&self.connection, &id))
                        .transpose()?,
                    after_content: content_ref(&self.connection, &after_id)?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(ToolTaskState {
            policy,
            approvals,
            changes,
        })
    }
    pub fn prepare_managed_write(
        &mut self,
        task: &str,
        action: &str,
        path: &str,
        before: &FileVersion,
        before_text: Option<&str>,
        after: &str,
    ) -> Result<()> {
        // Exact version restoration must not silently store a redacted substitute.
        if self.redactor.text(after) != after
            || before_text.is_some_and(|s| self.redactor.text(s) != s)
        {
            return Err(Error::Invalid(
                "protected content requires encrypted version storage",
            ));
        }
        let before_ref = before_text.map(|s| self.bounded_tool_text(s)).transpose()?;
        let after_ref = self.bounded_tool_text(after)?;
        let root = self
            .tool_settings(task)?
            .root_identity
            .ok_or(Error::Invalid("project identity missing"))?;
        self.connection.execute("INSERT INTO managed_file_changes(action_id,task_id,path,before_json,before_object_id,after_object_id,root_identity) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(action_id) DO NOTHING",params![action,task,path,encode(before)?,before_ref.map(|r|r.object_id),after_ref.object_id,root])?;
        Ok(())
    }
    pub fn finish_managed_write(
        &mut self,
        action: &str,
        after: &FileVersion,
    ) -> Result<Vec<Event>> {
        self.connection.execute(
            "UPDATE managed_file_changes SET after_json=?2 WHERE action_id=?1",
            params![action, encode(after)?],
        )?;
        let task: String = self.connection.query_row(
            "SELECT task_id FROM managed_file_changes WHERE action_id=?1",
            [action],
            |r| r.get(0),
        )?;
        let change = self
            .tool_task_state(&task)?
            .changes
            .into_iter()
            .find(|c| c.action_id == action)
            .ok_or(Error::NotFound)?;
        let tx = self.connection.transaction()?;
        let event = record(
            &tx,
            &self.redactor,
            Some(&task),
            None,
            EventSource::Tool,
            Payload::ManagedFileChanged { change },
        )?;
        tx.commit()?;
        Ok(vec![event])
    }
    pub fn managed_write_recovery(
        &self,
        action: &str,
    ) -> Result<Option<(String, String, ContentRef)>> {
        let row:Option<(String,String,String)>=self.connection.query_row("SELECT path,root_identity,after_object_id FROM managed_file_changes WHERE action_id=?1",[action],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        row.map(|(path, root, id)| Ok((path, root, content_ref(&self.connection, &id)?)))
            .transpose()
    }
    pub fn register_file_artifact(
        &mut self,
        task: &str,
        path: &str,
        text: &str,
    ) -> Result<Vec<Event>> {
        if self.redactor.text(text) != text {
            return Err(Error::Invalid(
                "protected content requires encrypted version storage",
            ));
        }
        let content = self.bounded_tool_text(text)?;
        let old: Option<(String, Option<String>)> = self
            .connection
            .query_row(
                "SELECT id,latest_revision_id FROM artifacts WHERE task_id=?1 AND path=?2 LIMIT 1",
                params![task, path],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let (artifact, previous) = old.unwrap_or_else(|| (id(), None));
        let revision = id();
        let tx = self.connection.transaction()?;
        tx.execute(
            "INSERT INTO artifacts(id,task_id,path) VALUES(?1,?2,?3) ON CONFLICT(id) DO NOTHING",
            params![artifact, task, path],
        )?;
        tx.execute("INSERT INTO revisions(id,artifact_id,object_id,predecessor_id,created_at_ms) VALUES(?1,?2,?3,?4,?5)",params![revision,artifact,content.object_id,previous,now_ms()])?;
        tx.execute(
            "UPDATE artifacts SET latest_revision_id=?2 WHERE id=?1",
            params![artifact, revision],
        )?;
        let e = record(
            &tx,
            &self.redactor,
            Some(task),
            None,
            EventSource::Tool,
            Payload::ArtifactCreated {
                artifact_id: artifact,
                revision_id: revision,
                content,
            },
        )?;
        tx.commit()?;
        Ok(vec![e])
    }
}
fn finish(
    tx: &rusqlite::Transaction<'_>,
    redactor: &redaction::Redactor,
    request: &Request,
    task: Option<&str>,
) -> Result<Event> {
    tx.execute(
        "UPDATE commands SET status='completed',finished_at_ms=?2 WHERE request_id=?1",
        params![request.request_id, now_ms()],
    )?;
    record(
        tx,
        redactor,
        task,
        Some(&request.request_id),
        EventSource::Engine,
        Payload::CommandFinished {
            status: CommandStatus::Completed,
        },
    )
}
