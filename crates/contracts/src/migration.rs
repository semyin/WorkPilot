//! A manual, selective workspace transfer. Credentials never enter persisted commands.
use crate::*;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct MigrationSelection {
    pub project_id: String,
    pub profile_ids: Vec<String>,
    pub memory_ids: Vec<String>,
    pub task_ids: Vec<String>,
    pub files: Vec<String>,
    pub extensions: Vec<ExtensionSelection>,
    pub draft_ids: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct MigrationDestination {
    pub source_project_id: String,
    pub name: String,
    pub root_path: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct MigrationHistoryMapping {
    pub source_root: String,
    pub source_project_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum MigrationAction {
    Cancel,
    Catalog,
    Export {
        selections: Vec<MigrationSelection>,
        path: String,
        password: SecretInput,
    },
    Inspect {
        path: String,
        password: SecretInput,
    },
    Preview {
        path: String,
        password: SecretInput,
        destinations: Vec<MigrationDestination>,
        history_roots: Vec<MigrationHistoryMapping>,
    },
    Import {
        path: String,
        password: SecretInput,
        destinations: Vec<MigrationDestination>,
        history_roots: Vec<MigrationHistoryMapping>,
        fingerprint: String,
    },
    Status {
        archive_id: String,
    },
    PrepareFiles {
        archive_id: String,
        source_project_id: String,
    },
}
impl MigrationAction {
    pub fn validate(&self) -> Result<(), &'static str> {
        let (path, password) = match self {
            Self::Catalog | Self::Cancel => return Ok(()),
            Self::Status { archive_id } | Self::PrepareFiles { archive_id, .. } => {
                return valid_id(archive_id)
                    .then_some(())
                    .ok_or("Invalid migration");
            }
            Self::Export {
                selections,
                path,
                password,
            } => {
                let ids = |v: &Vec<String>| {
                    v.len() <= 128
                        && v.iter().all(|s| valid_id(s))
                        && v.iter().collect::<std::collections::HashSet<_>>().len() == v.len()
                };
                if selections.is_empty()
                    || selections.len() > 16
                    || selections
                        .iter()
                        .map(|s| &s.project_id)
                        .collect::<std::collections::HashSet<_>>()
                        .len()
                        != selections.len()
                    || selections.iter().any(|s| {
                        !valid_id(&s.project_id)
                            || !ids(&s.profile_ids)
                            || !ids(&s.memory_ids)
                            || !ids(&s.task_ids)
                            || !ids(&s.draft_ids)
                            || s.task_ids.len() > 16
                            || s.files.len() > 128
                            || s.extensions.len() > 32
                            || s.files.iter().any(|p| p.is_empty() || p.len() > 4096)
                    })
                {
                    return Err(
                        "选择超出迁移容量或含重复项 / Invalid or oversized migration selection",
                    );
                }
                (path, password)
            }
            Self::Inspect { path, password } => (path, password),
            Self::Preview {
                path,
                password,
                destinations,
                history_roots,
            }
            | Self::Import {
                path,
                password,
                destinations,
                history_roots,
                ..
            } => {
                if destinations.is_empty()
                    || destinations.len() > 16
                    || destinations.iter().any(|d| {
                        !valid_id(&d.source_project_id)
                            || d.name.trim().is_empty()
                            || d.name.len() > 256
                            || d.root_path.is_empty()
                            || d.root_path.len() > 4096
                            || d.root_path.contains('\0')
                    })
                    || history_roots.len() > 128
                    || history_roots
                        .iter()
                        .any(|h| !valid_id(&h.source_project_id) || h.source_root.len() > 4096)
                    || matches!(self,Self::Import {fingerprint,..} if !task_archive_checksum(fingerprint))
                {
                    return Err("请核对项目和文件夹映射 / Check project and folder mappings");
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
