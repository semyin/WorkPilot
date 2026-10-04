//! Task/team archives. Import is read-only; restoration is a separate confirmation.
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
    RecoveryStatus {
        task_id: String,
    },
    ResolveRecovery {
        task_id: String,
        notes: Vec<String>,
    },
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
    Cancel,
    TeamRestoreOptions {
        archive_id: String,
    },
    MappedRestorePreview {
        archive_id: String,
        profiles: Vec<TaskProfileMapping>,
        projects: Vec<TaskProjectMapping>,
        history_roots: Vec<HistoryRootMapping>,
    },
    MappedRestore {
        archive_id: String,
        profiles: Vec<TaskProfileMapping>,
        projects: Vec<TaskProjectMapping>,
        history_roots: Vec<HistoryRootMapping>,
        fingerprint: String,
    },
    TeamRestorePreview {
        archive_id: String,
        project_id: Option<String>,
        profiles: Vec<TaskProfileMapping>,
    },
    TeamRestore {
        archive_id: String,
        project_id: Option<String>,
        profiles: Vec<TaskProfileMapping>,
        fingerprint: String,
    },
    RestorePreview {
        archive_id: String,
        project_id: Option<String>,
        profile_id: String,
    },
    Restore {
        archive_id: String,
        project_id: Option<String>,
        profile_id: String,
        fingerprint: String,
    },
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
            Self::RecoveryStatus { task_id } | Self::ResolveRecovery { task_id, .. } => {
                if !valid_id(task_id)
                    || matches!(self,Self::ResolveRecovery {notes,..} if
                    notes.is_empty() || notes.len()>512 || notes.iter().any(|s|s.trim().len()<2||s.len()>4096))
                {
                    return Err("请逐项说明核对结果 / Explain the result of checking each item");
                }
                return Ok(());
            }
            Self::List | Self::Cancel => return Ok(()),
            Self::MappedRestorePreview {
                archive_id,
                profiles,
                projects,
                history_roots,
            }
            | Self::MappedRestore {
                archive_id,
                profiles,
                projects,
                history_roots,
                ..
            } => {
                if !valid_id(archive_id)
                    || profiles.is_empty()
                    || profiles.len() > 33
                    || profiles
                        .iter()
                        .any(|p| !valid_id(&p.task_id) || !valid_id(&p.profile_id))
                    || projects.len() > 34
                    || projects.iter().any(|p| {
                        p.source_project_id.as_ref().is_some_and(|s| !valid_id(s))
                            || p.project_id.as_ref().is_some_and(|s| !valid_id(s))
                    })
                    || history_roots.len() > 128
                    || history_roots.iter().any(|m| {
                        m.source_root.is_empty()
                            || m.source_root.len() > 4096
                            || !valid_id(&m.project_id)
                    })
                    || matches!(self,Self::MappedRestore {fingerprint,..} if !task_archive_checksum(fingerprint))
                {
                    return Err("迁移映射无效 / Invalid migration mappings");
                }
                return Ok(());
            }
            Self::TeamRestoreOptions { archive_id } => {
                return valid_id(archive_id)
                    .then_some(())
                    .ok_or("Invalid archive identity");
            }
            Self::TeamRestorePreview {
                archive_id,
                project_id,
                profiles,
            }
            | Self::TeamRestore {
                archive_id,
                project_id,
                profiles,
                ..
            } => {
                let mut seen = HashSet::new();
                if !valid_id(archive_id)
                    || project_id.as_ref().is_some_and(|id| !valid_id(id))
                    || profiles.is_empty()
                    || profiles.len() > 33
                    || profiles.iter().any(|p| {
                        !valid_id(&p.task_id)
                            || !valid_id(&p.profile_id)
                            || !seen.insert(&p.task_id)
                    })
                    || matches!(self, Self::TeamRestore { fingerprint, .. } if !task_archive_checksum(fingerprint))
                {
                    return Err(
                        "请为整组任务核对模型配置 / Check model mappings for the entire task group",
                    );
                }
                return Ok(());
            }
            Self::RestorePreview {
                archive_id,
                project_id,
                profile_id,
            }
            | Self::Restore {
                archive_id,
                project_id,
                profile_id,
                ..
            } => {
                if !valid_id(archive_id)
                    || !valid_id(profile_id)
                    || project_id.as_ref().is_some_and(|id| !valid_id(id))
                    || matches!(self, Self::Restore { fingerprint, .. } if !task_archive_checksum(fingerprint))
                {
                    return Err(
                        "恢复选项无效，请重新预览 / Invalid restoration options; preview again",
                    );
                }
                return Ok(());
            }
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
pub struct TaskProfileMapping {
    pub task_id: String,
    pub profile_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct TaskProjectMapping {
    pub source_project_id: Option<String>,
    pub project_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct HistoryRootMapping {
    pub source_root: String,
    pub project_id: String,
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
pub struct TaskArchiveMedia {
    pub entry: MediaTransferEntry,
    pub removed: bool,
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub media: Vec<TaskArchiveMedia>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub file_history: Vec<TaskArchiveHistory>,
    pub excluded_media: u32,
    pub excluded_file_revisions: u32,
}
impl TaskArchiveIndex {
    pub fn validate(&self) -> Result<(), &'static str> {
        if ![1, 2, 3].contains(&self.version)
            || (self.version == 1 && !self.media.is_empty())
            || (self.version < 3 && !self.file_history.is_empty())
            || self.file_history.len() > 128
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
        if !self.media.is_empty() {
            MediaTransferBundle {
                version: 1,
                archive_id: self.archive_id.clone(),
                created_at_ms: self.created_at_ms,
                entries: self.media.iter().map(|m| m.entry.clone()).collect(),
            }
            .validate()?;
            if self.media.iter().any(|m| !tasks.contains(&m.entry.task_id)) {
                return Err("档案附件不属于任务组 / Archive attachment belongs to another task");
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
        let mut media_ids = std::collections::BTreeMap::new();
        for media in &self.media {
            let previous = media_ids.insert(&media.entry.sha256, media.entry.bytes);
            if previous.is_some_and(|n| n != media.entry.bytes) {
                return Err("附件正文大小不一致 / Inconsistent attachment size");
            }
            if previous.is_none() && !ids.contains(&media.entry.sha256) {
                bytes += media.entry.bytes;
            }
            if self
                .objects
                .iter()
                .any(|r| r.object_id == media.entry.sha256 && r.bytes != media.entry.bytes)
            {
                return Err("附件正文大小不一致 / Inconsistent attachment size");
            }
        }
        let mut revisions = HashSet::new();
        let mut changes = HashSet::new();
        let mut history_objects = std::collections::BTreeMap::new();
        for item in &self.file_history {
            item.validate()?;
            let r = &item.revision;
            if !tasks.contains(&r.task_id)
                || !revisions.insert(&r.id)
                || !changes.insert((&r.task_id, &r.operation_id, &r.path))
            {
                return Err("文件历史重复或不属于任务组 / Duplicate or foreign file history");
            }
            for image in [&r.before, &r.after] {
                if let Some(sha) = &image.sha256 {
                    let previous = history_objects.insert(sha, image.bytes);
                    if previous.is_some_and(|n| n != image.bytes)
                        || media_ids.get(sha).is_some_and(|n| *n != image.bytes)
                        || self
                            .objects
                            .iter()
                            .any(|o| o.object_id == *sha && o.bytes != image.bytes)
                    {
                        return Err("历史正文大小不一致 / Inconsistent history image size");
                    }
                    if previous.is_none() && !media_ids.contains_key(sha) && !ids.contains(sha) {
                        bytes += image.bytes;
                    }
                }
            }
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
