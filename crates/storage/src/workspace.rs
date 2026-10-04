use super::*;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::io::{BufReader, Read};

impl Store {
    pub fn begin_workspace_export(
        &mut self,
        request: &Request,
        task: &str,
    ) -> Result<Option<WorkspaceData>> {
        self.task(task)?;
        if let Some(receipt) = self.cached_receipt(request)? {
            let raw: Option<String> = self.connection.query_row(
                "SELECT result_json FROM workspace_exports WHERE request_id=?1",
                [&request.request_id],
                |r| r.get(0),
            )?;
            if let Some(raw) = raw {
                return Ok(Some(serde_json::from_str(&raw)?));
            }
            if receipt.status == CommandStatus::Completed {
                return Err(Error::Conflict);
            }
            return Ok(None);
        }
        let tx = self.connection.transaction()?;
        super::providers::accept_command(&tx, &self.redactor, request, Some(task))?;
        tx.execute(
            "INSERT INTO workspace_exports(request_id) VALUES(?1)",
            [&request.request_id],
        )?;
        tx.commit()?;
        Ok(None)
    }
    pub fn finish_workspace_export(
        &mut self,
        request: &Request,
        task: &str,
        result: &WorkspaceData,
    ) -> Result<Vec<Event>> {
        let tx = self.connection.transaction()?;
        tx.execute(
            "UPDATE workspace_exports SET result_json=?2 WHERE request_id=?1",
            params![request.request_id, encode(result)?],
        )?;
        let events = super::execution::finish_control_tx(&tx, &self.redactor, request, task)?;
        tx.commit()?;
        Ok(events)
    }
    pub fn workspace_project(&self, id: &str) -> Result<WorkspaceProject> {
        let raw: String = self
            .connection
            .query_row("SELECT data_json FROM projects WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .optional()?
            .ok_or(Error::NotFound)?;
        let p: Project = serde_json::from_str(&raw)?;
        let extra: Option<(String, u32)> = self
            .connection
            .query_row(
                "SELECT rules,revision FROM project_workspace WHERE project_id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let (rules, revision) = extra.unwrap_or_default();
        Ok(WorkspaceProject {
            id: p.id,
            created_at_ms: p.created_at_ms,
            settings: ProjectSettings {
                name: p.name,
                root_path: p.root_path,
                permission: p.permission,
                default_profile_id: p.default_profile_id,
                rules,
                revision,
            },
        })
    }
    pub fn workspace_preferences(&self) -> Result<WorkspacePreferences> {
        let raw: Option<String> = self
            .connection
            .query_row(
                "SELECT value_json FROM settings WHERE key='workspace'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        Ok(raw
            .map(|s| serde_json::from_str(&s))
            .transpose()?
            .unwrap_or_default())
    }
    pub fn task_archived(&self, task: &str) -> Result<bool> {
        let root = self.team_root(task)?;
        Ok(self
            .connection
            .query_row("SELECT archived FROM tasks WHERE id=?1", [root], |r| {
                r.get(0)
            })?)
    }
    pub fn project_creation_defaults(
        &self,
        project: &str,
    ) -> Result<(WorkspaceProject, Option<String>)> {
        let p = self.workspace_project(project)?;
        let identity = self
            .connection
            .query_row(
                "SELECT root_identity FROM project_workspace WHERE project_id=?1",
                [project],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        Ok((p, identity))
    }
    pub fn workspace_action(
        &mut self,
        request: &Request,
        action: &WorkspaceAction,
        root_identity: Option<String>,
    ) -> Result<(WorkspaceData, Vec<Event>)> {
        action.validate().map_err(Error::Invalid)?;
        if self.cached_receipt(request)?.is_some() {
            return Ok((WorkspaceData::Updated, vec![]));
        }
        let mut target: Option<String> = None;
        let entity;
        let change;
        let mut content = None;
        let mut saved_project = None;
        let mut prefs = None;
        match action {
            WorkspaceAction::SaveProject {
                project_id,
                settings: s,
            } => {
                if let Some(p) = &s.default_profile_id {
                    self.profile(p)?;
                }
                if root_identity.is_none() {
                    return Err(Error::Invalid("project folder must be validated"));
                }
                let old = project_id
                    .as_ref()
                    .map(|id| self.workspace_project(id))
                    .transpose()?;
                if old.as_ref().map_or(0, |p| p.settings.revision) != s.revision {
                    return Err(Error::Conflict);
                }
                entity = project_id.clone().unwrap_or_else(id);
                let mut settings = s.clone();
                settings.revision += 1;
                settings.name = self.redactor.text(&settings.name);
                settings.rules = self.redactor.text(&settings.rules);
                saved_project = Some(WorkspaceProject {
                    id: entity.clone(),
                    created_at_ms: old.map_or_else(now_ms, |p| p.created_at_ms),
                    settings,
                });
                change = "project_saved";
            }
            WorkspaceAction::SavePreferences { preferences: p } => {
                if p.revision != self.workspace_preferences()?.revision {
                    return Err(Error::Conflict);
                }
                let mut p = p.clone();
                p.revision += 1;
                prefs = Some(p);
                entity = "workspace".into();
                change = "preferences_saved";
            }
            WorkspaceAction::ArchiveTask { task_id, .. } => {
                if self.member_parent(task_id)?.is_some() {
                    return Err(Error::Invalid("archive the whole root task"));
                }
                if self.team_enabled(task_id)?
                    || self.team_subtree(task_id)?.iter().any(|id| {
                        if self.has_active_workbench(id).unwrap_or(true) {
                            return true;
                        }
                        self.execution_snapshot(id).is_ok_and(|s| {
                            s.latest_run.is_some_and(|r| {
                                matches!(r.run.state, TaskState::Running | TaskState::Queued)
                            }) || s.task.state == TaskState::Stopping
                        })
                    })
                {
                    return Err(Error::Busy);
                }
                target = Some(task_id.clone());
                entity = task_id.clone();
                change = "task_archived";
            }
            WorkspaceAction::RenameTask { task_id, .. } => {
                self.task(task_id)?;
                if self.member_parent(task_id)?.is_some() {
                    return Err(Error::Invalid("rename the root task"));
                }
                target = Some(task_id.clone());
                entity = task_id.clone();
                change = "task_renamed";
            }
            WorkspaceAction::EditMessage {
                task_id,
                message_id,
                expected_object_id,
                text,
            } => {
                self.guard_queued_message(task_id, message_id, expected_object_id)?;
                content = Some(self.text(text)?);
                target = Some(task_id.clone());
                entity = message_id.clone();
                change = "message_edited";
            }
            WorkspaceAction::CancelMessage {
                task_id,
                message_id,
                expected_object_id,
            } => {
                self.guard_queued_message(task_id, message_id, expected_object_id)?;
                target = Some(task_id.clone());
                entity = message_id.clone();
                change = "message_cancelled";
            }
            WorkspaceAction::ExportRecords { .. } => {
                return Err(Error::Invalid("export uses the independent reader"));
            }
        }
        let tx = self.connection.transaction()?;
        let mut events =
            super::providers::accept_command(&tx, &self.redactor, request, target.as_deref())?;
        match action {
            WorkspaceAction::SaveProject { .. } => {
                let p = saved_project.as_ref().unwrap();
                let base = Project {
                    id: p.id.clone(),
                    name: p.settings.name.clone(),
                    root_path: p.settings.root_path.clone(),
                    default_profile_id: p.settings.default_profile_id.clone(),
                    permission: p.settings.permission,
                    created_at_ms: p.created_at_ms,
                };
                tx.execute("INSERT INTO projects(id,root_path,data_json) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET root_path=excluded.root_path,data_json=excluded.data_json",params![p.id,p.settings.root_path,encode(&base)?])?;
                tx.execute("INSERT INTO project_workspace(project_id,rules,root_identity,revision) VALUES(?1,?2,?3,?4) ON CONFLICT(project_id) DO UPDATE SET rules=excluded.rules,root_identity=excluded.root_identity,revision=excluded.revision",params![p.id,p.settings.rules,root_identity,p.settings.revision])?;
            }
            WorkspaceAction::SavePreferences { .. } => {
                tx.execute("INSERT INTO settings(key,value_json) VALUES('workspace',?1) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",[encode(prefs.as_ref().unwrap())?])?;
            }
            WorkspaceAction::ArchiveTask { task_id, archived } => {
                tx.execute(
                    "UPDATE tasks SET archived=?2,updated_at_ms=?3 WHERE id=?1",
                    params![task_id, archived, now_ms()],
                )?;
            }
            WorkspaceAction::RenameTask { task_id, title } => {
                tx.execute(
                    "UPDATE tasks SET title=?2,updated_at_ms=?3 WHERE id=?1",
                    params![task_id, self.redactor.text(title), now_ms()],
                )?;
            }
            WorkspaceAction::EditMessage { message_id, .. } => {
                tx.execute(
                    "UPDATE messages SET object_id=?2 WHERE id=?1",
                    params![message_id, content.as_ref().unwrap().object_id],
                )?;
            }
            WorkspaceAction::CancelMessage { message_id, .. } => {
                tx.execute(
                    "UPDATE messages SET state='cancelled' WHERE id=?1",
                    [message_id],
                )?;
            }
            _ => unreachable!(),
        }
        events.push(record(
            &tx,
            &self.redactor,
            target.as_deref(),
            Some(&request.request_id),
            EventSource::User,
            Payload::WorkspaceChanged {
                entity_id: entity,
                change: change.into(),
                content,
            },
        )?);
        tx.execute(
            "UPDATE commands SET status='completed',finished_at_ms=?2 WHERE request_id=?1",
            params![request.request_id, now_ms()],
        )?;
        events.push(record(
            &tx,
            &self.redactor,
            target.as_deref(),
            Some(&request.request_id),
            EventSource::Engine,
            Payload::CommandFinished {
                status: CommandStatus::Completed,
            },
        )?);
        tx.commit()?;
        Ok((
            saved_project.map_or(WorkspaceData::Updated, |project| {
                WorkspaceData::ProjectSaved { project }
            }),
            events,
        ))
    }
    fn guard_queued_message(&self, task: &str, message: &str, expected: &str) -> Result<()> {
        let valid:bool=self.connection.query_row("SELECT EXISTS(SELECT 1 FROM messages WHERE task_id=?1 AND id=?2 AND object_id=?3 AND state IN ('queued','steer_requested'))",params![task,message,expected],|r|r.get(0))?;
        if !valid {
            return Err(Error::Conflict);
        }
        Ok(())
    }
    pub fn workspace_query(&self, q: &WorkspaceQuery) -> Result<WorkspaceData> {
        q.validate().map_err(Error::Invalid)?;
        match q {
            WorkspaceQuery::Overview => {
                let mut query = self
                    .connection
                    .prepare("SELECT id FROM projects ORDER BY rowid DESC")?;
                let ids = query
                    .query_map([], |r| r.get::<_, String>(0))?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                let mut query=self.connection.prepare("SELECT t.id,COALESCE(m.root_task_id,t.id),t.title,t.state FROM tasks t LEFT JOIN team_members m ON m.task_id=t.id JOIN execution_sessions s ON s.task_id=t.id WHERE t.state IN ('awaiting_approval','awaiting_input','failed') AND t.archived=0 AND NOT EXISTS(SELECT 1 FROM team_waiters w WHERE w.task_id=t.id) AND (m.task_id IS NULL OR (m.superseded_by IS NULL AND m.review='pending')) AND NOT EXISTS(SELECT 1 FROM tasks root WHERE root.id=COALESCE(m.root_task_id,t.id) AND root.archived=1) ORDER BY t.updated_at_ms DESC LIMIT 64")?;
                let rows = query
                    .query_map([], |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, String>(3)?,
                        ))
                    })?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                Ok(WorkspaceData::Overview {
                    projects: ids
                        .iter()
                        .map(|id| self.workspace_project(id))
                        .collect::<Result<_>>()?,
                    preferences: self.workspace_preferences()?,
                    scheduler: self.scheduler_settings()?,
                    data_dir: self.directory.to_string_lossy().into_owned(),
                    notices: rows
                        .into_iter()
                        .map(|(task_id, root_task_id, title, state)| {
                            Ok(WorkspaceNotice {
                                task_id,
                                root_task_id,
                                title,
                                state: parse_word(state)?,
                            })
                        })
                        .collect::<Result<_>>()?,
                })
            }
            WorkspaceQuery::Tasks {
                project_id,
                archived,
                search,
                before,
                limit,
            } => {
                let pattern = search.trim().to_lowercase();
                let mut query=self.connection.prepare("SELECT t.id FROM tasks t WHERE t.archived=?1 AND (?2 IS NULL OR t.project_id=?2) AND (?3='' OR instr(lower(t.title),?3)>0) AND (?4 IS NULL OR (t.updated_at_ms,t.id)<(SELECT updated_at_ms,id FROM tasks WHERE id=?4)) AND NOT EXISTS(SELECT 1 FROM team_members m WHERE m.task_id=t.id) AND EXISTS(SELECT 1 FROM execution_sessions s WHERE s.task_id=t.id) ORDER BY t.updated_at_ms DESC,t.id DESC LIMIT ?5")?;
                let mut ids = query
                    .query_map(
                        params![archived, project_id, pattern, before, limit + 1],
                        |r| r.get::<_, String>(0),
                    )?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                let more = ids.len() > *limit as usize;
                ids.truncate(*limit as usize);
                Ok(WorkspaceData::Tasks {
                    tasks: ids.iter().map(|id| self.task(id)).collect::<Result<_>>()?,
                    next_before: if more { ids.last().cloned() } else { None },
                })
            }
            WorkspaceQuery::Detail { task_id } => {
                let mut s = self.execution_snapshot(task_id)?;
                s.context.history.clear();
                s.context.sources.clear();
                s.context.pending = None;
                s.context.last_text = s.context.last_text.chars().take(32000).collect();
                let mut live_text = String::new();
                let mut live_reasoning = String::new();
                if let Some(step) = s.steps.iter().rev().find(|v| {
                    v.kind == ExecutionStepKind::Model && v.state == ExecutionStepState::Running
                }) {
                    let mut query=self.connection.prepare("SELECT json_extract(payload_json,'$.content.object_id'),json_extract(payload_json,'$.reasoning') FROM events WHERE task_id=?1 AND json_extract(payload_json,'$.kind')='execution_text' AND json_extract(payload_json,'$.step_id')=?2 ORDER BY sequence DESC LIMIT 128")?;
                    let rows = query
                        .query_map(params![task_id, step.id], |r| {
                            Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?))
                        })?
                        .collect::<std::result::Result<Vec<_>, _>>()?;
                    for (id, reasoning) in rows.into_iter().rev() {
                        let v: Value = self.read_json(&content_ref(&self.connection, &id)?)?;
                        let text = v["text"].as_str().unwrap_or_default();
                        if reasoning {
                            live_reasoning.push_str(text);
                        } else {
                            live_text.push_str(text);
                        }
                    }
                }
                let tail = |s: String| {
                    s.chars()
                        .rev()
                        .take(32000)
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect::<String>()
                };
                let profile = self
                    .resolve_profile(Some(task_id), Some(&s.agent_id), None)
                    .ok()
                    .map(|p| Box::new(p.without_credential()));
                Ok(WorkspaceData::Detail {
                    archived: self.task_archived(task_id)?,
                    snapshot: Box::new(s),
                    effective_profile: profile,
                    effective_permission: self.tool_settings(task_id)?.effective_permission,
                    live_text: tail(live_text),
                    live_reasoning: tail(live_reasoning),
                })
            }
            WorkspaceQuery::Conversation {
                task_id,
                before,
                limit,
            } => {
                self.task(task_id)?;
                let mut q=self.connection.prepare("SELECT e.sequence,e.at_ms,json_extract(e.payload_json,'$.kind'),e.payload_json FROM events e WHERE e.task_id=?1 AND (?2 IS NULL OR e.sequence<?2) AND (json_extract(e.payload_json,'$.kind') IN ('execution_created','message_delivered','restored_message') OR (json_extract(e.payload_json,'$.kind')='execution_step_changed' AND json_extract(e.payload_json,'$.name')='model' AND json_extract(e.payload_json,'$.state')='completed')) ORDER BY e.sequence DESC LIMIT ?3")?;
                let mut rows = q
                    .query_map(params![task_id, before, limit + 1], |r| {
                        Ok((
                            r.get::<_, u64>(0)?,
                            r.get::<_, u64>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, String>(3)?,
                        ))
                    })?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                let more = rows.len() > *limit as usize;
                rows.truncate(*limit as usize);
                let next_before = if more { rows.last().map(|r| r.0) } else { None };
                let mut entries = vec![];
                for (sequence, at_ms, kind, raw) in rows.into_iter().rev() {
                    let v: Value = serde_json::from_str(&raw)?;
                    let at_ms = if kind == "restored_message" {
                        v["original_at_ms"].as_u64().unwrap_or(at_ms)
                    } else {
                        at_ms
                    };
                    let (role, source, text) = match kind.as_str() {
                        "restored_message" => {
                            let source: ContentRef = serde_json::from_value(v["content"].clone())?;
                            if v["role"] == "assistant" {
                                let output: ModelOutput = self.read_json(&source)?;
                                ("assistant", source, output.text)
                            } else {
                                let text = self.read_text_value(&source)?;
                                ("user", source, text)
                            }
                        }
                        "execution_created" => {
                            let source: ContentRef = serde_json::from_value(v["goal"].clone())?;
                            let text = self.read_text_value(&source)?;
                            ("user", source, text)
                        }
                        "message_delivered" => {
                            let id: String = self.connection.query_row(
                                "SELECT object_id FROM messages WHERE task_id=?1 AND id=?2",
                                params![task_id, v["message_id"].as_str()],
                                |r| r.get(0),
                            )?;
                            let source = content_ref(&self.connection, &id)?;
                            let text = self.read_text_value(&source)?;
                            ("user", source, text)
                        }
                        _ => {
                            let source: ContentRef = serde_json::from_value(v["output"].clone())?;
                            let output: ModelOutput = self.read_json(&source)?;
                            ("assistant", source, output.text)
                        }
                    };
                    if text.trim().is_empty() {
                        continue;
                    }
                    entries.push(ConversationEntry {
                        sequence,
                        at_ms,
                        role: role.into(),
                        truncated: text.chars().count() > 8000,
                        text: text.chars().take(8000).collect(),
                        source,
                    });
                }
                Ok(WorkspaceData::Conversation {
                    entries,
                    next_before,
                })
            }
            WorkspaceQuery::Artifacts { task_id } => {
                self.task(task_id)?;
                let mut q=self.connection.prepare("WITH RECURSIVE tree(id) AS (SELECT ?1 UNION ALL SELECT m.task_id FROM team_members m JOIN tree t ON m.parent_task_id=t.id) SELECT a.id,a.task_id,t.title,a.path,v.id,v.object_id FROM artifacts a JOIN tasks t ON t.id=a.task_id JOIN revisions v ON v.id=a.latest_revision_id WHERE a.task_id IN (SELECT id FROM tree) ORDER BY v.created_at_ms DESC LIMIT 128")?;
                let rows = q
                    .query_map([task_id], |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, String>(3)?,
                            r.get::<_, String>(4)?,
                            r.get::<_, String>(5)?,
                        ))
                    })?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                Ok(WorkspaceData::Artifacts {
                    artifacts: rows
                        .into_iter()
                        .map(|(id, task_id, title, path, revision_id, o)| {
                            Ok(WorkspaceArtifact {
                                id,
                                task_id,
                                title,
                                path,
                                revision_id,
                                content: content_ref(&self.connection, &o)?,
                            })
                        })
                        .collect::<Result<_>>()?,
                })
            }
            WorkspaceQuery::SearchRecords { .. } => {
                Err(Error::Invalid("search uses independent reader"))
            }
        }
    }
}

fn tree_events(c: &Connection, task: &str, after: u64, limit: u32) -> Result<EventPage> {
    let high: u64 = c.query_row("SELECT COALESCE(MAX(sequence),0) FROM events", [], |r| {
        r.get(0)
    })?;
    let mut q=c.prepare("WITH RECURSIVE tree(id) AS (SELECT ?1 UNION ALL SELECT m.task_id FROM team_members m JOIN tree t ON m.parent_task_id=t.id) SELECT sequence,event_id,task_id,task_sequence,agent_id,source,at_ms,request_id,payload_json FROM events WHERE task_id IN (SELECT id FROM tree) AND sequence>?2 AND sequence<=?3 ORDER BY sequence LIMIT ?4")?;
    let mut r = q.query(params![task, after, high, limit + 1])?;
    let mut events = vec![];
    while let Some(r) = r.next()? {
        events.push(Event {
            protocol: PROTOCOL.into(),
            sequence: r.get(0)?,
            event_id: r.get(1)?,
            task_id: r.get(2)?,
            task_sequence: r.get(3)?,
            agent_id: r.get(4)?,
            source: parse_word(r.get(5)?)?,
            at_ms: r.get(6)?,
            request_id: r.get(7)?,
            payload: serde_json::from_str(&r.get::<_, String>(8)?)?,
        });
    }
    let has_more = events.len() > limit as usize;
    events.truncate(limit as usize);
    let next_after = if has_more {
        events.last().map_or(after, |e| e.sequence)
    } else {
        high.max(after)
    };
    Ok(EventPage {
        events,
        next_after,
        has_more,
        high_watermark: high,
    })
}
fn linked_objects(c: &Connection, event: &Event) -> Result<HashSet<String>> {
    let mut q = c.prepare("SELECT object_id FROM event_objects WHERE event_sequence=?1")?;
    let mut refs = q
        .query_map([event.sequence], |r| r.get(0))?
        .collect::<std::result::Result<HashSet<String>, _>>()?;
    if let Payload::ExecutionStepChanged { step_id, .. } = &event.payload {
        let mut q = c.prepare("SELECT object_id FROM tool_result_objects WHERE action_id=?1")?;
        refs.extend(
            q.query_map([step_id], |r| r.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?,
        );
    }
    if let Payload::WorkbenchChanged { operation_id, .. } = &event.payload {
        let mut q =
            c.prepare("SELECT object_id FROM workbench_output_objects WHERE operation_id=?1")?;
        refs.extend(
            q.query_map([operation_id], |r| r.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?,
        );
    }
    Ok(refs)
}
fn file_contains(path: &Path, needle: &str) -> Result<bool> {
    let mut reader = BufReader::new(File::open(path)?);
    let mut buf = [0u8; 65536];
    let mut tail = Vec::new();
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            return Ok(false);
        }
        tail.extend_from_slice(&buf[..n]);
        if String::from_utf8_lossy(&tail)
            .to_lowercase()
            .contains(needle)
        {
            return Ok(true);
        }
        let keep = (needle.len() * 3 + 8).min(tail.len());
        tail = tail[tail.len() - keep..].to_vec();
    }
}
impl Inspector {
    pub fn search_workspace_records(
        &self,
        directory: &Path,
        task: &str,
        text: &str,
        after: u64,
        limit: u32,
    ) -> Result<WorkspaceData> {
        let canonical = directory.canonicalize()?;
        let directory = canonical.as_path();
        WorkspaceQuery::SearchRecords {
            task_id: task.into(),
            text: text.into(),
            after,
            limit,
        }
        .validate()
        .map_err(Error::Invalid)?;
        let exists: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?1)",
            [task],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(Error::NotFound);
        }
        // Scan a bounded batch independently of the number of returned matches.
        // Large histories need not make one IPC trip for every 64 non-matches.
        let page = tree_events(&self.connection, task, after, 2048)?;
        let total = page.events.len();
        let mut scanned = 0;
        let mut cursor = after;
        let started = std::time::Instant::now();
        let needle = text.to_lowercase();
        let mut found = vec![];
        let mut matched = std::collections::HashMap::<String, bool>::new();
        for event in page.events {
            cursor = event.sequence;
            scanned += 1;
            let mut yes = encode(&event)?.to_lowercase().contains(&needle);
            if !yes {
                for id in linked_objects(&self.connection, &event)? {
                    let contains = if let Some(v) = matched.get(&id) {
                        *v
                    } else {
                        let v = file_contains(&objects::object_path(directory, &id)?, &needle)?;
                        matched.insert(id, v);
                        v
                    };
                    if contains {
                        yes = true;
                        break;
                    }
                }
            }
            if yes {
                found.push(event);
            }
            if found.len() >= limit as usize
                || started.elapsed() >= std::time::Duration::from_millis(150)
            {
                break;
            }
        }
        let has_more = page.has_more || scanned < total;
        Ok(WorkspaceData::SearchRecords {
            events: found,
            next_after: if has_more { cursor } else { page.next_after },
            has_more,
        })
    }
    pub fn export_workspace_records(&self, directory: &Path, task: &str) -> Result<WorkspaceData> {
        let canonical = directory.canonicalize()?;
        let directory = canonical.as_path();
        if !valid_id(task) {
            return Err(Error::NotFound);
        }
        let exists: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?1)",
            [task],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(Error::NotFound);
        }
        let base = directory.join("exports");
        std::fs::create_dir_all(&base)?;
        if base.canonicalize()? != base {
            return Err(Error::Invalid("export directory link"));
        }
        let path = base.join(format!("records-{}", id()));
        std::fs::create_dir(&path)?;
        std::fs::create_dir(path.join("objects"))?;
        let tx = self.connection.unchecked_transaction()?;
        let mut output = std::io::BufWriter::new(File::create(path.join("events.jsonl.partial"))?);
        serde_json::to_writer(
            &mut output,
            &json!({"format":"workpilot.complete-records","version":1,"schema":SCHEMA_VERSION,"root_task_id":task,"credentials_included":false}),
        )?;
        output.write_all(b"\n")?;
        let (mut after, mut count) = (0, 0);
        let mut owned = HashSet::new();
        loop {
            let page = tree_events(&tx, task, after, 256)?;
            for e in page.events {
                owned.extend(linked_objects(&tx, &e)?);
                serde_json::to_writer(&mut output, &e)?;
                output.write_all(b"\n")?;
                count += 1;
            }
            after = page.next_after;
            if !page.has_more {
                break;
            }
        }
        let mut q=tx.prepare("WITH RECURSIVE tree(id) AS (SELECT ?1 UNION ALL SELECT m.task_id FROM team_members m JOIN tree t ON m.parent_task_id=t.id) SELECT v.object_id FROM revisions v JOIN artifacts a ON a.id=v.artifact_id WHERE a.task_id IN (SELECT id FROM tree) UNION SELECT before_object_id FROM managed_file_changes WHERE task_id IN (SELECT id FROM tree) AND before_object_id IS NOT NULL UNION SELECT after_object_id FROM managed_file_changes WHERE task_id IN (SELECT id FROM tree) UNION SELECT object_id FROM messages WHERE task_id IN (SELECT id FROM tree) UNION SELECT config_object_id FROM execution_sessions WHERE task_id IN (SELECT id FROM tree) UNION SELECT context_object_id FROM execution_sessions WHERE task_id IN (SELECT id FROM tree) UNION SELECT c.context_object_id FROM execution_checkpoints c JOIN execution_sessions s ON s.id=c.session_id WHERE s.task_id IN (SELECT id FROM tree) UNION SELECT input_object_id FROM execution_steps WHERE run_id IN (SELECT id FROM runs WHERE task_id IN (SELECT id FROM tree)) UNION SELECT output_object_id FROM execution_steps WHERE output_object_id IS NOT NULL AND run_id IN (SELECT id FROM runs WHERE task_id IN (SELECT id FROM tree))")?;
        owned.extend(
            q.query_map([task], |r| r.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?,
        );
        drop(q);
        let mut objects_count = 0;
        let mut copied = HashSet::new();
        let mut pending = owned.into_iter().collect::<Vec<_>>();
        while let Some(id) = pending.pop() {
            if !copied.insert(id.clone()) {
                continue;
            }
            let reference = content_ref(&tx, &id)?;
            objects::verify(directory, &reference)?;
            let source = objects::object_path(directory, &id)?;
            std::fs::copy(&source, path.join("objects").join(&id))?;
            objects_count += 1;
        }
        output.flush()?;
        drop(output);
        tx.commit()?;
        std::fs::rename(path.join("events.jsonl.partial"), path.join("events.jsonl"))?;
        std::fs::write(
            path.join("README.txt"),
            "WorkPilot 完整记录 / Complete records\n仅包含选定任务及成员的已保存脱敏记录。事件中的 object_id 对应 objects 同名文件。\nOnly persisted, redacted records for this task tree. Resolve object_id against objects/.\n",
        )?;
        Ok(WorkspaceData::Exported {
            path: path.to_string_lossy().into_owned(),
            events: count,
            objects: objects_count,
        })
    }
}
