use super::*;
use codec::ArchiveIndex;
use workpilot_storage::{TaskArchiveBytes, task_archive_summary};

impl ArchiveIndex for TaskArchiveIndex {
    const MAGIC: &'static [u8; 8] = b"WPTASK01";
    fn objects(&self) -> Result<BTreeMap<String, u64>> {
        self.validate().map_err(str::to_owned)?;
        Ok(self
            .objects
            .iter()
            .map(|r| (r.object_id.clone(), r.bytes))
            .collect())
    }
}
impl Manager {
    pub async fn handle_task_archive(&self, action: TaskArchiveAction) -> Result<Value> {
        action.validate().map_err(str::to_owned)?;
        match action {
            TaskArchiveAction::List => {
                return self
                    .storage
                    .call(|s| s.task_archive_list())
                    .await
                    .map_err(|e| e.to_string());
            }
            TaskArchiveAction::Records {
                archive_id,
                table,
                offset,
                limit,
            } => {
                return self
                    .storage
                    .call(move |s| s.read_task_archive(&archive_id, &table, offset, limit))
                    .await
                    .map_err(|e| e.to_string());
            }
            _ => {}
        }
        let _guard = self.begin()?;
        match action {
            TaskArchiveAction::Export {
                task_id,
                path,
                password,
            } => {
                let stop = self.stop.clone();
                let bundle = self
                    .storage
                    .call(move |s| s.export_task_archive(&task_id, &stop))
                    .await
                    .map_err(|e| e.to_string())?;
                self.write_task_archive(bundle, &path, &password.0)
            }
            TaskArchiveAction::ExportSaved {
                archive_id,
                path,
                password,
            } => {
                let stop = self.stop.clone();
                let bundle = self
                    .storage
                    .call(move |s| s.export_saved_task_archive(&archive_id, &stop))
                    .await
                    .map_err(|e| e.to_string())?;
                self.write_task_archive(bundle, &path, &password.0)
            }
            TaskArchiveAction::Inspect { path, password } => {
                self.read_task_archive(&path, &password.0, None).await
            }
            TaskArchiveAction::Import {
                path,
                password,
                fingerprint,
            } => {
                self.read_task_archive(&path, &password.0, Some(&fingerprint))
                    .await
            }
            _ => unreachable!(),
        }
    }
    fn write_task_archive(
        &self,
        bundle: TaskArchiveBytes,
        path: &str,
        password: &str,
    ) -> Result<Value> {
        let destination = PathBuf::from(path);
        let parent = destination.parent().ok_or("Invalid destination")?;
        codec::plain(parent, true)?;
        if destination.file_name().is_none() || destination.exists() {
            return Err("保存位置已存在，请选择新文件名 / Choose a new archive filename".into());
        }
        let mut temporary =
            tempfile::NamedTempFile::new_in(parent).map_err(|_| "Cannot create task archive")?;
        codec::write_index(&mut temporary, password, &bundle.index, &self.stop, |sha| {
            bundle
                .blobs
                .get(sha)
                .cloned()
                .ok_or_else(|| "Missing archive content".into())
        })?;
        temporary
            .flush()
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|_| "Archive write incomplete")?;
        codec::plain(parent, true)?;
        if self.stop.load(Ordering::Relaxed) {
            return Err("档案操作已取消 / Archive operation cancelled".into());
        }
        temporary
            .persist_noclobber(&destination)
            .map_err(|_| "保存位置已变化或无法保存 / Archive destination changed or unavailable")?;
        Ok(json!({"kind":"exported","summary":task_archive_summary(&bundle.index)}))
    }
    async fn read_task_archive(
        &self,
        path: &str,
        password: &str,
        confirmed: Option<&str>,
    ) -> Result<Value> {
        let mut blobs = BTreeMap::new();
        let (index, digest) = codec::read_index::<TaskArchiveIndex>(
            open(path)?,
            password,
            &self.stop,
            |sha, bytes| {
                blobs.insert(sha.to_owned(), bytes.to_vec());
                Ok(())
            },
        )?;
        let logical =
            codec::digest(&serde_json::to_vec(&index).map_err(|_| "Cannot encode archive")?);
        let fingerprint = codec::digest(
            &serde_json::to_vec(&json!([digest, logical, self.data]))
                .map_err(|_| "Cannot encode preview")?,
        );
        if confirmed.is_some_and(|s| s != fingerprint) {
            return Err(
                "档案或预览已变化，请重新预览 / Archive or preview changed; preview again".into(),
            );
        }
        let summary = task_archive_summary(&index);
        let bundle = TaskArchiveBytes { index, blobs };
        let stop = self.stop.clone();
        let import = confirmed.is_some();
        let state = self
            .storage
            .call(move |s| {
                s.validate_task_archive_bytes(&bundle)?;
                if import {
                    s.import_task_archive(bundle, &logical, &stop)
                } else {
                    s.task_archive_preview(&bundle.index, &logical)
                }
            })
            .await
            .map_err(|e| e.to_string())?;
        if import {
            Ok(state)
        } else {
            Ok(
                json!({"kind":"preview","summary":summary,"fingerprint":fingerprint,"already_imported":state["already_imported"],"imported_at_ms":state["imported_at_ms"]}),
            )
        }
    }
}
