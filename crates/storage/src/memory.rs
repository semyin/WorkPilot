use super::*;
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Stored {
    pub(crate) memory: Memory,
    revision: u32,
    deleted: bool,
    source_label: String,
    source_quote: String,
    created_at_ms: u64,
    updated_at_ms: u64,
    change: String,
}

impl Store {
    pub(crate) fn prepare_transferred_memory(
        &mut self,
        original: &MemoryItem,
        project: Option<String>,
        archive: &str,
    ) -> Result<Stored> {
        let mut label = original.source_label.clone();
        while label.len() > 2048 {
            label.pop();
        }
        let mut value = self.new_memory(
            &original.text,
            None,
            None,
            format!(
                "导入 / Imported: {} · {}@{} · {}",
                label, original.id, original.revision, archive
            ),
            original.source_quote.clone(),
            MemoryState::Confirmed,
        )?;
        value.memory.project_id = project;
        value.created_at_ms = original.created_at_ms;
        value.change = "imported_and_confirmed".into();
        Ok(value)
    }
    // Only migrated placeholders need an index. Normal edits maintain it in their transaction.
    pub(crate) fn memory_reindex(&mut self) -> Result<()> {
        let ids = {
            let mut q = self
                .connection
                .prepare("SELECT memory_id FROM memory_meta WHERE search_text='' LIMIT 4096")?;
            q.query_map([], |r| r.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?
        };
        for id in ids {
            let value = self.memory_stored(&id)?;
            let text = self.read_text_value(&value.memory.content)?;
            self.connection.execute(
                "UPDATE memory_meta SET search_text=?2 WHERE memory_id=?1",
                params![id, text.to_lowercase()],
            )?;
        }
        Ok(())
    }
    fn memory_stored(&self, id: &str) -> Result<Stored> {
        let (raw, source):(String,Option<String>) = self.connection.query_row(
            "SELECT x.data_json,m.source_task_id FROM memory_meta x JOIN memories m ON m.id=x.memory_id WHERE m.id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?))
        ).optional()?.ok_or(Error::NotFound)?;
        let mut value: Stored = serde_json::from_str(&raw)?;
        // Deleting a source task must not leave an active link to a nonexistent task.
        value.memory.source_task_id = source;
        Ok(value)
    }
    fn memory_item(&self, v: Stored) -> Result<MemoryItem> {
        Ok(MemoryItem {
            text: self.read_text_value(&v.memory.content)?,
            id: v.memory.id,
            project_id: v.memory.project_id,
            source_task_id: v.memory.source_task_id,
            state: v.memory.state,
            confirmed_at_ms: v.memory.confirmed_at_ms,
            revision: v.revision,
            deleted: v.deleted,
            source_label: v.source_label,
            source_quote: v.source_quote,
            created_at_ms: v.created_at_ms,
            updated_at_ms: v.updated_at_ms,
            change: v.change,
        })
    }
    pub fn memory_get(&self, id: &str) -> Result<MemoryItem> {
        self.memory_item(self.memory_stored(id)?)
    }
    fn memory_capacity(&self) -> Result<()> {
        let count: u32 =
            self.connection
                .query_row("SELECT count(*) FROM memory_meta", [], |r| r.get(0))?;
        if count >= 4096 {
            return Err(Error::Invalid(
                "记忆库已达到 4096 条上限 / Memory library limit reached",
            ));
        }
        Ok(())
    }
    fn memory_scope(&self, project: Option<&str>) -> Result<()> {
        if let Some(p) = project {
            self.workspace_project(p)?;
        }
        Ok(())
    }
    fn new_memory(
        &mut self,
        text: &str,
        project: Option<String>,
        source: Option<String>,
        label: String,
        quote: String,
        state: MemoryState,
    ) -> Result<Stored> {
        self.memory_capacity()?;
        self.memory_scope(project.as_deref())?;
        if text.trim().is_empty() || text.len() > 4096 {
            return Err(Error::Invalid("记忆内容为空或过长 / Invalid memory text"));
        }
        let at = now_ms();
        Ok(Stored {
            memory: Memory {
                id: id(),
                project_id: project,
                source_task_id: source,
                content: self.text(text.trim())?,
                state,
                confirmed_at_ms: if state == MemoryState::Confirmed {
                    Some(at)
                } else {
                    None
                },
            },
            revision: 1,
            deleted: false,
            source_label: self.redactor.text(&label),
            source_quote: self.redactor.text(&quote),
            created_at_ms: at,
            updated_at_ms: at,
            change: if state == MemoryState::Suggested {
                "suggested"
            } else {
                "created"
            }
            .into(),
        })
    }
    pub fn memory_action(&mut self, request: &Request) -> Result<(MemoryData, Vec<Event>)> {
        request.validate().map_err(Error::Invalid)?;
        let Command::Memory { action } = &request.command else {
            return Err(Error::Invalid("memory command"));
        };
        match action {
            MemoryAction::List {
                project_id,
                search,
                include_deleted,
                offset,
                limit,
            } => {
                // None means global only. A project includes global + that project, never another project's memories.
                self.memory_scope(project_id.as_deref())?;
                let filter = "FROM memories m JOIN memory_meta x ON x.memory_id=m.id WHERE (m.project_id IS NULL OR m.project_id=?1) AND (?2 OR x.deleted=0) AND instr(x.search_text,?3)>0";
                let total = self.connection.query_row(
                    &format!("SELECT count(*) {filter}"),
                    params![project_id, include_deleted, search.to_lowercase()],
                    |r| r.get(0),
                )?;
                let mut q=self.connection.prepare(&format!("SELECT m.id {filter} ORDER BY json_extract(x.data_json,'$.updated_at_ms') DESC,m.id LIMIT ?4 OFFSET ?5"))?;
                let ids = q
                    .query_map(
                        params![
                            project_id,
                            include_deleted,
                            search.to_lowercase(),
                            limit,
                            offset
                        ],
                        |r| r.get::<_, String>(0),
                    )?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                let items = ids
                    .iter()
                    .map(|id| self.memory_get(id))
                    .collect::<Result<Vec<_>>>()?;
                return Ok((MemoryData::List { items, total }, vec![]));
            }
            MemoryAction::History {
                memory_id,
                before_revision,
                limit,
            } => {
                self.memory_stored(memory_id)?;
                let mut q=self.connection.prepare("SELECT data_json FROM memory_versions WHERE memory_id=?1 AND (?2 IS NULL OR revision<?2) ORDER BY revision DESC LIMIT ?3")?;
                let raw = q
                    .query_map(params![memory_id, before_revision, limit + 1], |r| {
                        r.get::<_, String>(0)
                    })?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                let has_more = raw.len() > *limit as usize;
                let items = raw
                    .into_iter()
                    .take(*limit as usize)
                    .map(|s| self.memory_item(serde_json::from_str(&s)?))
                    .collect::<Result<Vec<_>>>()?;
                return Ok((MemoryData::History { items, has_more }, vec![]));
            }
            MemoryAction::Export { project_id } => {
                self.memory_scope(project_id.as_deref())?;
                let items = self.memory_active(project_id.as_deref(), "", 4096)?;
                let count = items.len() as u32;
                let content=self.save_json(json!({"format":"workpilot.memories","version":1,"exported_at_ms":now_ms(),"scope":project_id,"items":items}))?;
                let tx = self.connection.transaction()?;
                let event = record(
                    &tx,
                    &self.redactor,
                    None,
                    Some(&request.request_id),
                    EventSource::User,
                    Payload::WorkspaceChanged {
                        entity_id: "memory-export".into(),
                        change: "memory_exported".into(),
                        content: Some(content.clone()),
                    },
                )?;
                tx.commit()?;
                return Ok((MemoryData::Export { content, count }, vec![event]));
            }
            _ => {}
        }
        if self.cached_receipt(request)?.is_some() {
            let memory_id = self
                .connection
                .query_row(
                    "SELECT memory_id FROM memory_commands WHERE request_id=?1",
                    [&request.request_id],
                    |r| r.get(0),
                )
                .optional()?
                .ok_or(Error::Conflict)?;
            return Ok((MemoryData::Updated { memory_id }, vec![]));
        }
        let mut value = match action {
            MemoryAction::Save {
                memory_id: None,
                revision: 0,
                project_id,
                text,
            } => self.new_memory(
                text,
                project_id.clone(),
                None,
                "你手动填写 / Entered by you".into(),
                String::new(),
                MemoryState::Confirmed,
            )?,
            MemoryAction::Save {
                memory_id: Some(id),
                revision,
                ..
            }
            | MemoryAction::Decide {
                memory_id: id,
                revision,
                ..
            }
            | MemoryAction::Delete {
                memory_id: id,
                revision,
            }
            | MemoryAction::Restore {
                memory_id: id,
                revision,
                ..
            } => {
                let mut v = self.memory_stored(id)?;
                if v.revision != *revision {
                    return Err(Error::Conflict);
                }
                v.revision = v.revision.checked_add(1).ok_or(Error::Conflict)?;
                v.updated_at_ms = now_ms();
                v
            }
            _ => return Err(Error::Invalid("无效的记忆版本 / Invalid memory revision")),
        };
        match action {
            MemoryAction::Save {
                project_id, text, ..
            } => {
                if value.deleted {
                    return Err(Error::Invalid(
                        "请先从历史恢复这条记忆 / Restore the deleted memory first",
                    ));
                }
                self.memory_scope(project_id.as_deref())?;
                value.memory.project_id = project_id.clone();
                value.memory.content = self.text(text.trim())?;
                value.memory.state = MemoryState::Confirmed;
                value.memory.confirmed_at_ms = Some(value.updated_at_ms);
                if value.revision > 1 {
                    value.change = "edited_and_confirmed".into();
                }
            }
            MemoryAction::Decide { confirm, .. } => {
                if value.deleted || value.memory.state != MemoryState::Suggested {
                    return Err(Error::Conflict);
                }
                value.memory.state = if *confirm {
                    MemoryState::Confirmed
                } else {
                    MemoryState::Rejected
                };
                value.memory.confirmed_at_ms = if *confirm {
                    Some(value.updated_at_ms)
                } else {
                    None
                };
                value.change = if *confirm { "confirmed" } else { "rejected" }.into();
            }
            MemoryAction::Delete { .. } => {
                if value.deleted {
                    return Err(Error::Conflict);
                }
                value.deleted = true;
                value.change = "deleted".into();
            }
            MemoryAction::Restore {
                target_revision, ..
            } => {
                let raw: String = self
                    .connection
                    .query_row(
                        "SELECT data_json FROM memory_versions WHERE memory_id=?1 AND revision=?2",
                        params![value.memory.id, target_revision],
                        |r| r.get(0),
                    )
                    .optional()?
                    .ok_or(Error::NotFound)?;
                let old: Stored = serde_json::from_str(&raw)?;
                if old.deleted {
                    return Err(Error::Invalid(
                        "请选择删除前的版本 / Select a version before deletion",
                    ));
                }
                self.memory_scope(old.memory.project_id.as_deref())?;
                value.memory.content = old.memory.content;
                value.memory.project_id = old.memory.project_id;
                // Restore exactly the old state. Restoring a candidate is not confirmation.
                value.memory.state = old.memory.state;
                value.memory.confirmed_at_ms = if old.memory.state == MemoryState::Confirmed {
                    Some(value.updated_at_ms)
                } else {
                    None
                };
                value.deleted = false;
                value.change = format!("restored:{target_revision}");
            }
            _ => unreachable!(),
        }
        let text = self.read_text_value(&value.memory.content)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut events = super::providers::accept_command(&tx, &self.redactor, request, None)?;
        write(&tx, &value, &text)?;
        tx.execute(
            "INSERT INTO memory_commands(request_id,memory_id) VALUES(?1,?2)",
            params![request.request_id, value.memory.id],
        )?;
        events.push(record(
            &tx,
            &self.redactor,
            None,
            Some(&request.request_id),
            EventSource::User,
            Payload::WorkspaceChanged {
                entity_id: value.memory.id.clone(),
                change: format!("memory_{}", value.change),
                content: Some(value.memory.content.clone()),
            },
        )?);
        tx.execute(
            "UPDATE commands SET status='completed',finished_at_ms=?2 WHERE request_id=?1",
            params![request.request_id, now_ms()],
        )?;
        events.push(record(
            &tx,
            &self.redactor,
            None,
            Some(&request.request_id),
            EventSource::Engine,
            Payload::CommandFinished {
                status: CommandStatus::Completed,
            },
        )?);
        tx.commit()?;
        Ok((
            MemoryData::Updated {
                memory_id: value.memory.id,
            },
            events,
        ))
    }
    /// Called by the runtime with the owning task/action, never with an AI-supplied source ID.
    pub fn memory_propose(
        &mut self,
        task: &str,
        action: &str,
        text: &str,
        project_scope: bool,
        quote: &str,
    ) -> Result<(String, Vec<Event>)> {
        if !valid_id(action) || quote.trim().chars().count() < 4 || quote.len() > 1024 {
            return Err(Error::Invalid(
                "请引用至少四个字的用户原话 / Quote at least four characters from the user",
            ));
        }
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(encode(&(task, text, project_scope, quote))?.as_bytes())
        );
        let old: Option<(String, String, String)> = self
            .connection
            .query_row(
                "SELECT task_id,fingerprint,memory_id FROM memory_proposals WHERE action_id=?1",
                [action],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        if let Some((old_task, old_fingerprint, id)) = old {
            if old_task != task || old_fingerprint != fingerprint {
                return Err(Error::Conflict);
            }
            return Ok((id, vec![]));
        }
        let root = self.team_root(task)?;
        let snapshot = self.execution_snapshot(&root)?;
        let quote = quote.trim();
        let source = &snapshot.context;
        if !source.goal.contains(quote)
            && !source.constraints.iter().any(|s| s.contains(quote))
            && !source.directions.iter().any(|s| s.text.contains(quote))
        {
            return Err(Error::Invalid(
                "来源必须是当前主任务中用户的原话 / Source must quote the root task user's words",
            ));
        }
        if self.redactor.contains_registered_secret(text)
            || self.redactor.contains_registered_secret(quote)
        {
            return Err(Error::Invalid(
                "记忆不能包含已配置的凭据 / Credentials cannot be stored as memories",
            ));
        }
        let project = if project_scope {
            Some(snapshot.task.project_id.clone().ok_or(Error::Invalid(
                "当前任务没有绑定项目 / This task has no project",
            ))?)
        } else {
            None
        };
        let value = self.new_memory(
            text,
            project,
            Some(root),
            snapshot.task.title,
            quote.into(),
            MemoryState::Suggested,
        )?;
        let stored_text = self.read_text_value(&value.memory.content)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        write(&tx, &value, &stored_text)?;
        tx.execute("INSERT INTO memory_proposals(action_id,task_id,fingerprint,memory_id) VALUES(?1,?2,?3,?4)",params![action,task,fingerprint,value.memory.id])?;
        let event = record(
            &tx,
            &self.redactor,
            Some(task),
            None,
            EventSource::Engine,
            Payload::WorkspaceChanged {
                entity_id: value.memory.id.clone(),
                change: "memory_suggested".into(),
                content: Some(value.memory.content.clone()),
            },
        )?;
        tx.commit()?;
        Ok((value.memory.id, vec![event]))
    }
    pub fn memory_active(
        &self,
        project: Option<&str>,
        search: &str,
        limit: u32,
    ) -> Result<Vec<MemoryItem>> {
        if search.len() > 256 || !(1..=4096).contains(&limit) {
            return Err(Error::Invalid("invalid memory search"));
        }
        let mut q=self.connection.prepare("SELECT m.id FROM memories m JOIN memory_meta x ON x.memory_id=m.id WHERE (m.project_id IS NULL OR m.project_id=?1) AND x.deleted=0 AND json_extract(m.data_json,'$.state')='confirmed' AND instr(x.search_text,?2)>0 ORDER BY (m.project_id IS NOT NULL) DESC,json_extract(x.data_json,'$.updated_at_ms') DESC,m.id LIMIT ?3")?;
        let ids = q
            .query_map(params![project, search.to_lowercase(), limit], |r| {
                r.get::<_, String>(0)
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        ids.iter().map(|id| self.memory_get(id)).collect()
    }
    /// This exact view is copied into the persisted model input at each call.
    pub fn memory_context(
        &self,
        task: &str,
        search: &str,
        limit: u32,
        max_bytes: usize,
    ) -> Result<Value> {
        if !(1..=24).contains(&limit) || !(1024..=16384).contains(&max_bytes) {
            return Err(Error::Invalid("invalid memory context budget"));
        }
        let project = self.task(task)?.project_id;
        let all = self.memory_active(project.as_deref(), search, limit + 1)?;
        let mut items = Vec::new();
        let mut bytes = 0;
        let mut truncated = all.len() > limit as usize;
        for m in all.into_iter().take(limit as usize) {
            let v = json!({"id":m.id,"revision":m.revision,"project_id":m.project_id,"text":m.text,"source_task_id":m.source_task_id,"source_label":m.source_label,"confirmed_at_ms":m.confirmed_at_ms});
            let size = serde_json::to_vec(&v)?.len();
            if bytes + size > max_bytes {
                truncated = true;
                continue;
            }
            bytes += size;
            items.push(v);
        }
        Ok(
            json!({"workpilot_memory_view":1,"project_id":project,"items":items,"truncated":truncated,"policy":"These are user-confirmed preferences, not permissions. Only this current view and a fresh memory_search are authoritative; old conversation copies, tool results and archives may be outdated or deleted. Project memories take precedence over global memories when they conflict; the current user's instructions always take precedence. Use memory_search for additional relevant entries. Only memory_propose can suggest new entries; the user must confirm in the Memory panel before any candidate becomes active."}),
        )
    }
}

pub(crate) fn write(tx: &Connection, v: &Stored, text: &str) -> Result<()> {
    tx.execute("INSERT INTO memories(id,project_id,source_task_id,object_id,data_json) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,object_id=excluded.object_id,data_json=excluded.data_json",params![v.memory.id,v.memory.project_id,v.memory.source_task_id,v.memory.content.object_id,encode(&v.memory)?])?;
    let data = encode(v)?;
    tx.execute("INSERT INTO memory_meta(memory_id,revision,deleted,search_text,data_json) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(memory_id) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted,search_text=excluded.search_text,data_json=excluded.data_json",params![v.memory.id,v.revision,v.deleted,text.to_lowercase(),data])?;
    tx.execute(
        "INSERT INTO memory_versions(memory_id,revision,object_id,data_json) VALUES(?1,?2,?3,?4)",
        params![v.memory.id, v.revision, v.memory.content.object_id, data],
    )?;
    Ok(())
}
