use crate::{HistoryTransferAction, SecretInput};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Manual archive commands bypass the saved-command log so passwords are never persisted.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FileTransferAction {
    Export {
        paths: Vec<String>,
        path: String,
        password: SecretInput,
    },
    Inspect {
        path: String,
        password: SecretInput,
        prefix: String,
    },
    Import {
        path: String,
        password: SecretInput,
        prefix: String,
        fingerprint: String,
    },
}
impl FileTransferAction {
    pub fn validate(&self) -> Result<(), &'static str> {
        let (path, password) = match self {
            Self::Export {
                paths,
                path,
                password,
            } => {
                if paths.is_empty()
                    || paths.len() > 128
                    || paths.iter().any(|p| p.is_empty() || p.len() > 4096)
                {
                    return Err("请选择 1–128 个文件 / Select 1–128 files");
                }
                (path, password)
            }
            Self::Inspect {
                path,
                password,
                prefix,
            }
            | Self::Import {
                path,
                password,
                prefix,
                ..
            } => {
                if prefix.len() > 4096 || prefix.contains('\0') {
                    return Err("invalid destination prefix");
                }
                (path, password)
            }
        };
        // Keep all transfer passphrase/path bounds identical.
        HistoryTransferAction::Inspect {
            path: path.clone(),
            password: password.clone(),
        }
        .validate()?;
        if let Self::Import { fingerprint, .. } = self
            && (fingerprint.len() != 64 || !fingerprint.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Err("invalid import preview");
        }
        Ok(())
    }
}
