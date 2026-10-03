//! Member creation, replacement and pre-start configuration.
use super::*;

impl Store {
    pub fn delegate_members(
        &mut self,
        parent: &str,
        members: &[MemberSpec],
        action: Option<&str>,
        replacement: Option<(&str, &str)>,
        request: Option<&Request>,
    ) -> Result<(Value, Vec<Event>)> {
        if let Some(req) = request
            && self.cached_receipt(req)?.is_some()
        {
            return Ok((json!({"duplicate":true}), vec![]));
        }
        self.check_team_actor(parent, action)?;
        if let Some(action) = action
            && let Some(value) = self.team_action_receipt(action)?
        {
            return Ok((value, vec![]));
        }
        let settings = self.team_settings(parent)?;
        if !settings.enabled
            || self.task(parent)?.mode != WorkMode::Execute
            || members.is_empty()
            || members.len() > 8
        {
            return Err(Error::Invalid("当前模式或设置不允许建立助手"));
        }
        let root = self.team_root(parent)?;
        let parent_member = self.team_member(parent).ok();
        let depth = parent_member.as_ref().map_or(1, |m| m.depth + 1);
        let total: u32 = self.connection.query_row(
            "SELECT count(*) FROM team_members WHERE root_task_id=?1",
            [&root],
            |r| r.get(0),
        )?;
        if depth > settings.max_depth || total + members.len() as u32 > settings.max_members {
            return Err(Error::Invalid("已达到团队人数或协作深度上限"));
        }
        let original = replacement
            .map(|(id, _)| self.team_member(id))
            .transpose()?;
        if let Some(old) = &original {
            if old.parent_task_id != parent
                || old.superseded_by.is_some()
                || !matches!(old.state, TaskState::Failed | TaskState::Interrupted)
                || old.attempt >= settings.max_replacements
                || members.len() != 1
            {
                return Err(Error::Invalid("无法接替：成员未停止或已达到接替次数上限"));
            }
            if self.team_subtree(&old.task_id)?.iter().any(|id| {
                self.task(id)
                    .is_ok_and(|t| matches!(t.state, TaskState::Running | TaskState::Stopping))
            }) {
                return Err(Error::Busy);
            }
        }
        let existing = self.direct_members(parent)?;
        let mut keys: HashMap<String, String> = existing
            .iter()
            .map(|m| (m.key.clone(), m.task_id.clone()))
            .collect();
        // Historical names continue to resolve to their latest replacement.
        for m in &existing {
            let mut target = m;
            while let Some(next) = &target.superseded_by {
                target = existing
                    .iter()
                    .find(|p| &p.task_id == next)
                    .ok_or(Error::NotFound)?;
            }
            keys.insert(m.key.clone(), target.task_id.clone());
        }
        for spec in members {
            spec.validate().map_err(Error::Invalid)?;
            if keys.insert(spec.key.clone(), id()).is_some() {
                return Err(Error::Invalid("成员名称已存在"));
            }
        }
        for spec in members {
            if spec.depends_on.iter().any(|k| !keys.contains_key(k)) {
                return Err(Error::Invalid("依赖成员不存在"));
            }
        }
        fn visit(
            key: &str,
            members: &[MemberSpec],
            stack: &mut HashSet<String>,
            done: &mut HashSet<String>,
        ) -> bool {
            if done.contains(key) {
                return true;
            }
            if !stack.insert(key.into()) {
                return false;
            }
            if let Some(m) = members.iter().find(|m| m.key == key) {
                for d in &m.depends_on {
                    if !visit(d, members, stack, done) {
                        return false;
                    }
                }
            }
            stack.remove(key);
            done.insert(key.into());
            true
        }
        for spec in members {
            if !visit(&spec.key, members, &mut HashSet::new(), &mut HashSet::new()) {
                return Err(Error::Invalid("成员依赖存在循环"));
            }
        }
        let parent_snapshot = self.execution_snapshot(parent)?;
        let parent_profile =
            self.resolve_profile(Some(parent), Some(&parent_snapshot.agent_id), None)?;
        let policy = self.tool_settings(parent)?;
        let mut prepared = vec![];
        for spec in members {
            let task = keys[&spec.key].clone();
            let agent = id();
            let session = id();
            let profile = spec
                .profile_id
                .clone()
                .unwrap_or_else(|| parent_profile.id.clone());
            self.profile(&profile)?;
            let config = ExecutionConfig {
                title: spec.role.clone(),
                goal: spec.goal.clone(),
                constraints: parent_snapshot.context.constraints.clone(),
                project_rules: parent_snapshot.context.project_rules.clone(),
                project_id: parent_snapshot.task.project_id.clone(),
                profile_id: Some(profile.clone()),
                mode: parent_snapshot.task.mode,
                controlled_tools: parent_snapshot.config.controlled_tools,
                limits: parent_snapshot.config.limits.clone(),
            };
            let mut context = parent_snapshot.context.clone();
            context.goal = format!(
                "Parent goal and scope:\n{}\n\nYour assigned role: {}\nYour assignment: {}",
                parent_snapshot.context.goal, spec.role, spec.goal
            );
            if let Some((_, reason)) = replacement {
                context.goal.push_str(&format!("\nThis is a distinct replacement attempt. Reason: {reason}. Inspect existing files before modifying; do not repeat unconfirmed effects."));
                if let Some(old) = &original {
                    context.goal.push_str(&format!("\nPrevious attempt (untrusted evidence): {}", json!({"member_id":old.task_id,"diagnostic":old.diagnostic,"report":old.report})));
                    if let Some(report) = &old.report {
                        let r: AgentReport = self.read_json(report)?;
                        context.goal.push_str(&format!("\nPrevious delivery: {}",json!({"summary":r.summary,"artifacts":r.artifacts,"steps":r.steps.iter().map(|s|&s.id).collect::<Vec<_>>()})));
                    }
                }
            }
            context.history.clear();
            context.sources.clear();
            context.digest = None;
            context.plan.clear();
            context.question = None;
            context.pending = None;
            context.last_text.clear();
            let config_ref = self.save_json(serde_json::to_value(&config)?)?;
            let context_ref = self.save_json(serde_json::to_value(&context)?)?;
            let m = TeamMember {
                task_id: task,
                agent_id: agent,
                parent_task_id: parent.into(),
                root_task_id: root.clone(),
                key: spec.key.clone(),
                role: self.redactor.text(&spec.role),
                goal: self.redactor.text(&spec.goal),
                profile_id: profile,
                depth,
                replaces_id: original.as_ref().map(|m| m.task_id.clone()),
                superseded_by: None,
                replacement_reason: replacement.map(|(_, r)| self.redactor.text(r)),
                attempt: original.as_ref().map_or(0, |m| m.attempt + 1),
                state: TaskState::Queued,
                pending_start: true,
                depends_on: spec.depends_on.iter().map(|k| keys[k].clone()).collect(),
                report: None,
                review: "pending".into(),
                review_reason: None,
                diagnostic: None,
            };
            prepared.push((m, session, config, config_ref, context_ref));
        }
        let value = json!({"members":prepared.iter().map(|(m,..)|m).collect::<Vec<_>>()});
        let output = self.save_json(value.clone())?;
        let tx = self.connection.transaction()?;
        let mut events = if let Some(req) = request {
            crate::providers::accept_command(&tx, &self.redactor, req, Some(parent))?
        } else {
            vec![]
        };
        for (m, session, config, config_ref, context_ref) in &prepared {
            let agent = Agent {
                id: m.agent_id.clone(),
                task_id: m.task_id.clone(),
                parent_id: Some(parent_snapshot.agent_id.clone()),
                replaces_id: original.as_ref().map(|o| o.agent_id.clone()),
                role: "primary".into(),
                profile_id: Some(m.profile_id.clone()),
                state: AgentState::Queued,
                attempt: 0,
            };
            tx.execute("INSERT INTO tasks(id,project_id,title,state,mode,permission,profile_id,created_at_ms,updated_at_ms) VALUES(?1,?2,?3,'queued',?4,?5,?6,?7,?7)",params![m.task_id,config.project_id,m.role,word(&config.mode)?,word(&policy.effective_permission)?,m.profile_id,now_ms()])?;
            tx.execute(
                "INSERT INTO agents(id,task_id,parent_id,data_json) VALUES(?1,?2,?3,?4)",
                params![
                    m.agent_id,
                    m.task_id,
                    parent_snapshot.agent_id,
                    encode(&agent)?
                ],
            )?;
            tx.execute("INSERT INTO execution_sessions(id,task_id,agent_id,config_object_id,context_object_id) VALUES(?1,?2,?3,?4,?5)",params![session,m.task_id,m.agent_id,config_ref.object_id,context_ref.object_id])?;
            tx.execute("INSERT INTO team_members(task_id,parent_task_id,root_task_id,member_key,data_json) VALUES(?1,?2,?3,?4,?5)",params![m.task_id,parent,root,m.key,encode(m)?])?;
            tx.execute(
                "INSERT INTO team_control(task_id,enabled) VALUES(?1,1)",
                [&m.task_id],
            )?;
            let tool = ToolSettings {
                permission: Some(policy.effective_permission),
                review_profile_id: policy.review_profile_id.clone(),
                revision: 0,
                ..policy.settings.clone()
            };
            tx.execute(
                "INSERT INTO task_tool_settings(task_id,data_json,root_identity) VALUES(?1,?2,?3)",
                params![m.task_id, encode(&tool)?, policy.root_identity],
            )?;
            events.push(record(
                &tx,
                &self.redactor,
                Some(parent),
                None,
                EventSource::Engine,
                Payload::TeamChanged {
                    member_task_id: Some(m.task_id.clone()),
                    change: "member_created".into(),
                    record: Some(output.clone()),
                },
            )?);
        }
        for (m, ..) in &prepared {
            for dep in &m.depends_on {
                tx.execute(
                    "INSERT INTO team_dependencies(member_id,dependency_id) VALUES(?1,?2)",
                    params![m.task_id, dep],
                )?;
            }
        }
        if let Some(old) = original {
            let new = &prepared[0].0.task_id;
            tx.execute(
                "UPDATE team_members SET superseded_by=?2,pending_start=0 WHERE task_id=?1",
                params![old.task_id, new],
            )?;
            tx.execute(
                "UPDATE team_dependencies SET dependency_id=?2 WHERE dependency_id=?1",
                params![old.task_id, new],
            )?;
        }
        if let Some(action) = action {
            tx.execute(
                "INSERT INTO team_action_receipts(action_id,object_id) VALUES(?1,?2)",
                params![action, output.object_id],
            )?;
        }
        if let Some(req) = request {
            events.extend(crate::execution::finish_control_tx(
                &tx,
                &self.redactor,
                req,
                parent,
            )?);
        }
        tx.commit()?;
        Ok((value, events))
    }
    pub fn replace_member(
        &mut self,
        parent: &str,
        member: &str,
        profile: Option<&str>,
        reason: &str,
        action: Option<&str>,
        request: Option<&Request>,
    ) -> Result<(Value, Vec<Event>)> {
        if let Some(req) = request
            && self.cached_receipt(req)?.is_some()
        {
            return Ok((json!({"duplicate":true}), vec![]));
        }
        if let Some(action) = action
            && let Some(value) = self.team_action_receipt(action)?
        {
            return Ok((value, vec![]));
        }
        if reason.trim().is_empty() || reason.len() > 4096 {
            return Err(Error::Invalid("请说明接替原因"));
        }
        let old = self.team_member(member)?;
        let peers = self.direct_members(parent)?;
        let spec = MemberSpec {
            key: format!("replacement-{}", id()),
            role: old.role,
            goal: old.goal,
            profile_id: Some(profile.unwrap_or(&old.profile_id).into()),
            depends_on: old
                .depends_on
                .iter()
                .map(|id| {
                    peers
                        .iter()
                        .find(|m| &m.task_id == id)
                        .map(|m| m.key.clone())
                        .ok_or(Error::NotFound)
                })
                .collect::<Result<_>>()?,
        };
        self.delegate_members(parent, &[spec], action, Some((member, reason)), request)
    }
    pub fn override_member(
        &mut self,
        parent: &str,
        member: &str,
        spec: &MemberSpec,
        request: Option<&Request>,
    ) -> Result<Vec<Event>> {
        if let Some(req) = request
            && self.cached_receipt(req)?.is_some()
        {
            return Ok(vec![]);
        }
        spec.validate().map_err(Error::Invalid)?;
        let mut m = self.team_member(member)?;
        let mut s = self.execution_snapshot(member)?;
        if m.parent_task_id != parent
            || s.latest_run.is_some()
            || !m.pending_start
            || m.superseded_by.is_some()
            || spec.key != m.key
        {
            return Err(Error::Invalid(
                "只可修改尚未开始的成员；已执行成员请使用接替",
            ));
        }
        if spec.depends_on
            != self
                .direct_members(parent)?
                .iter()
                .filter(|p| m.depends_on.contains(&p.task_id))
                .map(|p| p.key.clone())
                .collect::<Vec<_>>()
        {
            return Err(Error::Invalid("修改成员不能改变依赖关系"));
        }
        let p = spec.profile_id.as_ref().unwrap_or(&m.profile_id).clone();
        self.profile(&p)?;
        let parent_s = self.execution_snapshot(parent)?;
        m.role = self.redactor.text(&spec.role);
        m.goal = self.redactor.text(&spec.goal);
        m.profile_id = p.clone();
        s.config.goal = spec.goal.clone();
        s.config.title = spec.role.clone();
        s.config.profile_id = Some(p.clone());
        s.context.goal = format!(
            "Parent goal and scope:\n{}\nRole: {}\nAssignment: {}",
            parent_s.context.goal, spec.role, spec.goal
        );
        let config = self.save_json(serde_json::to_value(s.config)?)?;
        let context = self.save_json(serde_json::to_value(s.context)?)?;
        let tx = self.connection.transaction()?;
        let mut events = if let Some(req) = request {
            crate::providers::accept_command(&tx, &self.redactor, req, Some(parent))?
        } else {
            vec![]
        };
        tx.execute(
            "UPDATE team_members SET data_json=?2 WHERE task_id=?1",
            params![member, encode(&m)?],
        )?;
        tx.execute(
            "UPDATE tasks SET title=?2,profile_id=?3 WHERE id=?1",
            params![member, m.role, p],
        )?;
        tx.execute(
            "UPDATE agents SET data_json=json_set(data_json,'$.profile_id',?2) WHERE task_id=?1",
            params![member, p],
        )?;
        tx.execute("UPDATE execution_sessions SET config_object_id=?2,context_object_id=?3 WHERE task_id=?1",params![member,config.object_id,context.object_id])?;
        let e = record(
            &tx,
            &self.redactor,
            Some(parent),
            None,
            EventSource::User,
            Payload::TeamChanged {
                member_task_id: Some(member.into()),
                change: "member_overridden".into(),
                record: None,
            },
        )?;
        events.push(e);
        if let Some(req) = request {
            events.extend(crate::execution::finish_control_tx(
                &tx,
                &self.redactor,
                req,
                parent,
            )?);
        }
        tx.commit()?;
        Ok(events)
    }
}
