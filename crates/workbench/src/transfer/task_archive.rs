use super::*;
use codec::ArchiveIndex;
use workpilot_storage::{TaskArchiveBytes, task_archive_summary};
mod attachments;
mod file_history;
mod mapped;
mod team_restore;

pub(super) struct Owner<'a>(pub(super) &'a Manager);
impl Drop for Owner<'_> {
    fn drop(&mut self) {
        let mut active = self.0.archive_active.lock().unwrap();
        self.0.stop.store(true, Ordering::SeqCst);
        *active = false;
    }
}

impl ArchiveIndex for TaskArchiveIndex {
    const MAGIC: &'static [u8; 8] = b"WPTASK01";
    fn objects(&self) -> Result<BTreeMap<String, u64>> {
        self.validate().map_err(str::to_owned)?;
        let mut objects: BTreeMap<_, _> = self
            .objects
            .iter()
            .map(|r| (r.object_id.clone(), r.bytes))
            .collect();
        for m in &self.media {
            super::file_index::safe_path(&m.entry.name)?;
            if objects
                .insert(m.entry.sha256.clone(), m.entry.bytes)
                .is_some_and(|size| size != m.entry.bytes)
            {
                return Err("附件大小不一致 / Inconsistent attachment size".into());
            }
        }
        if !self.file_history.is_empty() {
            let history = codec::Manifest {
                version: 1,
                archive_id: self.archive_id.clone(),
                created_at_ms: self.created_at_ms,
                revisions: self
                    .file_history
                    .iter()
                    .map(|h| h.revision.clone())
                    .collect(),
            };
            for (sha, size) in history.objects()? {
                if objects.insert(sha, size).is_some_and(|old| old != size) {
                    return Err("Inconsistent history image size".into());
                }
            }
        }
        Ok(objects)
    }
}
impl Manager {
    pub async fn handle_task_archive(
        &self,
        action: TaskArchiveAction,
        media: &crate::media::Manager,
    ) -> Result<Value> {
        action.validate().map_err(str::to_owned)?;
        match action {
            TaskArchiveAction::RecoveryStatus { task_id } => {
                return self
                    .storage
                    .call(move |s| s.migration_recovery_status(&task_id))
                    .await
                    .map_err(|e| e.to_string());
            }
            TaskArchiveAction::ResolveRecovery { task_id, notes } => {
                let (data, events) = self
                    .storage
                    .call(move |s| s.resolve_migration_recovery(&task_id, &notes))
                    .await
                    .map_err(|e| e.to_string())?;
                for event in events {
                    let _ = self
                        .out
                        .send(Wire::Event {
                            event: Box::new(event),
                        })
                        .await;
                }
                return Ok(data);
            }
            TaskArchiveAction::Cancel => {
                let active = self.archive_active.lock().unwrap();
                if *active {
                    self.stop.store(true, Ordering::SeqCst);
                }
                return Ok(json!({"cancel_requested":*active}));
            }
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
        *self.archive_active.lock().unwrap() = true;
        let _owner = Owner(self);
        let mut work = Box::pin(self.task_archive_inner(action, media));
        tokio::select! {
            result = &mut work => result,
            _ = tokio::time::sleep(std::time::Duration::from_secs(90)) => {
                self.stop.store(true, Ordering::SeqCst);
                match work.await {
                    Ok(result) if matches!(result["kind"].as_str(), Some("imported" | "exported")) || result["restored_at_ms"].is_u64() => Ok(result),
                    _ => Err("档案处理超过 90 秒，已停止 / Archive processing timed out after 90 seconds".into()),
                }
            }
        }
    }
    async fn task_archive_inner(
        &self,
        action: TaskArchiveAction,
        media: &crate::media::Manager,
    ) -> Result<Value> {
        if matches!(
            action,
            TaskArchiveAction::MappedRestorePreview { .. }
                | TaskArchiveAction::MappedRestore { .. }
        ) {
            return self.handle_mapped_restore(action, media).await;
        }
        if matches!(
            action,
            TaskArchiveAction::TeamRestoreOptions { .. }
                | TaskArchiveAction::TeamRestorePreview { .. }
                | TaskArchiveAction::TeamRestore { .. }
        ) {
            return self.handle_team_restore(action, media).await;
        }
        if let TaskArchiveAction::RestorePreview {
            archive_id,
            project_id,
            profile_id,
        }
        | TaskArchiveAction::Restore {
            archive_id,
            project_id,
            profile_id,
            ..
        } = &action
        {
            let (archive, project, profile, stop) = (
                archive_id.clone(),
                project_id.clone(),
                profile_id.clone(),
                self.stop.clone(),
            );
            let mut preview = self
                .storage
                .call(move |s| {
                    s.task_restore_preview(&archive, project.as_deref(), &profile, &stop)
                })
                .await
                .map_err(|e| e.to_string())?;
            let candidates = if preview["already_restored"] == true {
                vec![]
            } else {
                self.prepare_archive_media(archive_id, media).await?
            };
            let (archive, data, prepared) =
                (archive_id.clone(), preview.clone(), candidates.clone());
            preview = self
                .storage
                .call(move |s| s.task_restore_media_preview(&archive, data, &prepared))
                .await
                .map_err(|e| e.to_string())?;
            if preview["already_restored"] != true {
                self.verify_restoration_history(archive_id, &preview)
                    .await?;
                let project = project_id.clone();
                let target = self
                    .storage
                    .call(move |s| s.task_restore_target(project.as_deref()))
                    .await
                    .map_err(|e| e.to_string())?;
                if let Some((project, identity)) = target {
                    Root::open(&project.settings.root_path, identity.as_deref()).map_err(|_|"目标项目文件夹已变化或无法访问 / Target project folder changed or unavailable")?;
                }
            }
            if let TaskArchiveAction::Restore { fingerprint, .. } = &action {
                let (archive, project, profile, fingerprint, stop) = (
                    archive_id.clone(),
                    project_id.clone(),
                    profile_id.clone(),
                    fingerprint.clone(),
                    self.stop.clone(),
                );
                let (result, events) = self
                    .storage
                    .call(move |s| {
                        s.restore_task_archive_with_media(
                            &archive,
                            project.as_deref(),
                            &profile,
                            &fingerprint,
                            &candidates,
                            &stop,
                        )
                    })
                    .await
                    .map_err(|e| e.to_string())?;
                for event in events {
                    if !matches!(event.payload, Payload::RestoredMessage { .. }) {
                        let _ = self
                            .out
                            .send(Wire::Event {
                                event: Box::new(event),
                            })
                            .await;
                    }
                }
                return Ok(result);
            }
            return Ok(preview);
        }
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
                self.write_task_archive(bundle, &path, &password.0, true)
                    .await
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
                self.write_task_archive(bundle, &path, &password.0, false)
                    .await
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
    async fn write_task_archive(
        &self,
        bundle: TaskArchiveBytes,
        path: &str,
        password: &str,
        source: bool,
    ) -> Result<Value> {
        self.verify_archive_media(&bundle.index, source).await?;
        self.verify_archive_history(&bundle.index, source).await?;
        let vault = (!bundle.index.media.is_empty() || !bundle.index.file_history.is_empty())
            .then(|| Vault::open(&self.data))
            .transpose()?;
        let destination = PathBuf::from(path);
        let parent = destination.parent().ok_or("Invalid destination")?;
        codec::plain(parent, true)?;
        if destination.file_name().is_none() || destination.exists() {
            return Err("保存位置已存在，请选择新文件名 / Choose a new archive filename".into());
        }
        let mut temporary =
            tempfile::NamedTempFile::new_in(parent).map_err(|_| "Cannot create task archive")?;
        codec::write_index(
            &mut temporary,
            password,
            &bundle.index,
            &self.stop,
            |sha| match bundle.blobs.get(sha) {
                Some(bytes) => Ok(bytes.clone()),
                None => vault.as_ref().ok_or("Missing attachment vault")?.read(sha),
            },
        )?;
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
        self.import_archive_history(&index, &blobs, confirmed.is_some())
            .await?;
        self.import_archive_media(&index, &mut blobs, confirmed.is_some())
            .await?;
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
