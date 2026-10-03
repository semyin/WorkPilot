use crate::*;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct MemoryItem {
    pub id: String,
    pub project_id: Option<String>,
    pub source_task_id: Option<String>,
    pub text: String,
    pub state: MemoryState,
    pub revision: u32,
    pub deleted: bool,
    pub source_label: String,
    pub source_quote: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub confirmed_at_ms: Option<u64>,
    pub change: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum MemoryAction {
    List {
        project_id: Option<String>,
        search: String,
        include_deleted: bool,
        offset: u32,
        limit: u32,
    },
    History {
        memory_id: String,
        before_revision: Option<u32>,
        limit: u32,
    },
    Save {
        memory_id: Option<String>,
        revision: u32,
        project_id: Option<String>,
        text: String,
    },
    Decide {
        memory_id: String,
        revision: u32,
        confirm: bool,
    },
    Delete {
        memory_id: String,
        revision: u32,
    },
    Restore {
        memory_id: String,
        revision: u32,
        target_revision: u32,
    },
    Export {
        project_id: Option<String>,
    },
}
impl MemoryAction {
    pub fn validate(&self) -> Result<(), &'static str> {
        let optional = |id: &Option<String>| id.as_ref().is_none_or(|id| valid_id(id));
        let valid = match self {
            Self::List {
                project_id,
                search,
                offset,
                limit,
                ..
            } => {
                optional(project_id)
                    && search.len() <= 256
                    && *offset <= 4096
                    && (1..=64).contains(limit)
            }
            Self::History {
                memory_id, limit, ..
            } => valid_id(memory_id) && (1..=64).contains(limit),
            Self::Decide { memory_id, .. }
            | Self::Delete { memory_id, .. }
            | Self::Restore { memory_id, .. } => valid_id(memory_id),
            Self::Save {
                memory_id,
                project_id,
                text,
                ..
            } => {
                optional(memory_id)
                    && optional(project_id)
                    && !text.trim().is_empty()
                    && text.len() <= 4096
            }
            Self::Export { project_id } => optional(project_id),
        };
        if valid {
            Ok(())
        } else {
            Err("记忆参数不完整或超过上限 / Invalid memory request")
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MemoryData {
    List {
        items: Vec<MemoryItem>,
        total: u32,
    },
    History {
        items: Vec<MemoryItem>,
        has_more: bool,
    },
    Updated {
        memory_id: String,
    },
    Export {
        content: ContentRef,
        count: u32,
    },
}
