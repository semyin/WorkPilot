use crate::{HistoryTransferAction, PluginVersion, SecretInput, valid_id};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ExtensionSelection {
    pub installation_id: String,
    pub revision: u32,
}

/// Desktop management only; passphrases never enter saved task commands.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ExtensionTransferAction {
    Export {
        selections: Vec<ExtensionSelection>,
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
}
impl ExtensionTransferAction {
    pub fn validate(&self) -> Result<(), &'static str> {
        let (path, password) = match self {
            Self::Export {
                selections,
                path,
                password,
            } => {
                let ids: std::collections::HashSet<_> =
                    selections.iter().map(|s| &s.installation_id).collect();
                if selections.is_empty()
                    || selections.len() > 32
                    || ids.len() != selections.len()
                    || selections
                        .iter()
                        .any(|s| !valid_id(&s.installation_id) || s.revision == 0)
                {
                    return Err("请选择 1–32 个不同扩展 / Select 1–32 distinct extensions");
                }
                (path, password)
            }
            Self::Inspect { path, password } => (path, password),
            Self::Import {
                path,
                password,
                fingerprint,
            } => {
                if fingerprint.len() != 64 || !fingerprint.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err("请重新预览扩展备份 / Preview the extension archive again");
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

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExtensionArchiveFile {
    pub path: String,
    pub base64: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PortableExtension {
    pub source_id: String,
    pub project_scoped: bool,
    pub was_enabled: bool,
    pub digest: String,
    pub files: Vec<ExtensionArchiveFile>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExtensionTransferBundle {
    pub version: u32,
    pub archive_id: String,
    pub created_at_ms: u64,
    pub entries: Vec<PortableExtension>,
}

/// Validated package metadata passed internally to the atomic storage operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionImportCandidate {
    pub source_id: String,
    pub scope: Option<String>,
    pub version: PluginVersion,
}
