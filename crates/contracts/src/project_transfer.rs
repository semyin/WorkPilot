use crate::*;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
mod memory_history;
pub use memory_history::ProjectMemoryHistory;

/// Manual settings migration, separate from model tools and saved command inputs.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProjectTransferAction {
    Export {
        project_id: String,
        profile_ids: Vec<String>,
        memory_ids: Vec<String>,
        #[serde(default)]
        include_memory_history: bool,
        path: String,
        password: SecretInput,
    },
    Inspect {
        path: String,
        password: SecretInput,
        root_path: String,
        name: String,
    },
    Import {
        path: String,
        password: SecretInput,
        root_path: String,
        name: String,
        fingerprint: String,
    },
}
impl ProjectTransferAction {
    pub fn validate(&self) -> Result<(), &'static str> {
        let (path, password) = match self {
            Self::Export {
                project_id,
                profile_ids,
                memory_ids,
                path,
                password,
                ..
            } => {
                if !valid_id(project_id) || !selection(profile_ids) || !selection(memory_ids) {
                    return Err("迁移选择无效或超过 128 项 / Invalid migration selection");
                }
                (path, password)
            }
            Self::Inspect {
                path,
                password,
                root_path,
                name,
            }
            | Self::Import {
                path,
                password,
                root_path,
                name,
                ..
            } => {
                if root_path.is_empty()
                    || root_path.len() > 4096
                    || root_path.contains('\0')
                    || name.trim().is_empty()
                    || name.len() > 256
                    || name.chars().any(char::is_control)
                {
                    return Err(
                        "请填写新项目名称和目标文件夹 / Provide a new project name and folder",
                    );
                }
                (path, password)
            }
        };
        if let Self::Import { fingerprint, .. } = self
            && (fingerprint.len() != 64 || !fingerprint.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Err("请重新预览迁移包 / Preview the archive again");
        }
        HistoryTransferAction::Inspect {
            path: path.clone(),
            password: password.clone(),
        }
        .validate()
    }
}
fn selection(ids: &[String]) -> bool {
    ids.len() <= 128
        && ids.iter().all(|s| valid_id(s))
        && ids.iter().collect::<std::collections::HashSet<_>>().len() == ids.len()
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectTransferBundle {
    pub version: u32,
    pub archive_id: String,
    pub created_at_ms: u64,
    pub project: WorkspaceProject,
    pub profiles: Vec<ProviderProfile>,
    pub memories: Vec<MemoryItem>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub memory_history: Vec<ProjectMemoryHistory>,
}
impl ProjectTransferBundle {
    pub fn validate(&self) -> Result<(), &'static str> {
        if ![1, 2].contains(&self.version)
            || !valid_id(&self.archive_id)
            || !valid_id(&self.project.id)
        {
            return Err("不支持的项目设置包 / Unsupported project settings archive");
        }
        WorkspaceAction::SaveProject {
            project_id: None,
            settings: self.project.settings.clone(),
        }
        .validate()?;
        if !selection(
            &self
                .profiles
                .iter()
                .map(|p| p.id.clone())
                .collect::<Vec<_>>(),
        ) || self.profiles.iter().any(|p| p.credential.is_some())
            || !selection(
                &self
                    .memories
                    .iter()
                    .map(|m| m.id.clone())
                    .collect::<Vec<_>>(),
            )
            || self.memories.iter().any(|m| {
                (self.version == 1 && (m.deleted || m.state != MemoryState::Confirmed))
                    || m.text.trim().is_empty()
                    || m.text.len() > 4096
                    || m.source_label.len() > 4096
                    || m.source_quote.len() > 4096
                    || m.revision == 0
                    || m.project_id
                        .as_ref()
                        .is_some_and(|id| id != &self.project.id)
                    || m.source_task_id.as_ref().is_some_and(|id| !valid_id(id))
            })
        {
            return Err(
                "设置包包含无效记忆、越界来源或凭据 / Invalid memories, scope or credentials",
            );
        }
        if self
            .project
            .settings
            .default_profile_id
            .as_ref()
            .is_some_and(|id| !self.profiles.iter().any(|p| &p.id == id))
        {
            return Err("缺少所选默认模型 / Missing selected default model");
        }
        self.validate_memory_history()?;
        Ok(())
    }
}
