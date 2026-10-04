use super::*;
use std::collections::HashSet;

impl Manager {
    pub(super) async fn export_migration(
        &self,
        selections: &[MigrationSelection],
        path: &str,
        password: &str,
        extensions: &workpilot_extensions::Manager,
    ) -> Result<Value> {
        let mut bundle = Bundle {
            version: 1,
            archive_id: uuid::Uuid::new_v4().to_string(),
            created_at_ms: workpilot_storage::now_ms(),
            projects: vec![],
            tasks: vec![],
        };
        let mut blobs = BTreeMap::new();
        let vault = Vault::open(&self.data)?;
        let mut tasks = HashSet::new();
        let mut memories = HashSet::new();
        for selection in selections {
            if selection
                .memory_ids
                .iter()
                .any(|id| !memories.insert(id.clone()))
            {
                return Err("同一记忆只能选择一次 / Select each memory once".into());
            }
            let s = selection.clone();
            let (settings, target) = self
                .storage
                .call(move |store| {
                    Ok((
                        store.export_project_settings(
                            &s.project_id,
                            &s.profile_ids,
                            &s.memory_ids,
                            true,
                        )?,
                        store
                            .task_restore_target(Some(&s.project_id))?
                            .ok_or(workpilot_storage::Error::NotFound)?,
                    ))
                })
                .await
                .map_err(|e| e.to_string())?;
            let mut files = None;
            if !selection.files.is_empty() {
                let root = Root::open(&target.0.settings.root_path, target.1.as_deref())
                    .map_err(|e| e.to_string())?;
                let mut index = file_index::FileIndex {
                    version: 1,
                    archive_id: uuid::Uuid::new_v4().to_string(),
                    created_at_ms: bundle.created_at_ms,
                    files: vec![],
                };
                for path in &selection.files {
                    file_index::safe_path(path)?;
                    let current = root.binary_snapshot(path).map_err(|e| e.to_string())?;
                    if !current.version.exists {
                        return Err("所选文件已不存在 / A selected file is missing".into());
                    }
                    self.file_content_allowed(&current.bytes).await?;
                    let sha = codec::digest(&current.bytes);
                    index.files.push(file_index::Entry {
                        path: path.clone(),
                        bytes: current.bytes.len() as u64,
                        sha256: sha.clone(),
                    });
                    blobs.insert(sha, current.bytes);
                }
                index.objects()?;
                files = Some(index);
            }
            let extension = if selection.extensions.is_empty() && selection.draft_ids.is_empty() {
                None
            } else {
                Some(
                    extensions
                        .export_transfer_complete(
                            target.1.as_deref(),
                            &selection.extensions,
                            true,
                            &selection.draft_ids,
                            &self.stop,
                        )
                        .await?,
                )
            };
            bundle.projects.push(ScopeBundle {
                settings,
                source_root: target.1,
                files,
                extensions: extension,
            });
            for id in &selection.task_ids {
                if !tasks.insert(id.clone()) {
                    return Err("同一主任务只能选择一次 / Select each root task once".into());
                }
                let (id, stop) = (id.clone(), self.stop.clone());
                let archive = self
                    .storage
                    .call(move |s| s.export_task_archive(&id, &stop))
                    .await
                    .map_err(|e| e.to_string())?;
                self.verify_archive_history(&archive.index, true).await?;
                self.verify_archive_media(&archive.index, true).await?;
                let snapshot: TaskArchiveSnapshot =
                    serde_json::from_slice(&archive.blobs[&archive.index.snapshot.object_id])
                        .map_err(|_| "Invalid task snapshot")?;
                if snapshot.tables["tasks"].iter().any(|t| {
                    t["project_id"]
                        .as_str()
                        .is_some_and(|id| !selections.iter().any(|s| s.project_id == id))
                }) {
                    return Err("所选团队涉及未选择的项目，请一并选择 / Include every project used by the selected teams".into());
                }
                for (sha, _) in archive.index.objects()? {
                    let bytes = if let Some(bytes) = archive.blobs.get(&sha) {
                        bytes.clone()
                    } else {
                        vault.read(&sha)?
                    };
                    blobs.insert(sha, bytes);
                }
                bundle.tasks.push(archive.index);
            }
            if self.stop.load(Ordering::Relaxed) {
                return Err("Migration cancelled".into());
            }
        }
        bundle.validate_task_models(&blobs)?;
        let mut objects = bundle.objects()?;
        let manifest = serde_json::to_vec(&bundle).map_err(|_| "Cannot encode migration")?;
        if manifest.len() > 16 * 1024 * 1024 {
            return Err("Migration manifest exceeds 16 MiB".into());
        }
        self.file_content_allowed(&manifest).await?;
        let sha = codec::digest(&manifest);
        objects.insert(sha.clone(), manifest.len() as u64);
        blobs.insert(sha.clone(), manifest);
        let index = Index {
            version: 1,
            archive_id: bundle.archive_id.clone(),
            manifest: sha,
            objects,
        };
        index.objects()?;
        let destination = PathBuf::from(path);
        let parent = destination.parent().ok_or("Invalid archive path")?;
        codec::plain(parent, true)?;
        if destination.exists() {
            return Err("保存位置已存在 / Destination already exists".into());
        }
        let mut file = tempfile::NamedTempFile::new_in(parent)
            .map_err(|_| "Cannot create migration archive")?;
        codec::write_index(&mut file, password, &index, &self.stop, |sha| {
            blobs
                .get(sha)
                .cloned()
                .ok_or("Missing migration bytes".into())
        })?;
        file.flush()
            .and_then(|_| file.as_file().sync_all())
            .map_err(|_| "Cannot finish migration archive")?;
        codec::plain(parent, true)?;
        if self.stop.load(Ordering::Relaxed) {
            return Err("Migration cancelled".into());
        }
        file.persist_noclobber(&destination)
            .map_err(|_| "Archive destination changed")?;
        Ok(json!({"kind":"exported","summary":bundle.summary()}))
    }
}
