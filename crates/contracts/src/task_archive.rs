//! Read-only task/team archives. They never install live execution state.
use crate::*;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use ts_rs::TS;

pub const TASK_ARCHIVE_MAX_BYTES: u64 = 256 * 1024 * 1024;
pub const TASK_ARCHIVE_MAX_SNAPSHOT: u64 = 8 * 1024 * 1024;
pub const TASK_ARCHIVE_TABLES: &[&str] = &[
    "tasks",
    "agents",
    "messages",
    "runs",
    "execution_sessions",
    "execution_runs",
    "execution_checkpoints",
    "execution_steps",
    "controlled_effects",
    "execution_resolutions",
    "team_settings",
    "team_control",
    "team_members",
    "team_dependencies",
    "team_action_receipts",
    "team_waiters",
    "approvals",
    "tool_calls",
    "tool_approval_objects",
    "tool_result_objects",
    "model_calls",
    "workbench_operations",
    "workbench_output_objects",
    "managed_file_changes",
    "artifacts",
    "revisions",
    "commands",
    "events",
    "event_objects",
];

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum TaskArchiveAction {
    Export {
        task_id: String,
        path: String,
        password: SecretInput,
    },
    Inspect {
        path: String,
        password: SecretInput,
    },
    Import {
        path: String,
        password: SecretInput,
        fingerprint: String,
    },
    List,
    Records {
        archive_id: String,
        table: String,
        offset: u32,
        limit: u32,
    },
    ExportSaved {
        archive_id: String,
        path: String,
        password: SecretInput,
    },
}
impl TaskArchiveAction {
    pub fn validate(&self) -> Result<(), &'static str> {
        let (path, password) = match self {
            Self::List => return Ok(()),
            Self::Records {
                archive_id,
                table,
                offset,
                limit,
            } => {
                if !valid_id(archive_id)
                    || (table != "contents" && !TASK_ARCHIVE_TABLES.contains(&table.as_str()))
                    || *offset > 50_000
                    || !(1..=32).contains(limit)
                {
                    return Err("档案查询无效 / Invalid archive query");
                }
                return Ok(());
            }
            Self::Export {
                task_id,
                path,
                password,
            } => {
                if !valid_id(task_id) {
                    return Err("Invalid source task");
                }
                (path, password)
            }
            Self::ExportSaved {
                archive_id,
                path,
                password,
            } => {
                if !valid_id(archive_id) {
                    return Err("Invalid archive identity");
                }
                (path, password)
            }
            Self::Inspect { path, password } => (path, password),
            Self::Import {
                path,
                password,
                fingerprint,
            } => {
                if !task_archive_checksum(fingerprint) {
                    return Err("请重新预览 / Preview again");
                }
                (path, password)
            }
        };
        HistoryTransferAction::Inspect {
            path: path.clone(),
            password: password.clone(),
        }
        .validate()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ArchiveTask {
    pub id: String,
    pub title: String,
    pub state: TaskState,
    pub parent_task_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct TaskArchiveIndex {
    pub version: u32,
    pub archive_id: String,
    pub created_at_ms: u64,
    pub root_task_id: String,
    pub tasks: Vec<ArchiveTask>,
    pub snapshot: ContentRef,
    pub objects: Vec<ContentRef>,
    pub counts: std::collections::BTreeMap<String, u32>,
    /// Only descriptors/counts; encrypted attachment originals and version vaults
    /// use the existing separate transfer formats until cross-package mapping lands.
    pub excluded_media: u32,
    pub excluded_file_revisions: u32,
}
impl TaskArchiveIndex {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.version != 1
            || !valid_id(&self.archive_id)
            || self.tasks.is_empty()
            || self.tasks.len() > 33
            || self.tasks[0].id != self.root_task_id
            || self.tasks[0].parent_task_id.is_some()
            || self.objects.len() > 4096
            || self.snapshot.bytes > TASK_ARCHIVE_MAX_SNAPSHOT
            || self.snapshot.media_type != "application/json"
            || !self.objects.contains(&self.snapshot)
            || self.counts.len() != TASK_ARCHIVE_TABLES.len()
            || self
                .counts
                .keys()
                .any(|s| !TASK_ARCHIVE_TABLES.contains(&s.as_str()))
            || self.counts.values().map(|n| u64::from(*n)).sum::<u64>() > 50_000
        {
            return Err("不支持的任务档案或超出容量 / Unsupported or oversized task archive");
        }
        let mut tasks = HashSet::new();
        for task in &self.tasks {
            if !valid_id(&task.id)
                || task.title.len() > 512
                || !tasks.insert(&task.id)
                || task
                    .parent_task_id
                    .as_ref()
                    .is_some_and(|p| !tasks.contains(p) || p == &task.id)
            {
                return Err("任务关系无效 / Invalid task relationships");
            }
        }
        let mut ids = HashSet::new();
        let mut bytes = 0_u64;
        for content in &self.objects {
            if !task_archive_checksum(&content.object_id)
                || content.bytes > 64 * 1024 * 1024
                || content.media_type.len() > 128
                || !ids.insert(&content.object_id)
            {
                return Err("档案内容索引无效 / Invalid archive content index");
            }
            bytes += content.bytes;
        }
        if bytes > TASK_ARCHIVE_MAX_BYTES {
            return Err("任务档案超过 256 MiB / Archive exceeds 256 MiB");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskArchiveSnapshot {
    pub version: u32,
    pub source_schema: u32,
    pub root_task_id: String,
    pub tables: std::collections::BTreeMap<String, Vec<serde_json::Value>>,
}
pub fn task_archive_checksum(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
