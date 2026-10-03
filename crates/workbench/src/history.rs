use crate::vault::{Result, Vault};
use std::{collections::BTreeMap, path::Path, sync::Arc};
use workpilot_contracts::*;
use workpilot_storage::Storage;
use workpilot_tools::{
    binary::{MAX_TREE_BYTES, absent},
    files::Root,
};
pub type Images = BTreeMap<String, FileImage>;
pub fn capture(root: &Root, vault: &Vault, paths: Option<&[String]>) -> Result<Images> {
    let paths = match paths {
        Some(p) => p.to_vec(),
        None => root.tracked_paths().map_err(|e| e.to_string())?,
    };
    let mut total = 0;
    let mut images = Images::new();
    for path in paths {
        let file = root.binary_snapshot(&path).map_err(|e| e.to_string())?;
        total += file.version.bytes;
        if total > MAX_TREE_BYTES {
            return Err("项目超过 256 MiB 版本记录上限，操作未启动。".into());
        }
        let blob = if file.version.exists {
            Some(vault.put(&file.bytes)?)
        } else {
            None
        };
        images.insert(
            path,
            FileImage {
                version: file.version,
                blob,
            },
        );
    }
    Ok(images)
}
pub fn differences(
    operation: &str,
    task: &str,
    root: &str,
    source: &str,
    before: &Images,
    after: &Images,
) -> Vec<FileRevision> {
    let mut paths: Vec<_> = before.keys().chain(after.keys()).cloned().collect();
    paths.sort();
    paths.dedup();
    let missing = FileImage {
        version: absent(),
        blob: None,
    };
    let deleted: Vec<_> = before
        .iter()
        .filter(|(p, _)| !after.get(*p).is_some_and(|i| i.version.exists))
        .collect();
    paths
        .into_iter()
        .filter_map(|path| {
            let old = before.get(&path).unwrap_or(&missing);
            let new = after.get(&path).unwrap_or(&missing);
            if old.version.exists == new.version.exists && old.version.sha256 == new.version.sha256
            {
                return None;
            }
            let previous_path = if !old.version.exists && new.version.exists {
                let candidates: Vec<_> = deleted
                    .iter()
                    .filter(|(_, image)| {
                        image.version.identity == new.version.identity
                            && image.version.sha256 == new.version.sha256
                    })
                    .collect();
                if candidates.len() == 1 {
                    Some(candidates[0].0.clone())
                } else {
                    None
                }
            } else {
                None
            };
            Some(FileRevision {
                id: uuid::Uuid::new_v4().to_string(),
                operation_id: operation.into(),
                task_id: task.into(),
                root_identity: root.into(),
                path,
                change: if previous_path.is_some() {
                    "renamed"
                } else if !new.version.exists {
                    "deleted"
                } else if !old.version.exists {
                    "created"
                } else {
                    "modified"
                }
                .into(),
                previous_path,
                source: source.into(),
                at_ms: workpilot_storage::now_ms(),
                before: old.clone(),
                after: new.clone(),
            })
        })
        .collect()
}
pub struct Capture {
    pub before: Images,
    pub vault: Arc<Vault>,
    pub operation: String,
    pub task: String,
    pub source: String,
    pub paths: Option<Vec<String>>,
}
impl Capture {
    pub async fn begin(
        storage: &Storage,
        data: &Path,
        root: &Root,
        operation: &str,
        task: &str,
        source: &str,
        paths: Option<Vec<String>>,
    ) -> Result<Self> {
        let (directory, root_path, root_identity, selected) = (
            data.to_path_buf(),
            root.path.to_string_lossy().into_owned(),
            root.identity.clone(),
            paths.clone(),
        );
        let (vault, before) = tokio::task::spawn_blocking(move || {
            let vault = Vault::open(&directory)?;
            let root = Root::open(&root_path, Some(&root_identity)).map_err(|e| e.to_string())?;
            let before = capture(&root, &vault, selected.as_deref())?;
            Ok::<_, String>((vault, before))
        })
        .await
        .map_err(|e| e.to_string())??;
        let (op, t, p, identity, src, images) = (
            operation.to_owned(),
            task.to_owned(),
            root.path.to_string_lossy().into_owned(),
            root.identity.clone(),
            source.to_owned(),
            serde_json::json!({"images":before,"paths":paths}),
        );
        storage
            .call(move |s| s.begin_file_capture(&op, &t, &p, &identity, &src, &images))
            .await
            .map_err(|e| e.to_string())?;
        Ok(Self {
            before,
            vault,
            operation: operation.into(),
            task: task.into(),
            source: source.into(),
            paths,
        })
    }
    pub async fn finish(self, storage: &Storage, root: &Root) -> Result<Vec<Event>> {
        let (path, identity, vault, selected) = (
            root.path.to_string_lossy().into_owned(),
            root.identity.clone(),
            self.vault.clone(),
            self.paths.clone(),
        );
        let after = tokio::task::spawn_blocking(move || {
            let root = Root::open(&path, Some(&identity)).map_err(|e| e.to_string())?;
            capture(&root, &vault, selected.as_deref())
        })
        .await
        .map_err(|e| e.to_string())??;
        let revisions = differences(
            &self.operation,
            &self.task,
            &root.identity,
            &self.source,
            &self.before,
            &after,
        );
        let op = self.operation;
        storage
            .call(move |s| s.finish_file_capture(&op, &revisions))
            .await
            .map_err(|e| e.to_string())
    }
}
pub async fn image_bytes(storage: &Storage, vault: &Vault, image: &FileImage) -> Result<Vec<u8>> {
    let Some(id) = &image.blob else {
        if image.version.exists {
            return Err("version content unavailable".into());
        }
        return Ok(vec![]);
    };
    if let Some(object) = id.strip_prefix("legacy:") {
        let id = object.to_owned();
        storage
            .call(move |s| s.legacy_file_bytes(&id))
            .await
            .map_err(|e| e.to_string())
    } else {
        vault.read(id)
    }
}
