use super::*;

const ACTIVE: &str = "WITH RECURSIVE tree(id) AS (SELECT ?1 UNION ALL SELECT m.task_id FROM team_members m JOIN tree t ON m.parent_task_id=t.id) SELECT EXISTS(SELECT 1 FROM tasks WHERE id IN (SELECT id FROM tree) AND state IN ('queued','running','stopping','awaiting_input','awaiting_approval')) OR EXISTS(SELECT 1 FROM workbench_operations WHERE task_id IN (SELECT id FROM tree) AND json_extract(data_json,'$.state') IN ('queued','running','stopping','awaiting_approval'))";

impl Store {
    pub fn schedule_plan(&self, id: &str) -> Result<SchedulePlan> {
        let (raw,next,enabled,deleted):(String,Option<u64>,bool,bool)=self.connection.query_row("SELECT s.data_json,c.next_at_ms,c.enabled,c.deleted FROM schedules s JOIN schedule_cursor c ON c.schedule_id=s.id WHERE s.id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?.ok_or(Error::NotFound)?;
        let mut p: SchedulePlan = serde_json::from_str(&raw)?;
        p.next_at_ms = next;
        p.spec.enabled = enabled;
        p.deleted = deleted;
        Ok(p)
    }
    pub fn schedule_occurrence(&self, id: &str) -> Result<ScheduleOccurrence> {
        let mut v=self.connection.query_row("SELECT o.sequence,o.id,o.schedule_id,o.revision,o.due_at_ms,o.recorded_at_ms,o.trigger,o.state,o.reason,o.task_id,t.state,o.missed_count,o.missed_until_ms,o.plan_object_id FROM schedule_occurrences o LEFT JOIN tasks t ON t.id=o.task_id WHERE o.id=?1",[id],|r|{
            let state:Option<String>=r.get(10)?;
            Ok((ScheduleOccurrence{sequence:r.get(0)?,id:r.get(1)?,schedule_id:r.get(2)?,revision:r.get(3)?,due_at_ms:r.get(4)?,recorded_at_ms:r.get(5)?,trigger:r.get(6)?,state:r.get(7)?,reason:r.get(8)?,task_id:r.get(9)?,task_state:None,active:false,missed_count:r.get(11)?,missed_until_ms:r.get(12)?,plan:ContentRef{object_id:r.get(13)?,bytes:0,media_type:String::new()}},state))
        }).optional()?.ok_or(Error::NotFound)?;
        v.0.task_state = v.1.map(parse_word).transpose()?;
        v.0.plan = content_ref(&self.connection, &v.0.plan.object_id)?;
        v.0.active = v.0.state == "claimed"
            || v.0
                .task_id
                .as_deref()
                .map(|id| {
                    self.connection
                        .query_row(ACTIVE, [id], |r| r.get::<_, bool>(0))
                })
                .transpose()?
                .unwrap_or(false);
        Ok(v.0)
    }
    pub fn schedule_bindings(&self, p: &SchedulePlan) -> Result<()> {
        if self.profile(&p.spec.profile_id)?.revision != p.profile_revision {
            return Err(Error::Invalid(
                "模型配置已变化，请重新保存计划 / Model changed; save the plan again",
            ));
        }
        if let Some(id) = &p.spec.review_profile_id
            && Some(self.profile(id)?.revision) != p.review_profile_revision
        {
            return Err(Error::Invalid(
                "审批模型已变化，请重新保存计划 / Review model changed; save again",
            ));
        }
        if let Some(id) = &p.spec.project_id
            && Some(self.workspace_project(id)?.settings.revision) != p.project_revision
        {
            return Err(Error::Invalid(
                "项目设置已变化，请重新保存计划 / Project changed; save again",
            ));
        }
        Ok(())
    }
    pub fn schedule_active(&self, id: &str, except_task: Option<&str>) -> Result<bool> {
        Ok(self.connection.query_row("SELECT EXISTS(SELECT 1 FROM schedule_occurrences WHERE schedule_id=?1 AND state='claimed' AND (?2 IS NULL OR task_id IS NULL OR task_id<>?2)) OR EXISTS(SELECT 1 FROM tasks t LEFT JOIN team_members m ON m.task_id=t.id JOIN schedule_occurrences o ON o.task_id=COALESCE(m.root_task_id,t.id) WHERE o.schedule_id=?1 AND (?2 IS NULL OR o.task_id<>?2) AND t.state IN ('queued','running','stopping','awaiting_input','awaiting_approval')) OR EXISTS(SELECT 1 FROM workbench_operations w LEFT JOIN team_members m ON m.task_id=w.task_id JOIN schedule_occurrences o ON o.task_id=COALESCE(m.root_task_id,w.task_id) WHERE o.schedule_id=?1 AND (?2 IS NULL OR o.task_id<>?2) AND json_extract(w.data_json,'$.state') IN ('queued','running','stopping','awaiting_approval'))",params![id,except_task],|r|r.get(0))?)
    }
    pub(crate) fn schedule_can_start(&self, task: &str, profile: &ProviderProfile) -> Result<()> {
        let root = self.team_root(task)?;
        let plan: Option<String> = self
            .connection
            .query_row(
                "SELECT schedule_id FROM schedule_occurrences WHERE task_id=?1",
                [&root],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(plan) = plan {
            if self.schedule_active(&plan, Some(&root))? {
                return Err(Error::Invalid(
                    "同一计划已有任务在运行或等待处理，请先处理它 / Another occurrence is active; finish it first",
                ));
            }
            let claimed: bool = self.connection.query_row(
                "SELECT state='claimed' FROM schedule_occurrences WHERE task_id=?1",
                [&root],
                |r| r.get(0),
            )?;
            if claimed && root == task {
                let p = self.schedule_plan(&plan)?;
                self.schedule_bindings(&p)?;
                if profile.id != p.spec.profile_id || profile.revision != p.profile_revision {
                    return Err(Error::Conflict);
                }
            }
        }
        Ok(())
    }
    pub fn schedule_action(
        &mut self,
        request: &Request,
        now: u64,
    ) -> Result<(ScheduleData, Vec<Event>)> {
        request.validate().map_err(Error::Invalid)?;
        let Command::Schedules { action } = &request.command else {
            return Err(Error::Invalid("schedule request"));
        };
        if now > schedule_time::MAX_TIME {
            return Err(Error::Invalid("system clock out of range"));
        }
        match action {
            ScheduleAction::List {
                include_deleted,
                offset,
                limit,
            } => {
                let total = self.connection.query_row(
                    "SELECT count(*) FROM schedule_cursor WHERE ?1 OR deleted=0",
                    [include_deleted],
                    |r| r.get(0),
                )?;
                let mut q=self.connection.prepare("SELECT schedule_id FROM schedule_cursor WHERE ?1 OR deleted=0 ORDER BY rowid DESC LIMIT ?2 OFFSET ?3")?;
                let ids = q
                    .query_map(params![include_deleted, limit, offset], |r| {
                        r.get::<_, String>(0)
                    })?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                return Ok((
                    ScheduleData::List {
                        total,
                        items: ids
                            .iter()
                            .map(|id| self.schedule_plan(id))
                            .collect::<Result<Vec<_>>>()?,
                    },
                    vec![],
                ));
            }
            ScheduleAction::Timezones => {
                return Ok((
                    ScheduleData::Timezones {
                        zones: chrono_tz::TZ_VARIANTS
                            .iter()
                            .map(ToString::to_string)
                            .collect(),
                        version: chrono_tz::IANA_TZDB_VERSION.into(),
                    },
                    vec![],
                ));
            }
            ScheduleAction::Preview { timezone, rule } => {
                return Ok((
                    ScheduleData::Preview {
                        next_at_ms: schedule_time::next(rule, timezone, now, now)?,
                        timezone_database: chrono_tz::IANA_TZDB_VERSION.into(),
                    },
                    vec![],
                ));
            }
            ScheduleAction::History {
                schedule_id,
                before,
                limit,
            } => {
                self.schedule_plan(schedule_id)?;
                let mut q=self.connection.prepare("SELECT id FROM schedule_occurrences WHERE schedule_id=?1 AND (?2 IS NULL OR sequence<?2) ORDER BY sequence DESC LIMIT ?3")?;
                let ids = q
                    .query_map(params![schedule_id, before, limit + 1], |r| {
                        r.get::<_, String>(0)
                    })?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                return Ok((
                    ScheduleData::History {
                        has_more: ids.len() > *limit as usize,
                        items: ids
                            .into_iter()
                            .take(*limit as usize)
                            .map(|id| self.schedule_occurrence(&id))
                            .collect::<Result<Vec<_>>>()?,
                    },
                    vec![],
                ));
            }
            _ => {}
        }
        if self.cached_receipt(request)?.is_some() {
            let (id, occ): (String, Option<String>) = self.connection.query_row(
                "SELECT schedule_id,occurrence_id FROM schedule_commands WHERE request_id=?1",
                [&request.request_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            let data = if let Some(occ) = occ {
                ScheduleData::Run {
                    occurrence: Box::new(self.schedule_occurrence(&occ)?),
                }
            } else {
                ScheduleData::Updated { schedule_id: id }
            };
            return Ok((data, vec![]));
        }
        if let ScheduleAction::RunNow {
            schedule_id,
            revision,
        } = action
        {
            let p = self.schedule_plan(schedule_id)?;
            if p.deleted || p.revision != *revision {
                return Err(Error::Conflict);
            }
            self.schedule_bindings(&p)?;
            if self.schedule_active(schedule_id, None)? {
                return Err(Error::Invalid(
                    "上次任务还在运行或等待处理 / Previous occurrence is still active",
                ));
            }
            let reference = self.schedule_reference(schedule_id)?;
            let occurrence = id();
            let tx = self
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            let mut events = super::providers::accept_command(&tx, &self.redactor, request, None)?;
            claim(
                &tx,
                &p,
                &reference,
                &occurrence,
                now,
                now,
                "manual",
                &format!("manual:{}", request.request_id),
                "claimed",
                None,
                None,
                None,
            )?;
            events.push(schedule_event(
                &tx,
                &self.redactor,
                &p.id,
                "manual_claimed",
                Some(&reference),
                None,
            )?);
            events.push(finish(
                &tx,
                &self.redactor,
                request,
                &p.id,
                Some(&occurrence),
            )?);
            tx.commit()?;
            return Ok((
                ScheduleData::Run {
                    occurrence: Box::new(self.schedule_occurrence(&occurrence)?),
                },
                events,
            ));
        }
        let mut p = match action {
            ScheduleAction::Save {
                schedule_id: None,
                revision: 0,
                spec,
            } => {
                let count: u32 = self.connection.query_row(
                    "SELECT count(*) FROM schedule_cursor WHERE deleted=0",
                    [],
                    |r| r.get(0),
                )?;
                if count >= 128 {
                    return Err(Error::Invalid(
                        "计划数量已达到 128 个上限 / Schedule limit reached",
                    ));
                }
                SchedulePlan {
                    id: id(),
                    revision: 0,
                    spec: spec.clone(),
                    project_revision: None,
                    profile_revision: 0,
                    review_profile_revision: None,
                    next_at_ms: None,
                    created_at_ms: now,
                    updated_at_ms: now,
                    deleted: false,
                }
            }
            ScheduleAction::Save {
                schedule_id: Some(id),
                revision,
                ..
            }
            | ScheduleAction::SetEnabled {
                schedule_id: id,
                revision,
                ..
            }
            | ScheduleAction::Delete {
                schedule_id: id,
                revision,
            } => {
                let p = self.schedule_plan(id)?;
                if p.deleted || p.revision != *revision {
                    return Err(Error::Conflict);
                }
                p
            }
            _ => return Err(Error::Invalid("schedule version")),
        };
        let previous_high = self
            .connection
            .query_row(
                "SELECT high_water_ms FROM schedule_cursor WHERE schedule_id=?1",
                [&p.id],
                |r| r.get::<_, u64>(0),
            )
            .optional()?
            .unwrap_or(now);
        let after = now.max(previous_high);
        let change = match action {
            ScheduleAction::Save { spec, .. } => {
                p.spec = spec.clone();
                p.spec.title = self.redactor.text(spec.title.trim());
                p.spec.goal = self.redactor.text(spec.goal.trim());
                // Explicit reviewer prevents a later global-default edit from changing unattended authority.
                if p.spec.permission == PermissionMode::AutoReview
                    && p.spec.review_profile_id.is_none()
                {
                    p.spec.review_profile_id = Some(p.spec.profile_id.clone());
                }
                p.profile_revision = self.profile(&p.spec.profile_id)?.revision;
                p.review_profile_revision = p
                    .spec
                    .review_profile_id
                    .as_deref()
                    .map(|id| self.profile(id).map(|v| v.revision))
                    .transpose()?;
                p.project_revision = p
                    .spec
                    .project_id
                    .as_deref()
                    .map(|id| self.workspace_project(id).map(|v| v.settings.revision))
                    .transpose()?;
                "saved"
            }
            ScheduleAction::SetEnabled { enabled, .. } => {
                p.spec.enabled = *enabled;
                if *enabled {
                    self.schedule_bindings(&p)?;
                }
                "enabled_changed"
            }
            ScheduleAction::Delete { .. } => {
                p.deleted = true;
                p.spec.enabled = false;
                "deleted"
            }
            _ => unreachable!(),
        };
        p.spec.validate().map_err(Error::Invalid)?;
        let next = schedule_time::next(&p.spec.rule, &p.spec.timezone, after, after)?;
        if p.spec.enabled && next.is_none() {
            return Err(Error::Invalid(
                "计划时间已过去，请修改时间再启用 / Choose a future time before enabling",
            ));
        }
        p.next_at_ms = if p.spec.enabled { next } else { None };
        p.revision = p.revision.checked_add(1).ok_or(Error::Conflict)?;
        p.updated_at_ms = now;
        let object = self.save_json(serde_json::to_value(&p)?)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut events = super::providers::accept_command(&tx, &self.redactor, request, None)?;
        tx.execute("INSERT INTO schedules(id,project_id,object_id,data_json) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,object_id=excluded.object_id,data_json=excluded.data_json",params![p.id,p.spec.project_id,object.object_id,encode(&p)?])?;
        tx.execute("INSERT INTO schedule_cursor(schedule_id,revision,enabled,deleted,next_at_ms,high_water_ms) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(schedule_id) DO UPDATE SET revision=excluded.revision,enabled=excluded.enabled,deleted=excluded.deleted,next_at_ms=excluded.next_at_ms,high_water_ms=excluded.high_water_ms",params![p.id,p.revision,p.spec.enabled,p.deleted,p.next_at_ms,after])?;
        events.push(schedule_event(
            &tx,
            &self.redactor,
            &p.id,
            change,
            Some(&object),
            None,
        )?);
        events.push(finish(&tx, &self.redactor, request, &p.id, None)?);
        tx.commit()?;
        Ok((ScheduleData::Updated { schedule_id: p.id }, events))
    }
    fn schedule_reference(&self, id: &str) -> Result<ContentRef> {
        let object: String = self.connection.query_row(
            "SELECT object_id FROM schedules WHERE id=?1",
            [id],
            |r| r.get(0),
        )?;
        content_ref(&self.connection, &object)
    }
    /// Polling is injected with wall-clock time. Each due instant is durably consumed
    /// before creating a task, including missed/overlap/invalid-configuration outcomes.
    pub fn schedule_tick(
        &mut self,
        now: u64,
        gap: Option<&str>,
    ) -> Result<(Vec<String>, Vec<Event>)> {
        if now > schedule_time::MAX_TIME {
            return Err(Error::Invalid("system clock out of range"));
        }
        let ids = {
            let mut q=self.connection.prepare("SELECT schedule_id FROM schedule_cursor WHERE enabled=1 AND deleted=0 AND next_at_ms<=?1 ORDER BY next_at_ms,schedule_id LIMIT 8")?;
            q.query_map([now], |r| r.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?
        };
        let mut dispatch = vec![];
        let mut events = vec![];
        for id in ids {
            let p = self.schedule_plan(&id)?;
            let due = p.next_at_ms.ok_or(Error::Conflict)?;
            let reference = self.schedule_reference(&id)?;
            let overdue = gap.is_some() || now.saturating_sub(due) > 5000;
            let (state, reason) = if overdue {
                ("missed", Some(gap.unwrap_or("missed_deadline").to_owned()))
            } else if self.schedule_active(&id, None)? {
                ("overlap", Some("previous_occurrence_active".into()))
            } else if let Err(e) = self.schedule_bindings(&p) {
                ("failed",Some(self.redactor.text(&format!("配置无法使用，请检查模型或项目并重新保存 / Configuration unavailable; save the plan again: {e}"))))
            } else {
                ("claimed", None)
            };
            // Advancing from now coalesces any missed range instead of replaying it.
            let next = schedule_time::next(&p.spec.rule, &p.spec.timezone, now, due)?;
            let occurrence = super::id();
            let tx = self
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            let key = format!("timer:{id}:{}:{due}", p.revision);
            claim(
                &tx,
                &p,
                &reference,
                &occurrence,
                due,
                now,
                "timer",
                &key,
                state,
                reason.as_deref(),
                if overdue {
                    schedule_time::missed_count(&p.spec.rule, due, now)
                } else {
                    None
                },
                overdue.then_some(now),
            )?;
            tx.execute("UPDATE schedule_cursor SET next_at_ms=?2,high_water_ms=MAX(high_water_ms,?3) WHERE schedule_id=?1",params![id,next,now])?;
            events.push(schedule_event(
                &tx,
                &self.redactor,
                &id,
                state,
                Some(&reference),
                None,
            )?);
            tx.commit()?;
            if state == "claimed" {
                dispatch.push(occurrence);
            }
        }
        Ok((dispatch, events))
    }
    pub fn schedule_dispatch_plan(&self, occurrence: &str) -> Result<SchedulePlan> {
        let o = self.schedule_occurrence(occurrence)?;
        if o.state != "claimed" {
            return Err(Error::Conflict);
        }
        let p: SchedulePlan = self.read_json(&o.plan)?;
        let current = self.schedule_plan(&o.schedule_id)?;
        if current.deleted || current.revision != o.revision {
            return Err(Error::Conflict);
        }
        self.schedule_bindings(&p)?;
        Ok(p)
    }
    pub fn schedule_attach(&mut self, occurrence: &str, task: &str) -> Result<Vec<Event>> {
        let o = self.schedule_occurrence(occurrence)?;
        if o.state != "claimed" || o.task_id.as_deref().is_some_and(|t| t != task) {
            return Err(Error::Conflict);
        }
        let tx = self.connection.transaction()?;
        tx.execute(
            "UPDATE schedule_occurrences SET task_id=?2 WHERE id=?1",
            params![occurrence, task],
        )?;
        let e = schedule_event(
            &tx,
            &self.redactor,
            &o.schedule_id,
            "task_created",
            Some(&o.plan),
            Some(task),
        )?;
        tx.commit()?;
        Ok(vec![e])
    }
    pub fn schedule_finish_dispatch(
        &mut self,
        occurrence: &str,
        error: Option<&str>,
    ) -> Result<Vec<Event>> {
        let o = self.schedule_occurrence(occurrence)?;
        if o.state != "claimed" {
            return Ok(vec![]);
        }
        let reason = error.map(|e| self.redactor.text(e));
        let state = if error.is_some() {
            "failed"
        } else {
            "dispatched"
        };
        let tx = self.connection.transaction()?;
        tx.execute(
            "UPDATE schedule_occurrences SET state=?2,reason=?3 WHERE id=?1",
            params![occurrence, state, reason],
        )?;
        let mut events = vec![];
        if let Some(task) = &o.task_id
            && error.is_some()
        {
            // Before a run exists, make the failed start visible in the ordinary task list/notices.
            let no_run: bool = tx.query_row(
                "SELECT NOT EXISTS(SELECT 1 FROM runs WHERE task_id=?1)",
                [task],
                |r| r.get(0),
            )?;
            if no_run {
                tx.execute(
                    "UPDATE tasks SET state='failed',updated_at_ms=?2 WHERE id=?1",
                    params![task, now_ms()],
                )?;
                events.push(record(
                    &tx,
                    &self.redactor,
                    Some(task),
                    None,
                    EventSource::Engine,
                    Payload::TaskStateChanged {
                        state: TaskState::Failed,
                        reason: reason.clone(),
                    },
                )?);
            }
        }
        events.push(schedule_event(
            &tx,
            &self.redactor,
            &o.schedule_id,
            state,
            Some(&o.plan),
            o.task_id.as_deref(),
        )?);
        tx.commit()?;
        Ok(events)
    }
    pub(crate) fn recover_schedules(&mut self) -> Result<()> {
        let ids = {
            let mut q = self
                .connection
                .prepare("SELECT id FROM schedule_occurrences WHERE state='claimed'")?;
            q.query_map([], |r| r.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?
        };
        for id in ids {
            let o = self.schedule_occurrence(&id)?;
            let task: Option<String> = if o.task_id.is_some() {
                o.task_id.clone()
            } else {
                self.connection
                    .query_row(
                        "SELECT task_id FROM commands WHERE request_id=?1",
                        [format!("schedule-create-{id}")],
                        |r| r.get::<_, Option<String>>(0),
                    )
                    .optional()?
                    .flatten()
            };
            let task = task.filter(|t| self.task(t).is_ok());
            let tx = self.connection.transaction()?;
            tx.execute("UPDATE schedule_occurrences SET state='interrupted',reason='interrupted_dispatch',task_id=?2 WHERE id=?1",params![id,task])?;
            if let Some(t) = &task {
                tx.execute("UPDATE tasks SET state='interrupted',updated_at_ms=?2 WHERE id=?1 AND state='queued'",params![t,now_ms()])?;
            }
            schedule_event(
                &tx,
                &self.redactor,
                &o.schedule_id,
                "interrupted_dispatch",
                Some(&o.plan),
                task.as_deref(),
            )?;
            tx.commit()?;
        }
        // Startup never treats an overdue instant as an immediate new run.
        while !self
            .schedule_tick(now_ms(), Some("application_was_closed"))?
            .1
            .is_empty()
        {}
        Ok(())
    }
}
#[allow(clippy::too_many_arguments)]
fn claim(
    tx: &Connection,
    p: &SchedulePlan,
    reference: &ContentRef,
    id: &str,
    due: u64,
    now: u64,
    trigger: &str,
    key: &str,
    state: &str,
    reason: Option<&str>,
    count: Option<u64>,
    until: Option<u64>,
) -> Result<()> {
    tx.execute("INSERT INTO schedule_occurrences(id,schedule_id,revision,due_at_ms,recorded_at_ms,trigger,dedup_key,state,reason,plan_object_id,missed_count,missed_until_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",params![id,p.id,p.revision,due,now,trigger,key,state,reason,reference.object_id,count,until])?;
    Ok(())
}
fn schedule_event(
    tx: &Connection,
    redactor: &Redactor,
    id: &str,
    change: &str,
    content: Option<&ContentRef>,
    task: Option<&str>,
) -> Result<Event> {
    record(
        tx,
        redactor,
        task,
        None,
        EventSource::Engine,
        Payload::WorkspaceChanged {
            entity_id: id.into(),
            change: format!("schedule_{change}"),
            content: content.cloned(),
        },
    )
}
fn finish(
    tx: &Connection,
    redactor: &Redactor,
    request: &Request,
    id: &str,
    occ: Option<&str>,
) -> Result<Event> {
    tx.execute(
        "INSERT INTO schedule_commands(request_id,schedule_id,occurrence_id) VALUES(?1,?2,?3)",
        params![request.request_id, id, occ],
    )?;
    tx.execute(
        "UPDATE commands SET status='completed',finished_at_ms=?2 WHERE request_id=?1",
        params![request.request_id, now_ms()],
    )?;
    record(
        tx,
        redactor,
        None,
        Some(&request.request_id),
        EventSource::Engine,
        Payload::CommandFinished {
            status: CommandStatus::Completed,
        },
    )
}
