use crate::{SecretInput, valid_id};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Manual desktop management only. Passwords must never enter events or saved commands.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum HistoryTransferAction {
    Export {
        revision_ids: Vec<String>,
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
impl HistoryTransferAction {
    pub fn validate(&self) -> Result<(), &'static str> {
        let (path, password) = match self {
            Self::Export {
                revision_ids,
                path,
                password,
            } => {
                let unique: std::collections::HashSet<_> = revision_ids.iter().collect();
                if revision_ids.is_empty()
                    || revision_ids.len() > 128
                    || unique.len() != revision_ids.len()
                    || revision_ids.iter().any(|id| !valid_id(id))
                {
                    return Err("select 1–128 distinct file revisions");
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
                    return Err("invalid import preview");
                }
                (path, password)
            }
        };
        if path.is_empty() || path.len() > 4096 || path.contains('\0') {
            return Err("invalid archive path");
        }
        if password.0.chars().count() < 12
            || password.0.len() > 1024
            || password.0.chars().any(char::is_control)
        {
            return Err(
                "备份口令需要至少 12 个字符，最多 1024 字节 / Use a backup passphrase of at least 12 characters",
            );
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct FileRevisionOrigin {
    pub archive_id: String,
    pub revision_id: String,
    pub task_id: String,
    pub operation_id: String,
    pub source: String,
}
