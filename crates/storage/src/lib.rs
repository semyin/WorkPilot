//! Durable state is owned by this crate; consumers use typed operations only.
mod commands;
mod execution;
#[cfg(test)]
mod execution_tests;
mod extension_transfer;
#[cfg(test)]
mod extension_transfer_tests;
mod extensions;
mod history_transfer;
mod media;
mod memory;
#[cfg(test)]
mod memory_tests;
#[cfg(test)]
mod memory_transfer_tests;
mod objects;
mod project_transfer;
#[cfg(test)]
mod provider_tests;
mod providers;
mod redaction;
mod schedule;
#[cfg(test)]
mod schedule_tests;
pub mod schedule_time;
mod team;
#[cfg(test)]
mod team_tests;
mod tool;
mod workbench;
mod worker;
mod workspace;
#[cfg(test)]
mod workspace_tests;
pub use redaction::Redactor;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{BufRead, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
pub use worker::{Storage, WORK_QUEUE_CAPACITY};
use workpilot_contracts::*;

pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid input: {0}")]
    Invalid(&'static str),
    #[error("record not found")]
    NotFound,
    #[error("request or state conflict")]
    Conflict,
    #[error("data directory is already in use")]
    Busy,
    #[error("database version is unsupported")]
    UnsupportedVersion,
    #[error("stored data failed verification: {0}")]
    Corrupt(&'static str),
    #[error("storage worker is closed")]
    WorkerClosed,
    #[error("database operation failed")]
    Sql(#[from] rusqlite::Error),
    #[error("local file operation failed")]
    Io(#[from] std::io::Error),
    #[error("record format is invalid")]
    Json(#[from] serde_json::Error),
}
impl Error {
    pub fn code(&self) -> ErrorCode {
        match self {
            Self::Invalid(_) => ErrorCode::InvalidRequest,
            Self::NotFound => ErrorCode::NotFound,
            Self::Conflict => ErrorCode::Conflict,
            Self::Busy => ErrorCode::Busy,
            Self::UnsupportedVersion => ErrorCode::UnsupportedVersion,
            _ => ErrorCode::Storage,
        }
    }
}
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn encode<T: Serialize>(value: &T) -> Result<String> {
    Ok(serde_json::to_string(value)?)
}
fn word<T: Serialize>(value: &T) -> Result<String> {
    serde_json::to_value(value)?
        .as_str()
        .map(str::to_owned)
        .ok_or(Error::Invalid("enum"))
}
fn parse_word<T: DeserializeOwned>(value: String) -> Result<T> {
    Ok(serde_json::from_value(serde_json::Value::String(value))?)
}

pub struct Store {
    connection: Connection,
    directory: PathBuf,
    redactor: Redactor,
    _lock: File,
}
impl Store {
    pub fn open(directory: &Path) -> Result<Self> {
        if !directory.is_absolute() {
            return Err(Error::Invalid("data path must be absolute"));
        }
        std::fs::create_dir_all(directory)?;
        let directory = directory.canonicalize()?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(directory.join("engine.lock"))?;
        lock.try_lock().map_err(|_| Error::Busy)?;
        std::fs::create_dir_all(directory.join("objects"))?;
        std::fs::create_dir_all(directory.join("backups"))?;
        let mut connection = Connection::open(directory.join("workpilot.sqlite3"))?;
        connection.busy_timeout(std::time::Duration::from_millis(1000))?;
        connection.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-4096; PRAGMA wal_autocheckpoint=256;")?;
        migrate(
            &mut connection,
            &directory,
            &[
                (1, include_str!("../migrations/001_initial.sql")),
                (2, include_str!("../migrations/002_providers.sql")),
                (3, include_str!("../migrations/003_execution.sql")),
                (4, include_str!("../migrations/004_tools.sql")),
                (5, include_str!("../migrations/005_teams.sql")),
                (6, include_str!("../migrations/006_workspace.sql")),
                (7, include_str!("../migrations/007_workbench.sql")),
                (8, include_str!("../migrations/008_extensions.sql")),
                (9, include_str!("../migrations/009_media.sql")),
                (10, include_str!("../migrations/010_memory.sql")),
                (11, include_str!("../migrations/011_schedules.sql")),
            ],
        )?;
        let mut store = Self {
            connection,
            directory,
            redactor: Redactor::default(),
            _lock: lock,
        };
        store.recover()?;
        store.recover_model_calls()?;
        store.recover_executions()?;
        store.recover_teams()?;
        store.recover_workbench()?;
        store.memory_reindex()?;
        store.recover_schedules()?;
        Ok(store)
    }
    pub fn register_secret(&mut self, value: &str) -> Result<()> {
        self.redactor.register(value)
    }
    pub fn save_text(&mut self, reader: &mut impl BufRead) -> Result<ContentRef> {
        let content = objects::put_text(&self.directory, reader, &self.redactor)?;
        self.connection.execute(
            "INSERT OR IGNORE INTO objects(id,bytes,media_type) VALUES(?1,?2,?3)",
            params![content.object_id, content.bytes, content.media_type],
        )?;
        content_ref(&self.connection, &content.object_id)
    }
    fn text(&mut self, value: &str) -> Result<ContentRef> {
        self.save_text(&mut value.as_bytes())
    }
    pub fn save_project(&mut self, project: &Project) -> Result<()> {
        if !valid_id(&project.id)
            || !Path::new(&project.root_path).is_absolute()
            || project.name.len() > 512
        {
            return Err(Error::Invalid("project"));
        }
        let mut data = serde_json::to_value(project)?;
        self.redactor.value(&mut data);
        // P01 stores the binding only; this method never creates/deletes project files.
        self.connection.execute(
            "INSERT INTO projects(id,root_path,data_json) VALUES(?1,?2,?3)",
            params![
                project.id,
                self.redactor.text(&project.root_path),
                encode(&data)?
            ],
        )?;
        Ok(())
    }
    pub fn save_profile(&mut self, profile: &ProviderProfile) -> Result<()> {
        if !valid_id(&profile.id)
            || profile
                .credential
                .as_ref()
                .is_some_and(|c| !valid_id(&c.id))
            || profile.base_url.len() > 2048
            || profile.model.len() > 512
            || profile.label.len() > 512
        {
            return Err(Error::Invalid("provider profile"));
        }
        // Keys in URL query/userinfo are deliberately not accepted as configuration.
        if profile.base_url.contains(['?', '#', '@']) {
            return Err(Error::Invalid("credentials or query in base URL"));
        }
        let mut data = serde_json::to_value(profile)?;
        self.redactor.value(&mut data);
        self.connection.execute("INSERT INTO provider_profiles(id,data_json) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json",
            params![profile.id, encode(&data)?])?;
        Ok(())
    }
    pub fn append(
        &mut self,
        task_id: Option<&str>,
        request: Option<&str>,
        payload: Payload,
    ) -> Result<Event> {
        if task_id.is_some_and(|s| !valid_id(s)) {
            return Err(Error::Invalid("task_id"));
        }
        // State-bearing events must only be created by their transactional operations.
        if !matches!(
            payload,
            Payload::Progress { .. }
                | Payload::Ready { .. }
                | Payload::Bye
                | Payload::Error { .. }
                | Payload::TextDelta { .. }
                | Payload::UsageRecorded { .. }
        ) {
            return Err(Error::Invalid("use a state transition operation"));
        }
        let tx = self.connection.transaction()?;
        let event = record(
            &tx,
            &self.redactor,
            task_id,
            request,
            EventSource::Engine,
            payload,
        )?;
        tx.commit()?;
        Ok(event)
    }
    pub fn start_tool(&mut self, call: &ToolCall) -> Result<Event> {
        if !valid_id(&call.id)
            || call.state != ToolState::Started
            || call.output.is_some()
            || call.ended_at_ms.is_some()
            || call.name.len() > 256
        {
            return Err(Error::Invalid("new tool call"));
        }
        objects::verify(&self.directory, &call.input)?;
        let tx = self.connection.transaction()?;
        let owns: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM runs WHERE id=?1 AND task_id=?2 AND state='running')",
            params![call.run_id, call.task_id],
            |r| r.get(0),
        )?;
        if !owns {
            return Err(Error::Conflict);
        }
        tx.execute("INSERT INTO tool_calls(id,task_id,run_id,agent_id,name,state,input_object_id,approval_id,started_at_ms) VALUES(?1,?2,?3,?4,?5,'started',?6,?7,?8)",
            params![call.id,call.task_id,call.run_id,call.agent_id,self.redactor.text(&call.name),call.input.object_id,call.approval_id,call.started_at_ms])?;
        let event = record(
            &tx,
            &self.redactor,
            Some(&call.task_id),
            None,
            EventSource::Tool,
            Payload::ToolStarted {
                tool_call_id: call.id.clone(),
                name: call.name.clone(),
                input: call.input.clone(),
            },
        )?;
        tx.commit()?;
        Ok(event)
    }
    pub fn finish_tool(
        &mut self,
        tool: &str,
        state: ToolState,
        output: &ContentRef,
    ) -> Result<Event> {
        if !matches!(state, ToolState::Succeeded | ToolState::Failed) {
            return Err(Error::Invalid("tool end state"));
        }
        objects::verify(&self.directory, output)?;
        let tx = self.connection.transaction()?;
        let task: String = tx
            .query_row("SELECT task_id FROM tool_calls WHERE id=?1", [tool], |r| {
                r.get(0)
            })
            .optional()?
            .ok_or(Error::NotFound)?;
        if tx.execute("UPDATE tool_calls SET state=?2,output_object_id=?3,ended_at_ms=?4 WHERE id=?1 AND state='started'",params![tool,word(&state)?,output.object_id,now_ms()])? != 1 {return Err(Error::Conflict);}
        let event = record(
            &tx,
            &self.redactor,
            Some(&task),
            None,
            EventSource::Tool,
            Payload::ToolFinished {
                tool_call_id: tool.into(),
                state,
                output: output.clone(),
            },
        )?;
        tx.commit()?;
        Ok(event)
    }
    pub fn query(&self, query: &Query) -> Result<Response> {
        query.validate().map_err(Error::Invalid)?;
        match query {
            Query::Workspace { query } => Ok(Response::Workspace {
                data: Box::new(self.workspace_query(query)?),
            }),
            Query::TaskTools { task_id } => Ok(Response::TaskTools {
                state: Box::new(self.tool_task_state(task_id)?),
            }),
            Query::Team { task_id } => Ok(Response::Team {
                view: Box::new(self.team_view(task_id)?),
            }),
            Query::ToolDefaults => Ok(Response::ToolDefaults {
                settings: self.tool_defaults()?,
            }),
            Query::ToolRegistry => Err(Error::Invalid("tool registry is provided by the engine")),
            Query::Execution { task_id } => Ok(Response::Execution {
                snapshot: Box::new(self.execution_snapshot(task_id)?),
            }),
            Query::Executions { limit } => Ok(Response::Executions {
                tasks: self.execution_tasks(*limit)?,
            }),
            Query::ModelCalls { limit } => Ok(Response::ModelCalls {
                calls: self.model_calls(*limit)?,
            }),
            Query::Profiles | Query::ExportProfiles => {
                Err(Error::Invalid("use model service query"))
            }
            Query::Events {
                after,
                task_id,
                limit,
            } => Ok(Response::Events {
                page: read_events(&self.connection, *after, task_id.as_deref(), *limit)?,
            }),
            Query::Tasks { before, limit } => {
                let mut statement = self.connection.prepare("SELECT id FROM tasks WHERE archived=0 AND id NOT IN (SELECT task_id FROM team_members) AND (?1 IS NULL OR (created_at_ms,id) < (SELECT created_at_ms,id FROM tasks WHERE id=?1)) ORDER BY created_at_ms DESC,id DESC LIMIT ?2")?;
                let ids: Vec<String> = statement
                    .query_map(params![before, limit], |r| r.get(0))?
                    .collect::<std::result::Result<_, _>>()?;
                let tasks = ids
                    .iter()
                    .map(|id| self.task(id))
                    .collect::<Result<Vec<_>>>()?;
                Ok(Response::Tasks {
                    page: TaskPage {
                        next_before: if ids.len() == *limit as usize {
                            ids.last().cloned()
                        } else {
                            None
                        },
                        tasks,
                    },
                })
            }
            Query::Content {
                object_id,
                offset,
                limit,
            } => {
                let content = content_ref(&self.connection, object_id)?;
                Ok(Response::Content {
                    page: objects::read(&self.directory, &content, *offset, *limit)?,
                })
            }
        }
    }
    pub fn task(&self, id: &str) -> Result<Task> {
        let raw = self.connection.query_row("SELECT project_id,title,state,mode,permission,profile_id,created_at_ms,updated_at_ms,last_sequence FROM tasks WHERE id=?1",[id],|r|Ok((
            r.get::<_,Option<String>>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,
            r.get::<_,Option<String>>(5)?,r.get::<_,u64>(6)?,r.get::<_,u64>(7)?,r.get::<_,u64>(8)?
        ))).optional()?.ok_or(Error::NotFound)?;
        Ok(Task {
            id: id.into(),
            project_id: raw.0,
            title: raw.1,
            state: parse_word(raw.2)?,
            mode: parse_word(raw.3)?,
            permission: parse_word(raw.4)?,
            profile_id: raw.5,
            created_at_ms: raw.6,
            updated_at_ms: raw.7,
            last_sequence: raw.8,
        })
    }
    pub fn running_run(&self, task: &str) -> Result<String> {
        self.connection
            .query_row(
                "SELECT id FROM runs WHERE task_id=?1 AND state='running'",
                [task],
                |r| r.get(0),
            )
            .optional()?
            .ok_or(Error::NotFound)
    }
    /// Recovery is evidence of interruption, never permission to rerun a tool.
    fn recover(&mut self) -> Result<()> {
        let tx = self.connection.transaction()?;
        loop {
            let task:Option<String>=tx.query_row("SELECT id FROM tasks WHERE state IN ('running','stopping','awaiting_input','awaiting_approval') LIMIT 1",[],|r|r.get(0)).optional()?;
            let Some(task) = task else {
                break;
            };
            tx.execute(
                "UPDATE tasks SET state='interrupted',updated_at_ms=?2 WHERE id=?1",
                params![task, now_ms()],
            )?;
            tx.execute("UPDATE runs SET state='interrupted',ended_at_ms=?2,failure_code='engine_exit' WHERE task_id=?1 AND state='running'",params![task,now_ms()])?;
            loop {
                let tool: Option<String> = tx
                    .query_row(
                        "SELECT id FROM tool_calls WHERE task_id=?1 AND state='started' LIMIT 1",
                        [&task],
                        |r| r.get(0),
                    )
                    .optional()?;
                let Some(tool) = tool else {
                    break;
                };
                tx.execute(
                    "UPDATE tool_calls SET state='needs_review' WHERE id=?1",
                    [&tool],
                )?;
                record(
                    &tx,
                    &self.redactor,
                    Some(&task),
                    None,
                    EventSource::Recovery,
                    Payload::ToolNeedsReview { tool_call_id: tool },
                )?;
            }
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
        loop {
            let command: Option<(String, Option<String>)> = tx
                .query_row(
                    "SELECT request_id,task_id FROM commands WHERE status='accepted' LIMIT 1",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let Some((request, task)) = command else {
                break;
            };
            tx.execute(
                "UPDATE commands SET status='interrupted',finished_at_ms=?2 WHERE request_id=?1",
                params![request, now_ms()],
            )?;
            record(
                &tx,
                &self.redactor,
                task.as_deref(),
                Some(&request),
                EventSource::Recovery,
                Payload::CommandFinished {
                    status: CommandStatus::Interrupted,
                },
            )?;
        }
        tx.commit()?;
        Ok(())
    }
    /// All reference owners are enumerated. Project paths are NEVER passed to filesystem deletion.
    pub fn collect_unreferenced_objects(&mut self) -> Result<u64> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch("CREATE TEMP TABLE live_objects AS
            SELECT object_id id FROM event_objects UNION SELECT object_id FROM messages
            UNION SELECT result_object_id FROM runs WHERE result_object_id IS NOT NULL
            UNION SELECT input_object_id FROM tool_calls UNION SELECT output_object_id FROM tool_calls WHERE output_object_id IS NOT NULL
            UNION SELECT object_id FROM revisions UNION SELECT object_id FROM memories UNION SELECT object_id FROM schedules
            UNION SELECT object_id FROM memory_versions
            UNION SELECT plan_object_id FROM schedule_occurrences
            UNION SELECT before_object_id FROM managed_file_changes WHERE before_object_id IS NOT NULL
            UNION SELECT after_object_id FROM managed_file_changes
            UNION SELECT intent_object_id FROM tool_approval_objects
            UNION SELECT object_id FROM team_action_receipts
            UNION SELECT report_object_id FROM team_members WHERE report_object_id IS NOT NULL
            UNION SELECT inspected_object_id FROM team_members WHERE inspected_object_id IS NOT NULL
            UNION SELECT object_id FROM tool_result_objects
            UNION SELECT object_id FROM workbench_output_objects
            UNION SELECT output_object_id FROM model_calls WHERE output_object_id IS NOT NULL
            UNION SELECT config_object_id FROM execution_sessions UNION SELECT context_object_id FROM execution_sessions
            UNION SELECT context_object_id FROM execution_checkpoints
            UNION SELECT input_object_id FROM execution_steps UNION SELECT output_object_id FROM execution_steps WHERE output_object_id IS NOT NULL
            UNION SELECT output_object_id FROM controlled_effects
            UNION SELECT output_object_id FROM execution_resolutions;")?;
        // Check missing referenced content before deleting anything.
        {
            let mut stmt = tx.prepare("SELECT id FROM live_objects")?;
            for item in stmt.query_map([], |r| r.get::<_, String>(0))? {
                let content = content_ref(&tx, &item?)?;
                objects::verify(&self.directory, &content)?;
            }
        }
        let mut count = 0;
        for entry in std::fs::read_dir(self.directory.join("objects"))? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = match objects::object_path(&self.directory, &name) {
                Ok(path) => path,
                Err(_) => continue,
            };
            if !entry.file_type()?.is_file() {
                continue;
            }
            let live: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM live_objects WHERE id=?1)",
                [&name],
                |r| r.get(0),
            )?;
            if !live {
                std::fs::remove_file(path)?;
                tx.execute("DELETE FROM objects WHERE id=?1", [name])?;
                count += 1;
            }
        }
        tx.execute_batch("DELETE FROM objects WHERE id NOT IN (SELECT id FROM live_objects); DROP TABLE live_objects;")?;
        tx.commit()?;
        Ok(count)
    }
    pub fn export_events(&self, writer: &mut impl Write, task: Option<&str>) -> Result<u64> {
        export_events(&self.connection, writer, task)
    }
}

fn migrate(
    connection: &mut Connection,
    directory: &Path,
    migrations: &[(u32, &str)],
) -> Result<()> {
    let version: u32 = connection.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let target = migrations.last().map_or(0, |m| m.0);
    if version > target {
        return Err(Error::UnsupportedVersion);
    }
    if version == target {
        return Ok(());
    }
    let backup = directory
        .join("backups")
        .join(format!("before-v{version}-{}.sqlite3", id()));
    connection.backup(rusqlite::MAIN_DB, &backup, None)?;
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(&backup)?
        .sync_all()?;
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for (number, sql) in migrations.iter().filter(|m| m.0 > version) {
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", number)?;
    }
    let check: String = tx.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    if check != "ok" {
        return Err(Error::Corrupt("migration integrity"));
    }
    let violations: u64 =
        tx.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })?;
    if violations != 0 {
        return Err(Error::Corrupt("migration references"));
    }
    tx.commit()?;
    Ok(())
}
fn content_ref(connection: &Connection, id: &str) -> Result<ContentRef> {
    connection
        .query_row(
            "SELECT bytes,media_type FROM objects WHERE id=?1",
            [id],
            |r| {
                Ok(ContentRef {
                    object_id: id.into(),
                    bytes: r.get(0)?,
                    media_type: r.get(1)?,
                })
            },
        )
        .optional()?
        .ok_or(Error::NotFound)
}
fn record(
    connection: &Connection,
    redactor: &Redactor,
    task: Option<&str>,
    request: Option<&str>,
    source: EventSource,
    payload: Payload,
) -> Result<Event> {
    let mut json = serde_json::to_value(payload)?;
    redactor.value(&mut json);
    let payload: Payload = serde_json::from_value(json)?;
    let encoded = encode(&payload)?;
    if encoded.len() > MAX_EVENT_BYTES {
        return Err(Error::Invalid(
            "event exceeds 64 KiB; use content reference",
        ));
    }
    let task_sequence = match task {
        Some(task) => Some(connection.query_row(
            "SELECT COALESCE(MAX(task_sequence),0)+1 FROM events WHERE task_id=?1",
            [task],
            |r| r.get::<_, u64>(0),
        )?),
        None => None,
    };
    let agent_id = match &payload {
        Payload::AgentChanged { agent_id, .. } | Payload::ExecutionCreated { agent_id, .. } => {
            Some(agent_id.clone())
        }
        Payload::ToolStarted { tool_call_id, .. }
        | Payload::ToolFinished { tool_call_id, .. }
        | Payload::ToolNeedsReview { tool_call_id } => connection.query_row(
            "SELECT agent_id FROM tool_calls WHERE id=?1",
            [tool_call_id],
            |r| r.get(0),
        )?,
        Payload::ExecutionQueued { run_id }
        | Payload::ExecutionStarted { run_id, .. }
        | Payload::ExecutionStepChanged { run_id, .. }
        | Payload::ExecutionText { run_id, .. }
        | Payload::ExecutionEnded { run_id, .. }
        | Payload::CheckpointSaved { run_id, .. }
        | Payload::ContextCompacted { run_id, .. }
        | Payload::MessageDelivered { run_id, .. } => {
            connection.query_row("SELECT agent_id FROM runs WHERE id=?1", [run_id], |r| {
                r.get(0)
            })?
        }
        _ => None,
    };
    let mut event = Event {
        protocol: PROTOCOL.into(),
        event_id: id(),
        sequence: 0,
        task_id: task.map(str::to_owned),
        task_sequence,
        agent_id,
        source,
        at_ms: now_ms(),
        request_id: request.map(str::to_owned),
        payload,
    };
    connection.execute("INSERT INTO events(event_id,task_id,task_sequence,agent_id,source,at_ms,request_id,payload_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        params![event.event_id,task,task_sequence,event.agent_id,word(&source)?,event.at_ms,request,encoded])?;
    event.sequence = connection.last_insert_rowid() as u64;
    if let Some(task) = task {
        connection.execute(
            "UPDATE tasks SET last_sequence=?2 WHERE id=?1",
            params![task, event.sequence],
        )?;
    }
    let reference = match &event.payload {
        Payload::ToolApprovalRequested {
            intent: content, ..
        }
        | Payload::TextDelta { content }
        | Payload::ModelText { content, .. }
        | Payload::ModelReasoning { content, .. }
        | Payload::MessageQueued { content, .. }
        | Payload::ArtifactCreated { content, .. } => Some(content),
        Payload::WorkspaceChanged { content, .. } => content.as_ref(),
        Payload::ExecutionCreated { goal: content, .. }
        | Payload::ExecutionText { content, .. }
        | Payload::ContextCompacted {
            archive: content, ..
        } => Some(content),
        Payload::WorkbenchChanged { record: output, .. }
        | Payload::TeamChanged { record: output, .. }
        | Payload::ExecutionEnded { output, .. } => output.as_ref(),
        Payload::ToolStarted { input, .. } => Some(input),
        Payload::ToolFinished { output, .. } => Some(output),
        Payload::ModelCallEnded { output, .. } => output.as_ref(),
        _ => None,
    };
    if let Some(content) = reference {
        if content_ref(connection, &content.object_id)? != *content {
            return Err(Error::Invalid("object reference mismatch"));
        }
        connection.execute(
            "INSERT INTO event_objects(event_sequence,object_id) VALUES(?1,?2)",
            params![event.sequence, content.object_id],
        )?;
    }
    if let Payload::ExecutionStepChanged { input, output, .. } = &event.payload {
        for content in [input, output].into_iter().flatten() {
            if content_ref(connection, &content.object_id)? != *content {
                return Err(Error::Invalid("object reference mismatch"));
            }
            connection.execute(
                "INSERT OR IGNORE INTO event_objects(event_sequence,object_id) VALUES(?1,?2)",
                params![event.sequence, content.object_id],
            )?;
        }
    }
    let extra: Vec<&ContentRef> = match &event.payload {
        Payload::ToolReviewFinished { review, .. } => {
            [review.input.as_ref(), review.output.as_ref()]
                .into_iter()
                .flatten()
                .collect()
        }
        Payload::ManagedFileChanged { change } => {
            [change.before_content.as_ref(), Some(&change.after_content)]
                .into_iter()
                .flatten()
                .collect()
        }
        _ => vec![],
    };
    for content in extra {
        if content_ref(connection, &content.object_id)? != *content {
            return Err(Error::Invalid("object reference mismatch"));
        }
        connection.execute(
            "INSERT OR IGNORE INTO event_objects(event_sequence,object_id) VALUES(?1,?2)",
            params![event.sequence, content.object_id],
        )?;
    }
    Ok(event)
}
fn read_events(
    connection: &Connection,
    after: u64,
    task: Option<&str>,
    limit: u32,
) -> Result<EventPage> {
    Query::Events {
        after,
        task_id: task.map(str::to_owned),
        limit,
    }
    .validate()
    .map_err(Error::Invalid)?;
    let high: u64 = connection.query_row(
        "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='events'),0)",
        [],
        |r| r.get(0),
    )?;
    let mut statement=connection.prepare("SELECT sequence,event_id,task_id,task_sequence,agent_id,source,at_ms,request_id,payload_json FROM events WHERE sequence>?1 AND sequence<=?2 AND (?3 IS NULL OR task_id=?3) ORDER BY sequence LIMIT ?4")?;
    let mut rows = statement.query(params![after, high, task, limit + 1])?;
    let mut events = vec![];
    while let Some(r) = rows.next()? {
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
    let more = events.len() > limit as usize;
    if more {
        events.pop();
    }
    let next = if more {
        events.last().map_or(after, |e| e.sequence)
    } else {
        high.max(after)
    };
    Ok(EventPage {
        events,
        next_after: next,
        high_watermark: high,
        has_more: more,
    })
}
fn export_events(
    connection: &Connection,
    writer: &mut impl Write,
    task: Option<&str>,
) -> Result<u64> {
    // Pin a read transaction so concurrently arriving events cannot cause an endless export.
    let tx = connection.unchecked_transaction()?;
    let header = ExportHeader {
        format: "workpilot.events".into(),
        version: EXPORT_VERSION,
        schema_version: SCHEMA_VERSION,
        created_at_ms: now_ms(),
        credentials_included: false,
    };
    serde_json::to_writer(&mut *writer, &header)?;
    writer.write_all(b"\n")?;
    let (mut after, mut count) = (0, 0);
    loop {
        let page = read_events(&tx, after, task, MAX_PAGE)?;
        for event in &page.events {
            serde_json::to_writer(&mut *writer, event)?;
            writer.write_all(b"\n")?;
            count += 1;
        }
        after = page.next_after;
        if !page.has_more {
            break;
        }
    }
    writer.flush()?;
    tx.commit()?;
    Ok(count)
}
/// Read-only developer inspector; cannot migrate, recover or mutate a live engine.
pub struct Inspector {
    connection: Connection,
}
impl Inspector {
    pub fn open(directory: &Path) -> Result<Self> {
        let connection = Connection::open_with_flags(
            directory.join("workpilot.sqlite3"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        let version: u32 = connection.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version != SCHEMA_VERSION {
            return Err(Error::UnsupportedVersion);
        }
        Ok(Self { connection })
    }
    pub fn events(&self, after: u64, task: Option<&str>, limit: u32) -> Result<EventPage> {
        read_events(&self.connection, after, task, limit)
    }
    pub fn export_events(&self, writer: &mut impl Write, task: Option<&str>) -> Result<u64> {
        export_events(&self.connection, writer, task)
    }
}
#[cfg(test)]
mod tests;
