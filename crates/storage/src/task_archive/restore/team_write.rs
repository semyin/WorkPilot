//! A group becomes visible in one transaction, with fresh identities and no live actions.
use super::*;
use team::Group;

struct Identity {
    task: String,
    session: String,
    agent: String,
}
struct Saved {
    config: ContentRef,
    context: ContentRef,
    history: ContentRef,
    goal: ContentRef,
    agent: Agent,
    settings: ToolSettings,
}

impl Store {
    pub(super) fn commit_restored_group(
        &mut self,
        archive: &str,
        mut group: Group,
        stop: &AtomicBool,
    ) -> Result<(Value, Vec<Event>)> {
        let identities: BTreeMap<_, _> = group
            .nodes
            .iter()
            .map(|p| {
                (
                    p.source_id.clone(),
                    Identity {
                        task: id(),
                        session: id(),
                        agent: id(),
                    },
                )
            })
            .collect();
        let agents: BTreeMap<_, _> = group
            .nodes
            .iter()
            .map(|p| {
                (
                    p.source_agent.id.clone(),
                    identities[&p.source_id].agent.clone(),
                )
            })
            .collect();
        let messages: BTreeMap<_, _> = group
            .nodes
            .iter()
            .flat_map(|p| &p.messages)
            .map(|m| (m.id.clone(), id()))
            .collect();
        let remap = |old: &str| {
            identities
                .get(old)
                .map(|n| n.task.clone())
                .ok_or(Error::Invalid("foreign task relationship"))
        };
        let root_id = group.nodes[0].index.root_task_id.clone();
        let root = remap(&root_id)?;
        let media_ids: BTreeMap<_, _> = group
            .media
            .iter()
            .map(|m| (m.source_id.clone(), m.candidate.asset.id.clone()))
            .collect();
        let mut team_ids = BTreeMap::new();
        if group.graph.is_some() {
            for (old, current) in &group.nodes[0].history.team_ids {
                if !valid_id(old) {
                    return Err(Error::Invalid("invalid historical task identity"));
                }
                team_ids.insert(old.clone(), remap(current)?);
            }
            for (old, new) in &identities {
                team_ids.insert(old.clone(), new.task.clone());
            }
            if team_ids.len() > 1024 {
                return Err(Error::Invalid(
                    "历史团队映射超过容量 / Too many historical team identities",
                ));
            }
        }
        let mut saved = BTreeMap::new();
        for p in &mut group.nodes {
            check_stop(stop)?;
            let next = &identities[&p.source_id];
            let mut aliases = BTreeMap::new();
            for (old, current) in &p.history.media_ids {
                aliases.insert(
                    old.clone(),
                    media_ids
                        .get(current)
                        .cloned()
                        .ok_or(Error::Invalid("missing historical attachment"))?,
                );
            }
            for m in group
                .media
                .iter()
                .filter(|m| m.source_task_id == p.source_id)
            {
                aliases.insert(m.source_id.clone(), m.candidate.asset.id.clone());
            }
            p.history.media_ids = aliases;
            for d in &mut p.context.directions {
                d.message_id = messages
                    .get(&d.message_id)
                    .cloned()
                    .ok_or(Error::Invalid("foreign direction"))?;
            }
            p.history.team_ids = if p.source_id == root_id {
                team_ids.clone()
            } else {
                BTreeMap::new()
            };
            let agent = Agent {
                id: next.agent.clone(),
                task_id: next.task.clone(),
                parent_id: p
                    .source_agent
                    .parent_id
                    .as_ref()
                    .map(|v| {
                        agents
                            .get(v)
                            .cloned()
                            .ok_or(Error::Invalid("foreign parent agent"))
                    })
                    .transpose()?,
                replaces_id: p
                    .source_agent
                    .replaces_id
                    .as_ref()
                    .map(|v| {
                        agents
                            .get(v)
                            .cloned()
                            .ok_or(Error::Invalid("foreign replaced agent"))
                    })
                    .transpose()?,
                role: p.source_agent.role.clone(),
                profile_id: Some(p.profile.id.clone()),
                state: match p.state {
                    TaskState::Completed => AgentState::Completed,
                    TaskState::Failed => AgentState::Failed,
                    _ => AgentState::Interrupted,
                },
                attempt: p.source_agent.attempt,
            };
            saved.insert(
                p.source_id.clone(),
                Saved {
                    config: self.save_json(serde_json::to_value(&p.config)?)?,
                    context: self.save_json(serde_json::to_value(&p.context)?)?,
                    history: self.save_json(serde_json::to_value(&p.history)?)?,
                    goal: self.text(&p.config.goal)?,
                    agent,
                    settings: ToolSettings {
                        permission: Some(PermissionMode::RequestApproval),
                        root_path: p.project.as_ref().map(|p| p.0.settings.root_path.clone()),
                        commands_enabled: false,
                        ..Default::default()
                    },
                },
            );
        }
        let mut members = vec![];
        if let Some(graph) = &mut group.graph {
            graph.settings.revision = 0;
            for record in graph.members.values() {
                let mut m = record.member.clone();
                let next = &identities[&m.task_id];
                m.task_id = next.task.clone();
                m.agent_id = next.agent.clone();
                m.parent_task_id = remap(&m.parent_task_id)?;
                m.root_task_id = root.clone();
                m.replaces_id = m.replaces_id.as_deref().map(remap).transpose()?;
                m.superseded_by = m.superseded_by.as_deref().map(remap).transpose()?;
                m.depends_on = m
                    .depends_on
                    .iter()
                    .map(|id| remap(id))
                    .collect::<Result<_>>()?;
                m.report = record
                    .report
                    .as_ref()
                    .map(|report| -> Result<ContentRef> {
                        let mut report = report.clone();
                        report.task_id = m.task_id.clone();
                        report.agent_id = m.agent_id.clone();
                        // Historical steps retain their provenance; no source run is executable here.
                        report.run_id = None;
                        report.state = m.state;
                        self.save_json(serde_json::to_value(report)?)
                    })
                    .transpose()?;
                members.push(m);
            }
        }
        let created = now_ms();
        let receipt = json!({"archive_id":archive,"task_id":root,"title":group.nodes[0].config.title,"restored_at_ms":created,"fingerprint":group.fingerprint,"duplicate":false,"tasks":group.nodes.iter().map(|p|json!({"source_task_id":p.source_id,"task_id":identities[&p.source_id].task,"title":p.config.title})).collect::<Vec<_>>()});
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        // Agent parents follow the archive's validated tree order. All tasks exist
        // before inserting team edges, including references to replacement siblings.
        for p in &group.nodes {
            check_stop(stop)?;
            let next = &identities[&p.source_id];
            let body = &saved[&p.source_id];
            tx.execute("INSERT INTO tasks(id,project_id,title,state,mode,permission,profile_id,created_at_ms,updated_at_ms) VALUES(?1,?2,?3,?4,?5,'request_approval',?6,?7,?7)",params![next.task,p.config.project_id,p.config.title,word(&p.state)?,word(&p.config.mode)?,p.profile.id,created])?;
            tx.execute(
                "INSERT INTO agents(id,task_id,parent_id,data_json) VALUES(?1,?2,?3,?4)",
                params![
                    next.agent,
                    next.task,
                    body.agent.parent_id,
                    encode(&body.agent)?
                ],
            )?;
            tx.execute("INSERT INTO execution_sessions(id,task_id,agent_id,config_object_id,context_object_id) VALUES(?1,?2,?3,?4,?5)",params![next.session,next.task,next.agent,body.config.object_id,body.context.object_id])?;
            tx.execute(
                "INSERT INTO task_tool_settings(task_id,data_json,root_identity) VALUES(?1,?2,?3)",
                params![
                    next.task,
                    encode(&body.settings)?,
                    p.project.as_ref().and_then(|p| p.1.as_deref())
                ],
            )?;
            tx.execute(
                "INSERT INTO team_control(task_id,enabled) VALUES(?1,0)",
                [&next.task],
            )?;
            for m in &p.messages {
                check_stop(stop)?;
                tx.execute("INSERT INTO messages(id,task_id,role,state,queue_position,object_id,created_at_ms) VALUES(?1,?2,'user',?3,?4,?5,?6)",params![messages[&m.id],next.task,word(&m.state)?,m.queue_position,m.content.object_id,m.created_at_ms])?;
            }
            tx.execute(
                "INSERT INTO settings(key,value_json) VALUES(?1,?2)",
                params![
                    format!("task-restored-history:{}", next.task),
                    encode(&body.history)?
                ],
            )?;
        }
        if let Some(graph) = &group.graph {
            tx.execute(
                "INSERT INTO team_settings(task_id,data_json) VALUES(?1,?2)",
                params![root, encode(&graph.settings)?],
            )?;
        }
        for media in &group.media {
            check_stop(stop)?;
            let mut asset = media.candidate.asset.clone();
            asset.task_id = Some(remap(&media.source_task_id)?);
            // Keep original input/output visibility, but never a live path or operation.
            asset.source = group.nodes[0]
                .index
                .media
                .iter()
                .find(|m| m.entry.id == media.source_id)
                .ok_or(Error::NotFound)?
                .entry
                .source
                .clone();
            tx.execute("INSERT INTO media_assets(id,task_id,data_json,original_blob,parsed_blob,removed) VALUES(?1,?2,?3,?4,?5,?6)",params![asset.id,asset.task_id,encode(&asset)?,media.candidate.original_blob,media.candidate.parsed_blob,media.removed])?;
        }
        if !group.nodes[0].index.file_history.is_empty() {
            let targets = group
                .nodes
                .iter()
                .flat_map(|p| p.history_roots.clone())
                .collect();
            let mapping = identities
                .iter()
                .map(|(old, new)| (old.clone(), new.task.clone()))
                .collect();
            file_history::install(
                &tx,
                &group.nodes[0].index,
                &mapping,
                &targets,
                created,
                stop,
            )?;
        }
        for m in &members {
            // Old inspections cannot approve new reports. Existing review conclusions
            // survive, but pending reviews require a fresh inspection.
            tx.execute("INSERT INTO team_members(task_id,parent_task_id,root_task_id,member_key,data_json,pending_start,report_object_id,review,review_reason,superseded_by) VALUES(?1,?2,?3,?4,?5,0,?6,?7,?8,?9)",params![m.task_id,m.parent_task_id,root,m.key,encode(m)?,m.report.as_ref().map(|r|&r.object_id),m.review,m.review_reason,m.superseded_by])?;
        }
        for m in &members {
            for dependency in &m.depends_on {
                tx.execute(
                    "INSERT INTO team_dependencies(member_id,dependency_id) VALUES(?1,?2)",
                    params![m.task_id, dependency],
                )?;
            }
        }
        tx.execute(
            "INSERT INTO settings(key,value_json) VALUES(?1,?2)",
            params![restore_key(archive), encode(&receipt)?],
        )?;
        let mut events = vec![];
        for p in &group.nodes {
            let next = &identities[&p.source_id];
            let body = &saved[&p.source_id];
            let restored = record(
                &tx,
                &self.redactor,
                Some(&next.task),
                None,
                EventSource::Recovery,
                Payload::TaskRestored {
                    archive_id: archive.into(),
                    source_task_id: p.source_id.clone(),
                    history: body.history.clone(),
                },
            )?;
            // Pin immutable source data once on the root for collection and re-export.
            if p.source_id == root_id {
                for r in &p.index.objects {
                    tx.execute("INSERT OR IGNORE INTO event_objects(event_sequence,object_id) VALUES(?1,?2)",params![restored.sequence,r.object_id])?;
                }
            }
            events.push(restored);
            events.push(record(
                &tx,
                &self.redactor,
                Some(&next.task),
                None,
                EventSource::Recovery,
                Payload::ExecutionCreated {
                    session_id: next.session.clone(),
                    agent_id: next.agent.clone(),
                    goal: body.goal.clone(),
                },
            )?);
            for (role, content, at) in &p.conversation {
                check_stop(stop)?;
                events.push(record(
                    &tx,
                    &self.redactor,
                    Some(&next.task),
                    None,
                    EventSource::Recovery,
                    Payload::RestoredMessage {
                        role: role.clone(),
                        content: content.clone(),
                        original_at_ms: *at,
                    },
                )?);
            }
            events.push(record(&tx,&self.redactor,Some(&next.task),None,EventSource::Recovery,Payload::TaskStateChanged {state:p.state,reason:Some("从档案恢复，等待手动继续；原审批不生效 / Restored from archive; manual continuation required; previous approvals are inactive".into())})?);
        }
        for m in members {
            events.push(record(
                &tx,
                &self.redactor,
                Some(&m.parent_task_id),
                None,
                EventSource::Recovery,
                Payload::TeamChanged {
                    member_task_id: Some(m.task_id),
                    change: "member_restored".into(),
                    record: m.report,
                },
            )?);
        }
        check_stop(stop)?;
        tx.commit()?;
        Ok((receipt, events))
    }
}
