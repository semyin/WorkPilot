use crate::*;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ProjectSettings {
    pub name: String,
    pub root_path: String,
    pub default_profile_id: Option<String>,
    pub permission: PermissionMode,
    pub rules: String,
    pub revision: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct WorkspaceProject {
    pub id: String,
    pub settings: ProjectSettings,
    pub created_at_ms: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(default, deny_unknown_fields)]
pub struct WorkspacePreferences {
    pub language: String,
    pub theme: String,
    pub sidebar_width: u32,
    pub inspector_width: u32,
    pub sidebar_closed: bool,
    pub inspector_closed: bool,
    pub revision: u32,
}
impl Default for WorkspacePreferences {
    fn default() -> Self {
        Self {
            language: "zh".into(),
            theme: "system".into(),
            sidebar_width: 250,
            inspector_width: 380,
            sidebar_closed: false,
            inspector_closed: false,
            revision: 0,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum WorkspaceAction {
    SaveProject {
        project_id: Option<String>,
        settings: ProjectSettings,
    },
    ArchiveTask {
        task_id: String,
        archived: bool,
    },
    RenameTask {
        task_id: String,
        title: String,
    },
    EditMessage {
        task_id: String,
        message_id: String,
        expected_object_id: String,
        text: String,
    },
    CancelMessage {
        task_id: String,
        message_id: String,
        expected_object_id: String,
    },
    SavePreferences {
        preferences: WorkspacePreferences,
    },
    ExportRecords {
        task_id: String,
    },
}
impl WorkspaceAction {
    pub fn validate(&self) -> Result<(), &'static str> {
        match self {
            Self::SaveProject {
                project_id,
                settings: s,
            } => {
                if project_id.as_ref().is_some_and(|v| !valid_id(v))
                    || s.name.trim().is_empty()
                    || s.name.len() > 256
                    || s.root_path.is_empty()
                    || s.root_path.len() > 4096
                    || s.rules.len() > 8192
                    || s.default_profile_id.as_ref().is_some_and(|v| !valid_id(v))
                {
                    return Err("invalid project settings");
                }
            }
            Self::ArchiveTask { task_id, .. } | Self::ExportRecords { task_id } => {
                if !valid_id(task_id) {
                    return Err("invalid task");
                }
            }
            Self::RenameTask { task_id, title } => {
                if !valid_id(task_id) || title.trim().is_empty() || title.len() > 512 {
                    return Err("invalid title");
                }
            }
            Self::EditMessage {
                task_id,
                message_id,
                expected_object_id,
                text,
            } => {
                if !valid_id(task_id)
                    || !valid_id(message_id)
                    || expected_object_id.len() != 64
                    || text.trim().is_empty()
                    || text.len() > 16384
                {
                    return Err("invalid queued message");
                }
            }
            Self::CancelMessage {
                task_id,
                message_id,
                expected_object_id,
            } => {
                if !valid_id(task_id) || !valid_id(message_id) || expected_object_id.len() != 64 {
                    return Err("invalid queued message");
                }
            }
            Self::SavePreferences { preferences: p } => {
                if !["zh", "en"].contains(&p.language.as_str())
                    || !["light", "dark", "system"].contains(&p.theme.as_str())
                    || !(190..=400).contains(&p.sidebar_width)
                    || !(280..=700).contains(&p.inspector_width)
                {
                    return Err("invalid workspace preferences");
                }
            }
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum WorkspaceQuery {
    Overview,
    Tasks {
        project_id: Option<String>,
        archived: bool,
        search: String,
        before: Option<String>,
        limit: u32,
    },
    Detail {
        task_id: String,
    },
    Conversation {
        task_id: String,
        before: Option<u64>,
        limit: u32,
    },
    Artifacts {
        task_id: String,
    },
    SearchRecords {
        task_id: String,
        text: String,
        after: u64,
        limit: u32,
    },
}
impl WorkspaceQuery {
    pub fn validate(&self) -> Result<(), &'static str> {
        match self {
            Self::Overview => {}
            Self::Tasks {
                project_id,
                search,
                before,
                limit,
                ..
            } => {
                if project_id.as_ref().is_some_and(|v| !valid_id(v))
                    || search.len() > 512
                    || before.as_ref().is_some_and(|v| !valid_id(v))
                    || !(1..=128).contains(limit)
                {
                    return Err("invalid task filter");
                }
            }
            Self::Detail { task_id } | Self::Artifacts { task_id } => {
                if !valid_id(task_id) {
                    return Err("invalid task");
                }
            }
            Self::Conversation {
                task_id,
                before,
                limit,
            } => {
                if !valid_id(task_id)
                    || before.is_some_and(|v| v > MAX_SAFE_SEQUENCE)
                    || !(1..=24).contains(limit)
                {
                    return Err("invalid conversation page");
                }
            }
            Self::SearchRecords {
                task_id,
                text,
                after,
                limit,
            } => {
                if !valid_id(task_id)
                    || text.trim().is_empty()
                    || text.len() > 512
                    || *after > MAX_SAFE_SEQUENCE
                    || !(1..=64).contains(limit)
                {
                    return Err("invalid record search");
                }
            }
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ConversationEntry {
    pub sequence: u64,
    pub role: String,
    pub at_ms: u64,
    pub text: String,
    pub truncated: bool,
    pub source: ContentRef,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct WorkspaceArtifact {
    pub id: String,
    pub task_id: String,
    pub title: String,
    pub path: String,
    pub revision_id: String,
    pub content: ContentRef,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct WorkspaceNotice {
    pub task_id: String,
    pub root_task_id: String,
    pub title: String,
    pub state: TaskState,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkspaceData {
    Overview {
        projects: Vec<WorkspaceProject>,
        preferences: WorkspacePreferences,
        scheduler: SchedulerSettings,
        data_dir: String,
        notices: Vec<WorkspaceNotice>,
    },
    ProjectSaved {
        project: WorkspaceProject,
    },
    Tasks {
        tasks: Vec<Task>,
        next_before: Option<String>,
    },
    Detail {
        snapshot: Box<ExecutionSnapshot>,
        archived: bool,
        effective_profile: Option<Box<ProviderProfile>>,
        effective_permission: PermissionMode,
        live_text: String,
        live_reasoning: String,
    },
    Conversation {
        entries: Vec<ConversationEntry>,
        next_before: Option<u64>,
    },
    Artifacts {
        artifacts: Vec<WorkspaceArtifact>,
    },
    SearchRecords {
        events: Vec<Event>,
        next_after: u64,
        has_more: bool,
    },
    Exported {
        path: String,
        events: u64,
        objects: u64,
    },
    Updated,
}
