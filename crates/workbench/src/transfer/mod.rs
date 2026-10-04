mod codec;
mod extensions;
mod file_index;
pub(crate) mod files;
mod media;
mod project;
#[cfg(test)]
mod tests;
use crate::{
    history,
    vault::{Result, Vault},
};
use codec::{Image, Manifest, Revision};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::{Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use workpilot_contracts::*;
use workpilot_storage::Storage;
use workpilot_tools::files::Root;

pub(crate) struct Manager {
    storage: Storage,
    data: PathBuf,
    out: tokio::sync::mpsc::Sender<Wire>,
    stop: Arc<AtomicBool>,
    media_owner: Mutex<Option<String>>,
    closing: AtomicBool,
    gate: tokio::sync::Mutex<()>,
}
impl Manager {
    pub fn new(storage: Storage, data: PathBuf, out: tokio::sync::mpsc::Sender<Wire>) -> Self {
        Self {
            storage,
            data,
            out,
            stop: Arc::new(AtomicBool::new(false)),
            media_owner: Mutex::new(None),
            closing: AtomicBool::new(false),
            gate: tokio::sync::Mutex::new(()),
        }
    }
    pub fn cancel_all(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
    pub fn cancel_task(&self, task: &str) {
        if self.media_owner.lock().unwrap().as_deref() == Some(task) {
            self.cancel_all();
        }
    }
    pub fn shutdown(&self) {
        self.closing.store(true, Ordering::SeqCst);
        self.cancel_all();
    }
    async fn scope(&self, task: &str) -> Result<(Root, String)> {
        let id = task.to_owned();
        let policy = self
            .storage
            .call(move |s| s.tool_settings(&id))
            .await
            .map_err(|_| "无法读取任务设置 / Cannot read task settings")?;
        let root = Root::open(
            policy
                .settings
                .root_path
                .as_deref()
                .ok_or("请先绑定项目文件夹 / Bind a project folder first")?,
            policy.root_identity.as_deref(),
        )
        .map_err(|_| "项目文件夹位置已变化或无法访问 / Project folder changed or unavailable")?;
        Ok((root, policy.epoch))
    }
    fn begin(&self) -> Result<tokio::sync::MutexGuard<'_, ()>> {
        let guard = self
            .gate
            .try_lock()
            .map_err(|_| "另一项备份操作仍在进行 / Another transfer is running")?;
        // Reset before the closing check: shutdown must never have its stop
        // signal cleared by a request that checked closing a moment earlier.
        self.stop.store(false, Ordering::SeqCst);
        if self.closing.load(Ordering::SeqCst) {
            return Err("备份操作已取消 / Transfer cancelled".into());
        }
        Ok(guard)
    }
    pub async fn handle(&self, task: String, action: HistoryTransferAction) -> Result<Value> {
        action.validate().map_err(str::to_owned)?;
        let _guard = self.begin()?;
        let (root, epoch) = self.scope(&task).await?;
        match action {
            HistoryTransferAction::Export {
                revision_ids,
                path,
                password,
            } => {
                let identity = root.identity.clone();
                let rows = self
                    .storage
                    .call(move |s| {
                        s.import_managed_revisions(&identity)?;
                        revision_ids
                            .iter()
                            .map(|id| s.file_revision(id, &identity))
                            .collect::<workpilot_storage::Result<Vec<_>>>()
                    })
                    .await
                    .map_err(|_| "无法读取所选历史版本 / Cannot read selected history")?;
                let mut manifest = Manifest {
                    version: 1,
                    archive_id: uuid::Uuid::new_v4().to_string(),
                    created_at_ms: workpilot_storage::now_ms(),
                    revisions: vec![],
                };
                let mut objects = BTreeMap::new();
                for r in rows {
                    for image in [&r.before, &r.after] {
                        if image.version.exists {
                            let sha = image
                                .version
                                .sha256
                                .clone()
                                .ok_or("History checksum missing")?;
                            objects.entry(sha).or_insert_with(|| image.clone());
                        }
                    }
                    let portable = |i: FileImage| Image {
                        exists: i.version.exists,
                        bytes: i.version.bytes,
                        sha256: i.version.sha256,
                    };
                    manifest.revisions.push(Revision {
                        id: r.id,
                        task_id: r.task_id,
                        operation_id: r.operation_id,
                        path: r.path,
                        previous_path: r.previous_path,
                        change: r.change,
                        source: r.source,
                        at_ms: r.at_ms,
                        before: portable(r.before),
                        after: portable(r.after),
                        origin: r.origin,
                    });
                }
                manifest.objects()?;
                let destination = PathBuf::from(&path);
                let parent = destination.parent().ok_or("Invalid destination")?;
                codec::plain(parent, true)?;
                if destination.file_name().is_none() || destination.exists() {
                    return Err(
                        "备份位置已存在，请选择新文件名 / Choose a new archive filename".into(),
                    );
                }
                // No cleartext temporary files. A failed write never replaces an existing file.
                let mut temporary = tempfile::NamedTempFile::new_in(parent)
                    .map_err(|_| "无法创建备份文件 / Cannot create archive")?;
                let vault = Vault::open(&self.data)?;
                // Legacy P04 records live in the older content store. Convert one
                // at a time into the existing encrypted vault before streaming.
                for (sha, image) in &mut objects {
                    if image
                        .blob
                        .as_deref()
                        .is_some_and(|id| id.starts_with("legacy:"))
                    {
                        let bytes = zeroize::Zeroizing::new(
                            history::image_bytes(&self.storage, &vault, image).await?,
                        );
                        if vault.put(&bytes)? != *sha {
                            return Err(
                                "旧文件历史校验失败 / Legacy history checksum mismatch".into()
                            );
                        }
                        image.blob = Some(sha.clone());
                    }
                }
                codec::write(&mut temporary, &password.0, &manifest, &self.stop, |sha| {
                    vault.read(
                        objects
                            .get(sha)
                            .and_then(|image| image.blob.as_deref())
                            .ok_or("Missing history content")?,
                    )
                })?;
                temporary
                    .flush()
                    .and_then(|_| temporary.as_file().sync_all())
                    .map_err(|_| "备份文件未写完整 / Archive write did not finish")?;
                codec::plain(parent, true)?;
                if self.stop.load(Ordering::Relaxed) {
                    return Err("历史备份操作已取消 / History transfer cancelled".into());
                }
                temporary.persist_noclobber(&destination).map_err(
                    |_| "备份位置已被占用或无法保存 / Archive destination changed or unavailable",
                )?;
                Ok(
                    json!({"kind":"exported","path":path,"archive_id":manifest.archive_id,"revisions":manifest.revisions.len(),"bytes":manifest.objects()?.values().sum::<u64>()}),
                )
            }
            HistoryTransferAction::Inspect { path, password } => {
                let mut file = open(&path)?;
                let (manifest, sha) =
                    codec::read(&mut file, &password.0, &self.stop, |_, _| Ok(()))?;
                self.preview(&task, &root, &epoch, &manifest, &sha).await
            }
            HistoryTransferAction::Import {
                path,
                password,
                fingerprint,
            } => {
                let id = task.clone();
                if self
                    .storage
                    .call(move |s| s.task_archived(&id))
                    .await
                    .map_err(|_| "Cannot read task")?
                {
                    return Err("归档任务只能查看，请先取消归档 / Unarchive the task before importing history".into());
                }
                let mut file = open(&path)?;
                let (manifest, sha) =
                    codec::read(&mut file, &password.0, &self.stop, |_, _| Ok(()))?;
                let preview = self.preview(&task, &root, &epoch, &manifest, &sha).await?;
                if preview["fingerprint"].as_str() != Some(&fingerprint) {
                    return Err("备份或目标位置已变化，请重新预览 / Archive or target changed; preview again".into());
                }
                if preview["already_imported"] == true {
                    return Ok(
                        json!({"kind":"imported","duplicate":true,"revisions":manifest.revisions.len()}),
                    );
                }
                let vault = Vault::open(&self.data)?;
                file.seek(SeekFrom::Start(0))
                    .map_err(|_| "Cannot reread archive")?;
                let (_, second_sha) =
                    codec::read(&mut file, &password.0, &self.stop, |sha, bytes| {
                        if vault.put(bytes)? != sha {
                            return Err("History object mismatch".into());
                        }
                        Ok(())
                    })?;
                if sha != second_sha {
                    return Err(
                        "备份在读取期间发生变化，未导入记录 / Archive changed during import".into(),
                    );
                }
                let (fresh_root, fresh_epoch) = self.scope(&task).await?;
                if fresh_root.identity != root.identity || fresh_epoch != epoch {
                    return Err(
                        "项目设置已变化，请重新预览 / Project settings changed; preview again"
                            .into(),
                    );
                }
                if self.stop.load(Ordering::Relaxed) {
                    return Err("历史备份操作已取消 / History transfer cancelled".into());
                }
                let operation = operation_id(&manifest.archive_id, &root.identity);
                let rows = map_revisions(&manifest, &task, &root.identity, &operation);
                let count = rows.len();
                let identity = root.identity;
                let task = task.clone();
                let events = self
                    .storage
                    .call(move |s| {
                        s.import_history_rows(&task, &identity, &epoch, &operation, &sha, &rows)
                    })
                    .await
                    .map_err(|e| e.to_string())?;
                let duplicate = events.is_empty();
                for event in events {
                    let _ = self
                        .out
                        .send(Wire::Event {
                            event: Box::new(event),
                        })
                        .await;
                }
                Ok(json!({"kind":"imported","duplicate":duplicate,"revisions":count}))
            }
        }
    }
    async fn preview(
        &self,
        task: &str,
        root: &Root,
        epoch: &str,
        m: &Manifest,
        sha: &str,
    ) -> Result<Value> {
        let op = operation_id(&m.archive_id, &root.identity);
        let old = self
            .storage
            .call(move |s| s.workbench_operation(&op))
            .await
            .map_err(|_| "Cannot read import history")?;
        if old
            .as_ref()
            .is_some_and(|o| o.kind != "history_import" || o.fingerprint != sha)
        {
            return Err("同一备份编号已有不同内容，未覆盖 / Archive identity conflicts with a previous import".into());
        }
        let mut paths = BTreeMap::new();
        for r in &m.revisions {
            if !paths.contains_key(&r.path) {
                let state = match root.binary_snapshot(&r.path) {
                    Ok(file) => {
                        if file.version.exists {
                            "exists"
                        } else {
                            "missing"
                        }
                    }
                    Err(_) => "unavailable",
                };
                paths.insert(r.path.clone(), state);
            }
        }
        let fingerprint = codec::digest(
            serde_json::to_string(&json!([sha, task, root.identity, epoch]))
                .map_err(|_| "Cannot encode preview")?
                .as_bytes(),
        );
        Ok(
            json!({"kind":"preview","archive_id":m.archive_id,"created_at_ms":m.created_at_ms,"revisions":m.revisions.len(),"bytes":m.objects()?.values().sum::<u64>(),"fingerprint":fingerprint,"already_imported":old.is_some(),"paths":paths.into_iter().map(|(path,state)|json!({"path":path,"current":state})).collect::<Vec<_>>() }),
        )
    }
}
fn open(path: &str) -> Result<fs::File> {
    codec::plain(Path::new(path), false)?;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1);
    }
    options
        .open(path)
        .map_err(|_| "无法读取备份文件 / Cannot read archive".into())
}
fn operation_id(archive: &str, root: &str) -> String {
    format!(
        "history-import:{}",
        codec::digest(format!("{archive}\0{root}").as_bytes())
    )
}
fn map_revisions(m: &Manifest, task: &str, root: &str, op: &str) -> Vec<FileRevision> {
    let image = |i: &Image| FileImage {
        version: FileVersion {
            exists: i.exists,
            bytes: i.bytes,
            sha256: i.sha256.clone(),
            identity: None,
        },
        blob: i.sha256.clone(),
    };
    m.revisions
        .iter()
        .map(|r| FileRevision {
            id: uuid::Uuid::new_v4().to_string(),
            operation_id: op.into(),
            task_id: task.into(),
            root_identity: root.into(),
            path: r.path.clone(),
            previous_path: r.previous_path.clone(),
            change: r.change.clone(),
            source: "history_import".into(),
            at_ms: r.at_ms,
            before: image(&r.before),
            after: image(&r.after),
            origin: r.origin.clone().or_else(|| {
                Some(FileRevisionOrigin {
                    archive_id: m.archive_id.clone(),
                    revision_id: r.id.clone(),
                    task_id: r.task_id.clone(),
                    operation_id: r.operation_id.clone(),
                    source: r.source.clone(),
                })
            }),
        })
        .collect()
}
