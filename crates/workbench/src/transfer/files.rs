//! Staging is encrypted; actual project writes go through the ordinary operation/approval path.
use super::{
    codec::ArchiveIndex,
    file_index::{Entry, FileIndex, ImportPlan},
    *,
};
use zeroize::Zeroizing;

pub(crate) enum FileReply {
    Data(Value),
    Ready {
        id: String,
        task: String,
        action: Box<WorkbenchAction>,
    },
}

impl Manager {
    pub(super) async fn file_content_allowed(&self, bytes: &[u8]) -> Result<()> {
        let text = Zeroizing::new(String::from_utf8_lossy(bytes).into_owned());
        self.storage
            .call(move |s| s.extension_content_allowed(&text))
            .await
            .map_err(|_| {
                "文件包含已配置的凭据，未迁移 / File contains a configured credential".into()
            })
    }
    async fn file_scope_unchanged(&self, task: &str, identity: &str, epoch: &str) -> Result<()> {
        if self.stop.load(Ordering::SeqCst) {
            return Err("文件迁移已取消 / File transfer cancelled".into());
        }
        let (root, fresh) = self.scope(task).await?;
        if root.identity != identity || fresh != epoch {
            return Err(
                "项目或权限已经变化，请重新预览 / Project or permission changed; preview again"
                    .into(),
            );
        }
        Ok(())
    }
    pub async fn handle_files(
        &self,
        task: String,
        action: FileTransferAction,
    ) -> Result<FileReply> {
        action.validate().map_err(str::to_owned)?;
        let _guard = self.begin()?;
        let (root, epoch) = self.scope(&task).await?;
        let vault = Vault::open(&self.data)?;
        if let FileTransferAction::Export {
            paths,
            path,
            password,
        } = action
        {
            let mut index = FileIndex {
                version: 1,
                archive_id: uuid::Uuid::new_v4().to_string(),
                created_at_ms: workpilot_storage::now_ms(),
                files: vec![],
            };
            for path in paths {
                super::file_index::safe_path(&path)?;
                self.file_scope_unchanged(&task, &root.identity, &epoch)
                    .await?;
                let snapshot = root.binary_snapshot(&path).map_err(|e| e.to_string())?;
                if !snapshot.version.exists {
                    return Err("所选文件已不存在 / Selected file no longer exists".into());
                }
                let bytes = Zeroizing::new(snapshot.bytes);
                self.file_content_allowed(&bytes).await?;
                let sha256 = vault.put(&bytes)?;
                index.files.push(Entry {
                    path,
                    bytes: bytes.len() as u64,
                    sha256,
                });
                index.objects()?;
            }
            let destination = PathBuf::from(&path);
            let parent = destination.parent().ok_or("Invalid archive destination")?;
            codec::plain(parent, true)?;
            if destination.file_name().is_none() || destination.exists() {
                return Err(
                    "备份位置已存在，请选择新文件名 / Choose a new archive filename".into(),
                );
            }
            let mut temporary = tempfile::NamedTempFile::new_in(parent)
                .map_err(|_| "Cannot create file archive")?;
            codec::write_index(&mut temporary, &password.0, &index, &self.stop, |sha| {
                vault.read(sha)
            })?;
            temporary
                .flush()
                .and_then(|_| temporary.as_file().sync_all())
                .map_err(|_| "Cannot finish file archive")?;
            codec::plain(parent, true)?;
            self.file_scope_unchanged(&task, &root.identity, &epoch)
                .await?;
            temporary
                .persist_noclobber(&destination)
                .map_err(|_| "Archive destination changed")?;
            return Ok(FileReply::Data(
                json!({"kind":"exported","archive_id":index.archive_id,"files":index.files.len(),"bytes":index.files.iter().map(|f| f.bytes).sum::<u64>()}),
            ));
        }
        let (path, password, prefix, confirmed) = match action {
            FileTransferAction::Inspect {
                path,
                password,
                prefix,
            } => (path, password, prefix, None),
            FileTransferAction::Import {
                path,
                password,
                prefix,
                fingerprint,
            } => (path, password, prefix, Some(fingerprint)),
            _ => unreachable!(),
        };
        let (index, archive_sha256) =
            codec::read_index::<FileIndex>(open(&path)?, &password.0, &self.stop, |sha, bytes| {
                if vault.put(bytes)? != sha {
                    return Err("File staging checksum mismatch".into());
                }
                Ok(())
            })?;
        for file in &index.files {
            let bytes = Zeroizing::new(vault.read(&file.sha256)?);
            self.file_content_allowed(&bytes).await?;
        }
        let plan = ImportPlan {
            index,
            task: task.clone(),
            root_identity: root.identity.clone(),
            prefix,
            archive_sha256,
        };
        let paths = plan.paths()?;
        let operation_id = plan.operation_id();
        let id = operation_id.clone();
        let old = self
            .storage
            .call(move |s| s.workbench_operation(&id))
            .await
            .map_err(|e| e.to_string())?;
        let mut conflicts = vec![];
        for path in &paths {
            match root.binary_snapshot(path) {
                Ok(file) if !file.version.exists => {},
                Ok(_) => conflicts.push(json!({"path":path,"reason":"目标已存在 / Destination exists"})),
                Err(_) => conflicts.push(json!({"path":path,"reason":"位置无法使用或包含链接 / Unavailable or linked destination"})),
            }
        }
        let fingerprint = codec::digest(json!([plan, epoch, conflicts]).to_string().as_bytes());
        self.file_scope_unchanged(&task, &root.identity, &epoch)
            .await?;
        if let Some(confirmed) = confirmed {
            if old.is_none() && (confirmed != fingerprint || !conflicts.is_empty()) {
                return Err("备份、位置或文件已变化，请重新预览；未写入文件 / Preview changed or conflicts remain; no files written".into());
            }
            let manifest_blob =
                vault.put(&serde_json::to_vec(&plan).map_err(|e| e.to_string())?)?;
            return Ok(FileReply::Ready {
                id: operation_id,
                task: task.clone(),
                action: Box::new(WorkbenchAction::ImportFiles { manifest_blob }),
            });
        }
        let mappings: Vec<_> = plan.index.files.iter().zip(paths).map(|(f, target)| json!({"source":f.path,"target":target,"bytes":f.bytes,"sha256":f.sha256})).collect();
        Ok(FileReply::Data(
            json!({"kind":"preview","archive_id":plan.index.archive_id,"fingerprint":fingerprint,
            "root_path":root.path,"files":mappings,"conflicts":conflicts,"previous_operation":old,
            "can_import":old.is_some() || conflicts.is_empty(),"bytes":plan.index.files.iter().map(|f|f.bytes).sum::<u64>()}),
        ))
    }
    pub fn file_plan(&self, blob: &str, task: &str, root: &Root) -> Result<ImportPlan> {
        let bytes = Zeroizing::new(Vault::open(&self.data)?.read(blob)?);
        if bytes.len() > 1024 * 1024 {
            return Err("File manifest exceeds limit".into());
        }
        let plan: ImportPlan =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid file import manifest")?;
        plan.paths()?;
        if plan.task != task || plan.root_identity != root.identity {
            return Err(
                "文件导入不属于当前任务或项目 / Import belongs to another task or project".into(),
            );
        }
        Ok(plan)
    }
    pub async fn prepare_files(&self, blob: &str, task: &str, root: &Root) -> Result<Value> {
        let plan = self.file_plan(blob, task, root)?;
        let vault = Vault::open(&self.data)?;
        let mut mappings = vec![];
        for (file, path) in plan.index.files.iter().zip(plan.paths()?) {
            if root
                .binary_snapshot(&path)
                .map_err(|e| e.to_string())?
                .version
                .exists
            {
                return Err("导入位置已被占用，请换一个子文件夹重新预览 / Destination exists; preview a new subfolder".into());
            }
            let bytes = Zeroizing::new(vault.read(&file.sha256)?);
            if bytes.len() as u64 != file.bytes {
                return Err("File staging size mismatch".into());
            }
            self.file_content_allowed(&bytes).await?;
            mappings.push(
                json!({"source":file.path,"target":path,"bytes":file.bytes,"sha256":file.sha256}),
            );
        }
        Ok(
            json!({"archive_id":plan.index.archive_id,"archive_sha256":plan.archive_sha256,"files":mappings,"overwrite":false}),
        )
    }
    pub fn execute_files(
        &self,
        blob: &str,
        task: &str,
        root: &Root,
        stop: &AtomicBool,
    ) -> Result<Value> {
        let plan = self.file_plan(blob, task, root)?;
        let vault = Vault::open(&self.data)?;
        copy_files(root, &plan, stop, |sha| vault.read(sha))
    }
}

fn copy_files(
    root: &Root,
    plan: &ImportPlan,
    stop: &AtomicBool,
    mut read: impl FnMut(&str) -> Result<Vec<u8>>,
) -> Result<Value> {
    let paths = plan.paths()?;
    let mut copied = vec![];
    let mut error = None;
    for (file, path) in plan.index.files.iter().zip(&paths) {
        let result = (|| {
            if stop.load(Ordering::SeqCst) {
                return Err("导入已停止 / Import stopped".into());
            }
            let bytes = Zeroizing::new(read(&file.sha256)?);
            if bytes.len() as u64 != file.bytes || codec::digest(&bytes) != file.sha256 {
                return Err("暂存文件校验失败 / Staged file checksum mismatch".into());
            }
            if stop.load(Ordering::SeqCst) {
                return Err("导入已停止 / Import stopped".into());
            }
            root.create_import_file(path, &bytes)
                .map_err(|e| e.to_string())
        })();
        match result {
            Ok(version) => copied.push(json!({"source":file.path,"target":path,"version":version})),
            Err(e) => {
                error = Some(e);
                break;
            }
        }
    }
    let remaining: Vec<_> = paths.iter().skip(copied.len()).collect();
    Ok(
        json!({"archive_id":plan.index.archive_id,"copied":copied,"unconfirmed":remaining,"failed":error.is_some(),"error":error,"history_recorded":true,"atomic_batch":false}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn partial_failure_and_stop_preserve_completed_files_without_overwrite() {
        for stop_case in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let root = Root::open(temp.path().to_str().unwrap(), None).unwrap();
            let index = FileIndex {
                version: 1,
                archive_id: uuid::Uuid::new_v4().to_string(),
                created_at_ms: 0,
                files: ["a.txt", "b.txt"]
                    .iter()
                    .map(|p| Entry {
                        path: p.to_string(),
                        bytes: 1,
                        sha256: codec::digest(b"x"),
                    })
                    .collect(),
            };
            let plan = ImportPlan {
                index,
                task: "task".into(),
                root_identity: root.identity.clone(),
                prefix: "".into(),
                archive_sha256: codec::digest(b"fixture"),
            };
            let stop = AtomicBool::new(false);
            if !stop_case {
                root.create_import_file("b.txt", b"existing").unwrap();
            }
            let mut reads = 0;
            let result = copy_files(&root, &plan, &stop, |_| {
                reads += 1;
                if stop_case && reads == 2 {
                    stop.store(true, Ordering::SeqCst);
                }
                Ok(b"x".to_vec())
            })
            .unwrap();
            assert_eq!(result["failed"], true);
            assert_eq!(result["copied"].as_array().unwrap().len(), 1);
            assert_eq!(result["unconfirmed"], json!(["b.txt"]));
            assert_eq!(root.binary_snapshot("a.txt").unwrap().bytes, b"x");
            if stop_case {
                assert!(!root.binary_snapshot("b.txt").unwrap().version.exists);
            } else {
                assert_eq!(root.binary_snapshot("b.txt").unwrap().bytes, b"existing");
            }
        }
    }
}
