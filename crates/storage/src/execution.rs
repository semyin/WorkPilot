//! Execution sessions, run lifecycle and shared transaction guards.
mod actions;
mod model;
use super::providers::accept_command;
use super::*;
use serde_json::{Value, json};

impl Store {
    pub fn is_execution(&self, task: &str) -> Result<bool> {
        Ok(self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM execution_sessions WHERE task_id=?1)",
            [task],
            |r| r.get(0),
        )?)
    }
    pub fn read_json<T: DeserializeOwned>(&self, reference: &ContentRef) -> Result<T> {
        if reference.bytes > 8 * 1024 * 1024 {
            return Err(Error::Invalid("JSON object too large"));
        }
        objects::verify(&self.directory, reference)?;
        let data = std::fs::read(objects::object_path(&self.directory, &reference.object_id)?)?;
        Ok(serde_json::from_slice(&data)?)
    }
    pub fn read_text_value(&self, reference: &ContentRef) -> Result<String> {
        if reference.bytes > 8 * 1024 * 1024 {
            return Err(Error::Invalid("text object too large"));
        }
        objects::verify(&self.directory, reference)?;
        Ok(std::fs::read_to_string(objects::object_path(
            &self.directory,
            &reference.object_id,
        )?)?)
    }
    pub fn create_execution(
        &mut self,
        request: &Request,
        config: &ExecutionConfig,
    ) -> Result<(Receipt, Vec<Event>)> {
        self.create_execution_inner(request, config, None)
    }
    pub fn create_scheduled_execution(
        &mut self,
        request: &Request,
        config: &ExecutionConfig,
        occurrence: &str,
    ) -> Result<(Receipt, Vec<Event>)> {
        let plan = self.schedule_dispatch_plan(occurrence)?;
        if config.project_id != plan.spec.project_id
            || config.profile_id.as_deref() != Some(&plan.spec.profile_id)
        {
            return Err(Error::Conflict);
        }
        self.create_execution_inner(request, config, Some(&plan.spec))
    }
    fn create_execution_inner(
        &mut self,
        request: &Request,
        config: &ExecutionConfig,
        schedule: Option<&ScheduleSpec>,
    ) -> Result<(Receipt, Vec<Event>)> {
        if let Some(receipt) = self.cached_receipt(request)? {
            return Ok((receipt, vec![]));
        }
        let mut config = config.clone();
        let project_defaults = config
            .project_id
            .as_ref()
            .map(|p| self.project_creation_defaults(p))
            .transpose()?;
        if let Some((project, _)) = &project_defaults {
            config.project_rules = format!("{}\n{}", project.settings.rules, config.project_rules)
                .trim()
                .to_owned();
            config.profile_id = config
                .profile_id
                .or(project.settings.default_profile_id.clone());
        }
        config.validate().map_err(Error::Invalid)?;
        if let Some(p) = &config.profile_id {
            self.profile(p)?;
        }
        let context = ExecutionContext {
            version: 1,
            goal: config.goal.clone(),
            constraints: config.constraints.clone(),
            project_rules: config.project_rules.clone(),
            directions: vec![],
            history: vec![],
            sources: vec![],
            digest: None,
            plan: vec![],
            question: None,
            pending: None,
            last_text: String::new(),
        };
        let config_ref = self.save_json(serde_json::to_value(&config)?)?;
        let context_ref = self.save_json(serde_json::to_value(context)?)?;
        let goal = self.text(&config.goal)?;
        let (task, session, agent) = (id(), id(), id());
        let record_agent = Agent {
            id: agent.clone(),
            task_id: task.clone(),
            parent_id: None,
            replaces_id: None,
            role: "primary".into(),
            profile_id: None,
            state: AgentState::Queued,
            attempt: 0,
        };
        let tx = self.connection.transaction()?;
        tx.execute("INSERT INTO tasks(id,project_id,title,state,mode,permission,profile_id,created_at_ms,updated_at_ms) VALUES(?1,?2,?3,'queued',?4,'request_approval',?5,?6,?6)",
            params![task,config.project_id,self.redactor.text(&config.title),word(&config.mode)?,config.profile_id,now_ms()])?;
        if project_defaults.is_some() || schedule.is_some() {
            let (mut settings, identity) = project_defaults.map_or_else(
                || (ToolSettings::default(), None),
                |(project, identity)| {
                    (
                        ToolSettings {
                            root_path: Some(project.settings.root_path),
                            permission: Some(project.settings.permission),
                            ..Default::default()
                        },
                        identity,
                    )
                },
            );
            // Commit the schedule's authority with the task itself. A crash before
            // dispatch must not leave a task inheriting a broader project/global default.
            if let Some(spec) = schedule {
                settings.permission = Some(spec.permission);
                settings.review_profile_id = spec.review_profile_id.clone();
                settings.commands_enabled = spec.commands_enabled;
                tx.execute(
                    "UPDATE tasks SET permission=?2 WHERE id=?1",
                    params![task, word(&spec.permission)?],
                )?;
            }
            tx.execute(
                "INSERT INTO task_tool_settings(task_id,data_json,root_identity) VALUES(?1,?2,?3)",
                params![task, encode(&settings)?, identity],
            )?;
        }
        tx.execute(
            "INSERT INTO agents(id,task_id,data_json) VALUES(?1,?2,?3)",
            params![agent, task, encode(&record_agent)?],
        )?;
        tx.execute("INSERT INTO execution_sessions(id,task_id,agent_id,config_object_id,context_object_id) VALUES(?1,?2,?3,?4,?5)",params![session,task,agent,config_ref.object_id,context_ref.object_id])?;
        let mut events = accept_command(&tx, &self.redactor, request, Some(&task))?;
        events.push(record(
            &tx,
            &self.redactor,
            Some(&task),
            Some(&request.request_id),
            EventSource::Engine,
            Payload::ExecutionCreated {
                session_id: session,
                agent_id: agent,
                goal,
            },
        )?);
        events.extend(finish_control_tx(&tx, &self.redactor, request, &task)?);
        tx.commit()?;
        Ok((
            Receipt {
                request_id: request.request_id.clone(),
                status: CommandStatus::Completed,
                task_id: Some(task),
                duplicate: false,
            },
            events,
        ))
    }
    pub fn execution_tasks(&self, limit: u32) -> Result<Vec<Task>> {
        let mut query=self.connection.prepare("SELECT t.id FROM tasks t WHERE t.archived=0 AND NOT EXISTS(SELECT 1 FROM team_members m WHERE m.task_id=t.id) AND EXISTS(SELECT 1 FROM execution_sessions s WHERE s.task_id=t.id) ORDER BY t.updated_at_ms DESC,t.id DESC LIMIT ?1")?;
        let ids: Vec<String> = query
            .query_map([limit], |r| r.get(0))?
            .collect::<std::result::Result<_, _>>()?;
        ids.iter().map(|id| self.task(id)).collect()
    }
    pub fn execution_snapshot(&self, task: &str) -> Result<ExecutionSnapshot> {
        let (session,agent,config,context,run,checkpoint):(String,String,String,String,Option<String>,Option<String>)=
            self.connection.query_row("SELECT s.id,s.agent_id,s.config_object_id,s.context_object_id,s.current_run_id,s.checkpoint_id FROM execution_sessions s JOIN agents a ON a.id=s.agent_id WHERE s.task_id=?1 AND json_extract(a.data_json,'$.role')='primary'",[task],
                |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional()?.ok_or(Error::NotFound)?;
        let mut query=self.connection.prepare("SELECT id FROM execution_steps WHERE run_id IN (SELECT id FROM runs WHERE task_id=?1) ORDER BY rowid DESC LIMIT 64")?;
        let ids: Vec<String> = query
            .query_map([task], |r| r.get(0))?
            .collect::<std::result::Result<_, _>>()?;
        let mut steps = ids
            .iter()
            .map(|id| self.execution_step(id))
            .collect::<Result<Vec<_>>>()?;
        steps.reverse();
        Ok(ExecutionSnapshot {
            task: self.task(task)?,
            session_id: session,
            agent_id: agent,
            config: self.read_json(&content_ref(&self.connection, &config)?)?,
            context: self.read_json(&content_ref(&self.connection, &context)?)?,
            latest_run: run.map(|id| self.execution_run(&id)).transpose()?,
            checkpoint_id: checkpoint,
            messages: self.execution_messages(task)?,
            steps,
        })
    }
    pub fn execution_messages(&self, task: &str) -> Result<Vec<Message>> {
        let mut query=self.connection.prepare("SELECT id,role,state,queue_position,object_id,created_at_ms FROM messages WHERE task_id=?1 ORDER BY (state IN ('queued','steer_requested')) DESC,queue_position DESC LIMIT 128")?;
        let rows = query.query_map([task], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, u64>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, u64>(5)?,
            ))
        })?;
        let mut messages = vec![];
        for row in rows {
            let (id, role, state, position, object, created) = row?;
            messages.push(Message {
                id,
                task_id: task.into(),
                role,
                state: parse_word(state)?,
                queue_position: position,
                content: content_ref(&self.connection, &object)?,
                created_at_ms: created,
            });
        }
        messages.reverse();
        Ok(messages)
    }
    pub fn execution_run(&self, run: &str) -> Result<ExecutionRun> {
        let raw=self.connection.query_row("SELECT r.task_id,r.agent_id,r.state,r.started_at_ms,r.ended_at_ms,r.result_object_id,r.failure_code,e.session_id,e.request_id,e.predecessor_id,e.profile_json,e.mode,e.limits_json,e.steps,e.reason,e.diagnostic_json FROM runs r JOIN execution_runs e ON e.run_id=r.id WHERE r.id=?1",[run],|r|Ok((
            r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,String>(2)?,r.get::<_,u64>(3)?,r.get::<_,Option<u64>>(4)?,r.get::<_,Option<String>>(5)?,r.get::<_,Option<String>>(6)?,
            r.get::<_,String>(7)?,r.get::<_,String>(8)?,r.get::<_,Option<String>>(9)?,r.get::<_,String>(10)?,r.get::<_,String>(11)?,r.get::<_,String>(12)?,r.get::<_,u32>(13)?,r.get::<_,Option<String>>(14)?,r.get::<_,Option<String>>(15)?
        ))).optional()?.ok_or(Error::NotFound)?;
        Ok(ExecutionRun {
            run: Run {
                id: run.into(),
                task_id: raw.0,
                agent_id: raw.1,
                state: parse_word(raw.2)?,
                started_at_ms: raw.3,
                ended_at_ms: raw.4,
                result: raw
                    .5
                    .map(|id| content_ref(&self.connection, &id))
                    .transpose()?,
                failure_code: raw.6,
            },
            session_id: raw.7,
            request_id: raw.8,
            predecessor_id: raw.9,
            profile: serde_json::from_str(&raw.10)?,
            mode: parse_word(raw.11)?,
            limits: serde_json::from_str(&raw.12)?,
            steps: raw.13,
            reason: raw.14,
            diagnostic: raw.15.map(|s| serde_json::from_str(&s)).transpose()?,
        })
    }
    pub fn execution_step(&self, step: &str) -> Result<ExecutionStep> {
        let raw=self.connection.query_row("SELECT run_id,ordinal,kind,name,state,provider_call_id,input_object_id,output_object_id,tool_call_id,started_at_ms,ended_at_ms FROM execution_steps WHERE id=?1",[step],|r|Ok((
            r.get::<_,String>(0)?,r.get::<_,u32>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,Option<String>>(5)?,r.get::<_,String>(6)?,r.get::<_,Option<String>>(7)?,r.get::<_,Option<String>>(8)?,r.get::<_,Option<u64>>(9)?,r.get::<_,Option<u64>>(10)?
        ))).optional()?.ok_or(Error::NotFound)?;
        Ok(ExecutionStep {
            id: step.into(),
            run_id: raw.0,
            ordinal: raw.1,
            kind: parse_word(raw.2)?,
            name: raw.3,
            state: parse_word(raw.4)?,
            provider_call_id: raw.5,
            input: content_ref(&self.connection, &raw.6)?,
            output: raw
                .7
                .map(|id| content_ref(&self.connection, &id))
                .transpose()?,
            tool_call_id: raw.8,
            started_at_ms: raw.9,
            ended_at_ms: raw.10,
        })
    }
    pub fn queue_execution(
        &mut self,
        request: &Request,
        task: &str,
        profile: &ProviderProfile,
    ) -> Result<(Receipt, Vec<Event>)> {
        if let Some(receipt) = self.cached_receipt(request)? {
            return Ok((receipt, vec![]));
        }
        self.schedule_can_start(task, profile)?;
        if self.task_archived(task)? {
            return Err(Error::Invalid("restore archived task before continuing"));
        }
        let snapshot = self.execution_snapshot(task)?;
        if matches!(
            snapshot.task.state,
            TaskState::Running | TaskState::Stopping
        ) || snapshot
            .latest_run
            .as_ref()
            .is_some_and(|r| r.run.state == TaskState::Queued)
        {
            return Err(Error::Busy);
        }
        let context = &snapshot.context;
        if let Some(last) = &snapshot.latest_run
            && (!context.history.is_empty() || context.pending.is_some())
            && (last.profile.protocol != profile.protocol
                || last.profile.model != profile.model
                || last.profile.base_url != profile.base_url)
        {
            return Err(Error::Invalid(
                "continuation needs the original protocol, model and address",
            ));
        }
        let queued = snapshot
            .messages
            .iter()
            .any(|m| matches!(m.state, MessageState::Queued | MessageState::SteerRequested));
        if context
            .question
            .as_ref()
            .is_some_and(|q| !q.plan_confirmation || snapshot.task.mode != WorkMode::Execute)
            && !queued
        {
            return Err(Error::Invalid("provide requested input before continuing"));
        }
        if snapshot.task.state == TaskState::Completed && !queued {
            return Err(Error::Invalid(
                "send a new message before continuing completed work",
            ));
        }
        let run = id();
        let mut safe = serde_json::to_value(profile.without_credential())?;
        self.redactor.value(&mut safe);
        let tx = self.connection.transaction()?;
        let count:u32=tx.query_row("SELECT count(*) FROM runs r JOIN execution_runs e ON e.run_id=r.id WHERE r.state IN ('queued','running')",[],|r|r.get(0))?;
        if count >= 32 {
            return Err(Error::Busy);
        }
        let mut events = accept_command(&tx, &self.redactor, request, Some(task))?;
        tx.execute("INSERT INTO runs(id,task_id,agent_id,state,started_at_ms) VALUES(?1,?2,?3,'queued',?4)",params![run,task,snapshot.agent_id,now_ms()])?;
        tx.execute("INSERT INTO execution_runs(run_id,session_id,request_id,predecessor_id,profile_json,mode,limits_json) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![run,snapshot.session_id,request.request_id,snapshot.latest_run.as_ref().map(|r|r.run.id.as_str()),encode(&safe)?,word(&snapshot.task.mode)?,encode(&snapshot.config.limits)?])?;
        tx.execute(
            "UPDATE execution_sessions SET current_run_id=?2 WHERE id=?1",
            params![snapshot.session_id, run],
        )?;
        tx.execute(
            "UPDATE tasks SET state='queued',updated_at_ms=?2 WHERE id=?1",
            params![task, now_ms()],
        )?;
        events.push(record(
            &tx,
            &self.redactor,
            Some(task),
            Some(&request.request_id),
            EventSource::Engine,
            Payload::ExecutionQueued { run_id: run },
        )?);
        tx.commit()?;
        Ok((
            Receipt {
                request_id: request.request_id.clone(),
                status: CommandStatus::Accepted,
                task_id: Some(task.into()),
                duplicate: false,
            },
            events,
        ))
    }
    pub fn activate_execution(&mut self, run: &str) -> Result<Vec<Event>> {
        let execution = self.execution_run(run)?;
        let tx = self.connection.transaction()?;
        guard(&tx, run, &["queued"])?;
        if tx.execute(
            "UPDATE runs SET state='running',started_at_ms=?2 WHERE id=?1 AND state='queued'",
            params![run, now_ms()],
        )? != 1
        {
            return Err(Error::Conflict);
        }
        tx.execute(
            "UPDATE tasks SET state='running',updated_at_ms=?2 WHERE id=?1",
            params![execution.run.task_id, now_ms()],
        )?;
        tx.execute("UPDATE agents SET data_json=json_set(data_json,'$.state','running','$.attempt',json_extract(data_json,'$.attempt')+1) WHERE id=?1",[&execution.run.agent_id])?;
        let event = record(
            &tx,
            &self.redactor,
            Some(&execution.run.task_id),
            Some(&execution.request_id),
            EventSource::Engine,
            Payload::ExecutionStarted {
                run_id: run.into(),
                predecessor_id: execution.predecessor_id,
                profile_id: execution.profile.id,
                profile_revision: execution.profile.revision,
            },
        )?;
        tx.commit()?;
        Ok(vec![event])
    }
    pub fn configure_execution(
        &mut self,
        request: &Request,
        task: &str,
        mode: WorkMode,
        profile: Option<&str>,
        limits: &ExecutionLimits,
    ) -> Result<Vec<Event>> {
        if self.cached_receipt(request)?.is_some() {
            return Ok(vec![]);
        }
        let mut snapshot = self.execution_snapshot(task)?;
        if matches!(
            snapshot.task.state,
            TaskState::Running | TaskState::Stopping
        ) || snapshot
            .latest_run
            .as_ref()
            .is_some_and(|r| r.run.state == TaskState::Queued)
        {
            return Err(Error::Busy);
        }
        if let Some(p) = profile {
            self.profile(p)?;
        }
        limits.validate().map_err(Error::Invalid)?;
        snapshot.config.mode = mode;
        snapshot.config.profile_id = profile.map(str::to_owned);
        snapshot.config.limits = limits.clone();
        let config = self.save_json(serde_json::to_value(&snapshot.config)?)?;
        if mode == WorkMode::Execute
            && snapshot
                .context
                .question
                .as_ref()
                .is_some_and(|q| q.plan_confirmation)
        {
            snapshot.context.question = None;
        }
        let context = self.save_json(serde_json::to_value(&snapshot.context)?)?;
        let tx = self.connection.transaction()?;
        let mut events = accept_command(&tx, &self.redactor, request, Some(task))?;
        tx.execute(
            "UPDATE tasks SET mode=?2,profile_id=?3,updated_at_ms=?4 WHERE id=?1",
            params![task, word(&mode)?, profile, now_ms()],
        )?;
        tx.execute(
            "UPDATE execution_sessions SET config_object_id=?2,context_object_id=?3 WHERE id=?1",
            params![snapshot.session_id, config.object_id, context.object_id],
        )?;
        events.push(record(
            &tx,
            &self.redactor,
            Some(task),
            Some(&request.request_id),
            EventSource::User,
            Payload::WorkModeChanged { mode },
        )?);
        events.extend(finish_control_tx(&tx, &self.redactor, request, task)?);
        tx.commit()?;
        Ok(events)
    }
    pub fn finish_execution(
        &mut self,
        run: &str,
        state: TaskState,
        reason: &str,
        diagnostic: Option<ModelDiagnostic>,
    ) -> Result<Vec<Event>> {
        if !matches!(
            state,
            TaskState::Completed
                | TaskState::Interrupted
                | TaskState::Failed
                | TaskState::AwaitingInput
                | TaskState::AwaitingApproval
        ) {
            return Err(Error::Invalid("invalid execution terminal state"));
        }
        let execution = self.execution_run(run)?;
        let snapshot = self.execution_snapshot(&execution.run.task_id)?;
        // The single storage worker serializes stop with final completion.
        // If stop was acknowledged first, a racing model reply cannot win.
        let (state, reason, diagnostic) = if snapshot.task.state == TaskState::Stopping {
            (TaskState::Interrupted, "user_stop", None)
        } else {
            (state, reason, diagnostic)
        };
        if state == TaskState::Completed
            && (snapshot.context.pending.is_some()
                || snapshot
                    .context
                    .plan
                    .iter()
                    .any(|p| p.status != PlanStepStatus::Done))
        {
            return Err(Error::Conflict);
        }
        if state == TaskState::Completed && !self.team_complete(&execution.run.task_id)? {
            return Err(Error::Conflict);
        }
        let output=self.save_json(json!({"text":snapshot.context.last_text,"reason":reason,"verification":"engine steps recorded; semantic result is the model's report"}))?;
        let mut diagnostic = diagnostic.map(serde_json::to_value).transpose()?;
        if let Some(d) = &mut diagnostic {
            self.redactor.value(d);
        }
        let diagnostic: Option<ModelDiagnostic> =
            diagnostic.map(serde_json::from_value).transpose()?;
        let tx = self.connection.transaction()?;
        guard(&tx, run, &["queued", "running", "stopping"])?;
        if state==TaskState::Completed && tx.query_row("SELECT EXISTS(SELECT 1 FROM messages WHERE task_id=?1 AND state IN ('queued','steer_requested'))",[&execution.run.task_id],|r|r.get::<_,bool>(0))?{return Err(Error::Busy);}
        if matches!(
            state,
            TaskState::Completed | TaskState::Failed | TaskState::Interrupted
        ) {
            tx.execute("INSERT INTO team_control(task_id,enabled) VALUES(?1,0) ON CONFLICT(task_id) DO UPDATE SET enabled=0",[&execution.run.task_id])?;
        }
        let command_status = match state {
            TaskState::Completed | TaskState::AwaitingInput | TaskState::AwaitingApproval => {
                CommandStatus::Completed
            }
            TaskState::Failed => CommandStatus::Failed,
            _ => CommandStatus::Interrupted,
        };
        tx.execute("UPDATE runs SET state=?2,ended_at_ms=?3,result_object_id=?4,failure_code=?5 WHERE id=?1",params![run,word(&state)?,now_ms(),output.object_id,if state==TaskState::Completed{None}else{Some(reason)}])?;
        tx.execute(
            "UPDATE execution_runs SET reason=?2,diagnostic_json=?3 WHERE run_id=?1",
            params![run, reason, diagnostic.as_ref().map(encode).transpose()?],
        )?;
        tx.execute(
            "UPDATE tasks SET state=?2,updated_at_ms=?3 WHERE id=?1",
            params![execution.run.task_id, word(&state)?, now_ms()],
        )?;
        tx.execute(
            "UPDATE agents SET data_json=json_set(data_json,'$.state',?2) WHERE id=?1",
            params![
                execution.run.agent_id,
                if state == TaskState::Completed {
                    "completed"
                } else if state == TaskState::Failed {
                    "failed"
                } else {
                    "interrupted"
                }
            ],
        )?;
        tx.execute(
            "UPDATE commands SET status=?2,finished_at_ms=?3 WHERE request_id=?1",
            params![execution.request_id, word(&command_status)?, now_ms()],
        )?;
        // Late network replies cannot turn a stopped run into a success.
        tx.execute("UPDATE execution_steps SET state=?3,ended_at_ms=?2 WHERE run_id=?1 AND kind='model' AND state='running'",params![run,now_ms(),if state==TaskState::Failed{"failed"}else{"cancelled"}])?;
        tx.execute("UPDATE execution_steps SET state='needs_review' WHERE run_id IN (SELECT run_id FROM execution_runs WHERE session_id=?1) AND kind='tool' AND state='running'",[&execution.session_id])?;
        tx.execute("UPDATE tool_calls SET state='needs_review' WHERE run_id IN (SELECT run_id FROM execution_runs WHERE session_id=?1) AND state='started'",[&execution.session_id])?;
        let events = vec![
            record(
                &tx,
                &self.redactor,
                Some(&execution.run.task_id),
                Some(&execution.request_id),
                EventSource::Engine,
                Payload::ExecutionEnded {
                    run_id: run.into(),
                    state,
                    reason: reason.into(),
                    diagnostic,
                    output: Some(output),
                },
            )?,
            record(
                &tx,
                &self.redactor,
                Some(&execution.run.task_id),
                Some(&execution.request_id),
                EventSource::Engine,
                Payload::TaskStateChanged {
                    state,
                    reason: Some(reason.into()),
                },
            )?,
            record(
                &tx,
                &self.redactor,
                Some(&execution.run.task_id),
                Some(&execution.request_id),
                EventSource::Engine,
                Payload::CommandFinished {
                    status: command_status,
                },
            )?,
        ];
        tx.commit()?;
        Ok(events)
    }
    pub fn recover_executions(&mut self) -> Result<()> {
        let tx = self.connection.transaction()?;
        let recover: Vec<(String, String)> = {
            let mut q=tx.prepare("SELECT e.run_id,r.task_id FROM execution_runs e JOIN runs r ON r.id=e.run_id WHERE e.reason IS NULL AND r.state IN ('queued','interrupted')")?;
            q.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<std::result::Result<_, _>>()?
        };
        // P01 recovery already interrupted active runs. Queued executions also need explicit continuation.
        tx.execute("UPDATE tasks SET state='interrupted' WHERE id IN (SELECT r.task_id FROM runs r JOIN execution_runs e ON e.run_id=r.id WHERE r.state='queued')",[])?;
        tx.execute("UPDATE runs SET state='interrupted',ended_at_ms=?1,failure_code='engine_exit' WHERE id IN (SELECT run_id FROM execution_runs) AND state='queued'",[now_ms()])?;
        tx.execute("UPDATE execution_steps SET state=CASE WHEN kind='tool' THEN 'needs_review' ELSE 'cancelled' END WHERE state='running'",[])?;
        tx.execute("UPDATE execution_runs SET reason='engine_exit' WHERE run_id IN (SELECT id FROM runs WHERE state='interrupted') AND reason IS NULL",[])?;
        for (run, task) in recover {
            record(
                &tx,
                &self.redactor,
                Some(&task),
                None,
                EventSource::Recovery,
                Payload::ExecutionEnded {
                    run_id: run,
                    state: TaskState::Interrupted,
                    reason: "engine_exit".into(),
                    diagnostic: None,
                    output: None,
                },
            )?;
            record(
                &tx,
                &self.redactor,
                Some(&task),
                None,
                EventSource::Recovery,
                Payload::TaskStateChanged {
                    state: TaskState::Interrupted,
                    reason: Some("engine_exit; manual continuation required".into()),
                },
            )?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn cancel_execution(
        &mut self,
        request: &Request,
        task: &str,
    ) -> Result<(Receipt, Vec<Event>)> {
        if let Some(receipt) = self.cached_receipt(request)? {
            return Ok((receipt, vec![]));
        }
        let snapshot = self.execution_snapshot(task)?;
        let active = snapshot
            .latest_run
            .as_ref()
            .is_some_and(|r| matches!(r.run.state, TaskState::Queued | TaskState::Running));
        if !active
            && !self
                .team_subtree(task)?
                .iter()
                .filter(|id| id.as_str() != task)
                .any(|id| {
                    self.task(id).is_ok_and(|t| {
                        matches!(
                            t.state,
                            TaskState::Queued
                                | TaskState::Running
                                | TaskState::AwaitingInput
                                | TaskState::AwaitingApproval
                                | TaskState::Stopping
                        )
                    })
                })
            && matches!(
                snapshot.task.state,
                TaskState::Completed | TaskState::Failed | TaskState::Interrupted
            )
        {
            return Err(Error::Conflict);
        }
        let state = if active {
            TaskState::Stopping
        } else {
            TaskState::Interrupted
        };
        let tx = self.connection.transaction()?;
        let mut events = accept_command(&tx, &self.redactor, request, Some(task))?;
        tx.execute("WITH RECURSIVE tree(id) AS (SELECT ?1 UNION ALL SELECT m.task_id FROM team_members m JOIN tree t ON m.parent_task_id=t.id) UPDATE team_control SET enabled=0 WHERE task_id IN (SELECT id FROM tree)",[task])?;
        tx.execute(
            "UPDATE tasks SET state=?2,updated_at_ms=?3 WHERE id=?1",
            params![task, word(&state)?, now_ms()],
        )?;
        events.push(record(
            &tx,
            &self.redactor,
            Some(task),
            Some(&request.request_id),
            EventSource::User,
            Payload::CancelRequested,
        )?);
        events.push(record(
            &tx,
            &self.redactor,
            Some(task),
            Some(&request.request_id),
            EventSource::User,
            Payload::TaskStateChanged {
                state,
                reason: Some("user_stop".into()),
            },
        )?);
        events.extend(finish_control_tx(&tx, &self.redactor, request, task)?);
        tx.commit()?;
        Ok((
            Receipt {
                request_id: request.request_id.clone(),
                status: CommandStatus::Completed,
                task_id: Some(task.into()),
                duplicate: false,
            },
            events,
        ))
    }
}
fn guard(connection: &Connection, run: &str, allowed: &[&str]) -> Result<()> {
    let (current,state,task_state):(String,String,String)=connection.query_row("SELECT s.current_run_id,r.state,t.state FROM execution_runs e JOIN runs r ON r.id=e.run_id JOIN execution_sessions s ON s.id=e.session_id JOIN tasks t ON t.id=r.task_id WHERE r.id=?1",[run],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?.ok_or(Error::NotFound)?;
    if current != run
        || !allowed.contains(&state.as_str())
        || (!allowed.contains(&"stopping") && task_state == "stopping")
    {
        return Err(Error::Conflict);
    }
    Ok(())
}
fn guard_action(connection: &Connection, run: &str, action: &str) -> Result<()> {
    guard(connection, run, &["running"])?;
    let owns:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM execution_steps a JOIN execution_runs old ON old.run_id=a.run_id JOIN execution_runs current ON current.session_id=old.session_id WHERE a.id=?1 AND current.run_id=?2)",params![action,run],|r|r.get(0))?;
    if !owns {
        return Err(Error::Conflict);
    }
    Ok(())
}
fn checkpoint(
    connection: &Connection,
    redactor: &Redactor,
    run: &str,
    content: &ContentRef,
    phase: &str,
) -> Result<Event> {
    let (session,task,previous):(String,String,Option<String>)=connection.query_row("SELECT s.id,s.task_id,s.checkpoint_id FROM execution_runs e JOIN execution_sessions s ON s.id=e.session_id WHERE e.run_id=?1",[run],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    let checkpoint = id();
    connection.execute("INSERT INTO execution_checkpoints(id,session_id,run_id,predecessor_id,context_object_id,phase,created_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![checkpoint,session,run,previous,content.object_id,phase,now_ms()])?;
    connection.execute(
        "UPDATE execution_sessions SET context_object_id=?2,checkpoint_id=?3 WHERE id=?1",
        params![session, content.object_id, checkpoint],
    )?;
    record(
        connection,
        redactor,
        Some(&task),
        None,
        EventSource::Engine,
        Payload::CheckpointSaved {
            run_id: run.into(),
            checkpoint_id: checkpoint,
            phase: phase.into(),
        },
    )
}
pub(super) fn finish_control_tx(
    connection: &Connection,
    redactor: &Redactor,
    request: &Request,
    task: &str,
) -> Result<Vec<Event>> {
    connection.execute(
        "UPDATE commands SET status='completed',finished_at_ms=?2 WHERE request_id=?1",
        params![request.request_id, now_ms()],
    )?;
    Ok(vec![record(
        connection,
        redactor,
        Some(task),
        Some(&request.request_id),
        EventSource::Engine,
        Payload::CommandFinished {
            status: CommandStatus::Completed,
        },
    )?])
}
