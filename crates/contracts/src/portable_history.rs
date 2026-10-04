//! Portable file versions contain bytes and provenance, never local vault keys or live handles.
use crate::*;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct PortableFileImage {
    pub exists: bool,
    pub bytes: u64,
    pub sha256: Option<String>,
}
impl PortableFileImage {
    pub fn from_image(image: &FileImage) -> Self {
        Self {
            exists: image.version.exists,
            bytes: image.version.bytes,
            sha256: image.version.sha256.clone(),
        }
    }
    pub fn local_image(&self) -> FileImage {
        FileImage {
            version: FileVersion {
                exists: self.exists,
                bytes: self.bytes,
                sha256: self.sha256.clone(),
                identity: None,
            },
            blob: self.sha256.clone(),
        }
    }
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.exists {
            if self.bytes > 64 * 1024 * 1024
                || self
                    .sha256
                    .as_ref()
                    .is_none_or(|s| !task_archive_checksum(s))
            {
                return Err("历史版本大小或摘要无效 / Invalid history image size or checksum");
            }
        } else if self.bytes != 0 || self.sha256.is_some() {
            return Err("不存在的历史版本含有正文 / Absent history image contains data");
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct PortableFileRevision {
    pub id: String,
    pub task_id: String,
    pub operation_id: String,
    pub path: String,
    pub previous_path: Option<String>,
    pub change: String,
    pub source: String,
    pub at_ms: u64,
    pub before: PortableFileImage,
    pub after: PortableFileImage,
    pub origin: Option<FileRevisionOrigin>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct TaskArchiveHistory {
    pub root_identity: String,
    pub revision: PortableFileRevision,
}
impl TaskArchiveHistory {
    pub fn from_revision(r: &FileRevision) -> Self {
        Self {
            root_identity: r.root_identity.clone(),
            revision: PortableFileRevision {
                id: r.id.clone(),
                task_id: r.task_id.clone(),
                operation_id: r.operation_id.clone(),
                path: r.path.replace('\\', "/"),
                previous_path: r.previous_path.as_ref().map(|p| p.replace('\\', "/")),
                change: r.change.clone(),
                source: r.source.clone(),
                at_ms: r.at_ms,
                before: PortableFileImage::from_image(&r.before),
                after: PortableFileImage::from_image(&r.after),
                origin: r.origin.clone(),
            },
        }
    }
    pub fn validate(&self) -> Result<(), &'static str> {
        let r = &self.revision;
        if self.root_identity.is_empty()
            || self.root_identity.len() > 4096
            || self.root_identity.chars().any(char::is_control)
            || !valid_id(&r.id)
            || !valid_id(&r.task_id)
            || !valid_id(&r.operation_id)
            || r.source.len() > 256
            || r.source.chars().any(char::is_control)
            || !["created", "modified", "deleted", "renamed"].contains(&r.change.as_str())
            || !history_path(&r.path)
            || r.previous_path.as_ref().is_some_and(|p| !history_path(p))
            || r.origin.as_ref().is_some_and(|o| {
                ![&o.archive_id, &o.revision_id, &o.task_id, &o.operation_id]
                    .iter()
                    .all(|s| valid_id(s))
                    || o.source.len() > 256
                    || o.source.chars().any(char::is_control)
            })
        {
            return Err("任务文件历史索引无效 / Invalid task file history index");
        }
        r.before.validate()?;
        r.after.validate()
    }
}
fn history_path(path: &str) -> bool {
    if path.is_empty()
        || path.len() > 4096
        || path
            .chars()
            .any(|c| c.is_control() || c == ':' || c == '\\')
    {
        return false;
    }
    path.split('/').all(|part| {
        let device = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        !part.is_empty()
            && ![".", "..", ".git"].contains(&part.to_ascii_lowercase().as_str())
            && !part.ends_with([' ', '.'])
            && !["CON", "PRN", "AUX", "NUL"].contains(&device.as_str())
            && !(device.len() == 4
                && (device.starts_with("COM") || device.starts_with("LPT"))
                && device.as_bytes()[3].is_ascii_digit())
    })
}
