use crate::{HistoryTransferAction, SecretInput, valid_id};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum MediaTransferAction {
    Export {
        asset_ids: Vec<String>,
        path: String,
        password: SecretInput,
    },
    Inspect {
        path: String,
        password: SecretInput,
        name_prefix: String,
    },
    Import {
        path: String,
        password: SecretInput,
        name_prefix: String,
        fingerprint: String,
    },
    Cancel,
}
impl MediaTransferAction {
    pub fn validate(&self) -> Result<(), &'static str> {
        let (path, password) = match self {
            Self::Cancel => return Ok(()),
            Self::Export {
                asset_ids,
                path,
                password,
            } => {
                let unique: std::collections::HashSet<_> = asset_ids.iter().collect();
                if asset_ids.is_empty()
                    || asset_ids.len() > 64
                    || unique.len() != asset_ids.len()
                    || asset_ids.iter().any(|id| !valid_id(id))
                {
                    return Err("请选择 1–64 个不同的附件 / Select 1–64 distinct attachments");
                }
                (path, password)
            }
            Self::Inspect {
                path,
                password,
                name_prefix,
            }
            | Self::Import {
                path,
                password,
                name_prefix,
                ..
            } => {
                if name_prefix.len() > 100
                    || name_prefix
                        .chars()
                        .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
                {
                    return Err("invalid attachment name prefix");
                }
                (path, password)
            }
        };
        HistoryTransferAction::Inspect {
            path: path.clone(),
            password: password.clone(),
        }
        .validate()?;
        if let Self::Import { fingerprint, .. } = self
            && !checksum(fingerprint)
        {
            return Err("invalid attachment preview");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct MediaAssetOrigin {
    pub archive_id: String,
    pub asset_id: String,
    pub task_id: String,
    pub name: String,
    pub source: String,
    pub at_ms: u64,
    pub path: Option<String>,
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MediaTransferEntry {
    pub id: String,
    pub task_id: String,
    pub name: String,
    pub source: String,
    pub at_ms: u64,
    pub bytes: u64,
    pub sha256: String,
    pub path: Option<String>,
    pub operation_id: Option<String>,
    pub origin: Option<MediaAssetOrigin>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MediaTransferBundle {
    pub version: u32,
    pub archive_id: String,
    pub created_at_ms: u64,
    pub entries: Vec<MediaTransferEntry>,
}
pub fn checksum(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn media_transfer_name(name: &str) -> bool {
    !name.trim().is_empty()
        && name.len() <= 255
        && !name
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
}
fn origin_valid(o: &MediaAssetOrigin) -> bool {
    valid_id(&o.archive_id)
        && valid_id(&o.asset_id)
        && valid_id(&o.task_id)
        && media_transfer_name(&o.name)
        && o.source.len() <= 128
        && !o.source.chars().any(char::is_control)
        && o.path
            .as_ref()
            .is_none_or(|p| p.len() <= 4096 && !p.chars().any(char::is_control))
        && o.operation_id.as_ref().is_none_or(|id| valid_id(id))
}
impl MediaTransferBundle {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.version != 1
            || !valid_id(&self.archive_id)
            || self.entries.is_empty()
            || self.entries.len() > 64
        {
            return Err("附件备份版本或数量无效 / Invalid attachment archive");
        }
        let mut seen = std::collections::HashSet::new();
        let mut total = 0u64;
        for entry in &self.entries {
            let origin = self.origin(entry);
            if !seen.insert(&entry.id)
                || !origin_valid(&origin)
                || !valid_id(&entry.id)
                || !valid_id(&entry.task_id)
                || !media_transfer_name(&entry.name)
                || !checksum(&entry.sha256)
                || entry.bytes > 32 * 1024 * 1024
                || entry.source.len() > 128
                || entry.source.chars().any(char::is_control)
                || entry
                    .path
                    .as_ref()
                    .is_some_and(|p| p.len() > 4096 || p.chars().any(char::is_control))
                || entry.operation_id.as_ref().is_some_and(|id| !valid_id(id))
            {
                return Err("附件备份内容或大小无效 / Invalid attachment metadata or size");
            }
            total += entry.bytes;
        }
        if total > 256 * 1024 * 1024 {
            return Err("附件总量超过 256 MiB / Attachment archive exceeds 256 MiB");
        }
        Ok(())
    }
    pub fn origin(&self, entry: &MediaTransferEntry) -> MediaAssetOrigin {
        entry.origin.clone().unwrap_or_else(|| MediaAssetOrigin {
            archive_id: self.archive_id.clone(),
            asset_id: entry.id.clone(),
            task_id: entry.task_id.clone(),
            name: entry.name.clone(),
            source: entry.source.clone(),
            at_ms: entry.at_ms,
            path: entry.path.clone(),
            operation_id: entry.operation_id.clone(),
        })
    }
}
