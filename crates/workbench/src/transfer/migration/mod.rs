//! One encrypted selection, explicit destination mapping, resumable component receipts.
mod export;
mod import;
mod index;
mod preview;
use super::*;
use crate::transfer::files::FileReply;
use codec::ArchiveIndex;
use index::{Bundle, Index, ScopeBundle};

impl Manager {
    pub async fn handle_migration(
        &self,
        action: MigrationAction,
        extensions: &workpilot_extensions::Manager,
        _media: &crate::media::Manager,
    ) -> Result<FileReply> {
        action.validate().map_err(str::to_owned)?;
        if matches!(action, MigrationAction::Cancel) {
            let active = self.archive_active.lock().unwrap();
            if *active {
                self.stop.store(true, Ordering::SeqCst);
            }
            return Ok(FileReply::Data(json!({"cancel_requested":*active})));
        }
        let _guard = self.begin()?;
        *self.archive_active.lock().unwrap() = true;
        let _owner = super::task_archive::Owner(self);
        let value = match action {
            MigrationAction::Catalog => {
                let mut data = self
                    .storage
                    .call(|s| s.migration_catalog())
                    .await
                    .map_err(|e| e.to_string())?;
                let mut scopes = vec![];
                for project in data["projects"].as_array().ok_or("Missing projects")? {
                    let id = project["id"].as_str().ok_or("Invalid project")?.to_owned();
                    let target = self
                        .storage
                        .call(move |s| s.task_restore_target(Some(&id)))
                        .await
                        .map_err(|e| e.to_string())?
                        .ok_or("Missing project")?;
                    let scope = target.1.as_deref();
                    scopes.push(json!({"project_id":target.0.id,"catalog":extensions.transfer_catalog(scope).await?}));
                }
                data["extensions"] = json!(scopes);
                data
            }
            MigrationAction::Export {
                selections,
                path,
                password,
            } => {
                self.export_migration(&selections, &path, &password.0, extensions)
                    .await?
            }
            MigrationAction::Status { archive_id } => self.migration_status(&archive_id).await?,
            MigrationAction::PrepareFiles {
                archive_id,
                source_project_id,
            } => {
                let receipt = self.migration_status(&archive_id).await?;
                let plan = &receipt["files"][&source_project_id];
                if plan["deleted"] == true {
                    return Err("迁入文件任务已永久删除；不会重新创建或读取已删除的备份内容 / This file-import task was permanently deleted; it will not be recreated".into());
                }
                let task = plan["task_id"]
                    .as_str()
                    .ok_or("Missing file task")?
                    .to_owned();
                let (root, _) = self.scope(&task).await?;
                let blob = plan["manifest_blob"]
                    .as_str()
                    .ok_or("Missing file plan")?
                    .to_owned();
                let file = self.file_plan(&blob, &task, &root)?;
                return Ok(FileReply::Ready {
                    id: file.operation_id(),
                    task,
                    action: Box::new(WorkbenchAction::ImportFiles {
                        manifest_blob: blob,
                    }),
                });
            }
            MigrationAction::Inspect { path, password } => {
                let (bundle, _, _) = self.read_migration(&path, &password.0).await?;
                let mut summary = bundle.summary();
                let id = bundle.archive_id.clone();
                if self
                    .storage
                    .call(move |s| s.migration_receipt(&id))
                    .await
                    .map_err(|e| e.to_string())?
                    .is_some()
                {
                    summary["resume"] = self.migration_status(&bundle.archive_id).await?;
                }
                summary
            }
            MigrationAction::Preview { .. }
            | MigrationAction::Import { .. }
            | MigrationAction::Cancel => {
                unreachable!("preview/import are dispatched by migration_transfer")
            }
        };
        Ok(FileReply::Data(value))
    }
    pub async fn migration_transfer(
        &self,
        action: MigrationAction,
        extensions: &workpilot_extensions::Manager,
        media: &crate::media::Manager,
    ) -> Result<FileReply> {
        let import = match &action {
            MigrationAction::Import { fingerprint, .. } => Some(fingerprint.clone()),
            _ => None,
        };
        if let MigrationAction::Preview {
            path,
            password,
            destinations,
            history_roots,
        }
        | MigrationAction::Import {
            path,
            password,
            destinations,
            history_roots,
            ..
        } = action
        {
            let validation = MigrationAction::Preview {
                path: path.clone(),
                password: password.clone(),
                destinations: destinations.clone(),
                history_roots: history_roots.clone(),
            };
            validation.validate().map_err(str::to_owned)?;
            let _guard = self.begin()?;
            *self.archive_active.lock().unwrap() = true;
            let _owner = super::task_archive::Owner(self);
            let (bundle, blobs, digest) = self.read_migration(&path, &password.0).await?;
            let preview = self
                .preview_migration(
                    &bundle,
                    &blobs,
                    &digest,
                    &destinations,
                    &history_roots,
                    extensions,
                )
                .await?;
            if let Some(fingerprint) = import {
                if preview["fingerprint"] != fingerprint {
                    return Err("迁移包或目标已变化，请重新预览 / Migration or destination changed; preview again".into());
                }
                return Ok(FileReply::Data(
                    self.import_migration(
                        bundle,
                        blobs,
                        preview,
                        &destinations,
                        &history_roots,
                        extensions,
                        media,
                    )
                    .await?,
                ));
            }
            return Ok(FileReply::Data(preview));
        }
        self.handle_migration(action, extensions, media).await
    }
    async fn read_migration(
        &self,
        path: &str,
        password: &str,
    ) -> Result<(Bundle, BTreeMap<String, Vec<u8>>, String)> {
        let mut blobs = BTreeMap::new();
        let (index, _) =
            codec::read_index::<Index>(open(path)?, password, &self.stop, |sha, bytes| {
                blobs.insert(sha.to_owned(), bytes.to_vec());
                Ok(())
            })?;
        let data = blobs
            .remove(&index.manifest)
            .ok_or("Missing migration manifest")?;
        if data.len() > 16 * 1024 * 1024 {
            return Err("Migration manifest exceeds 16 MiB".into());
        }
        self.file_content_allowed(&data).await?;
        let bundle: Bundle =
            serde_json::from_slice(&data).map_err(|_| "Invalid migration manifest")?;
        let declared = bundle.objects()?;
        if bundle.archive_id != index.archive_id
            || declared.len() != blobs.len()
            || declared.iter().any(|(sha, size)| {
                blobs
                    .get(sha)
                    .is_none_or(|b| b.len() as u64 != *size || codec::digest(b) != *sha)
            })
        {
            return Err("Migration content index mismatch".into());
        }
        for bytes in blobs.values() {
            self.file_content_allowed(bytes).await?;
        }
        bundle.validate_task_models(&blobs)?;
        for project in &bundle.projects {
            for profile in &project.settings.profiles {
                workpilot_providers::config::validate_profile(profile)
                    .map_err(|_| "迁移包模型配置无效 / Invalid archived model configuration")?;
            }
        }
        for index in &bundle.tasks {
            let mut own = index
                .objects()?
                .keys()
                .map(|id| {
                    Ok((
                        id.clone(),
                        blobs.get(id).cloned().ok_or("Missing task content")?,
                    ))
                })
                .collect::<Result<BTreeMap<_, _>>>()?;
            self.import_archive_history(index, &own, false).await?;
            self.import_archive_media(index, &mut own, false).await?;
            let snapshot: TaskArchiveSnapshot = serde_json::from_slice(
                own.get(&index.snapshot.object_id)
                    .ok_or("Missing task snapshot")?,
            )
            .map_err(|_| "Invalid task snapshot")?;
            if snapshot.tables["tasks"].iter().any(|t| {
                t["project_id"]
                    .as_str()
                    .is_some_and(|id| !bundle.projects.iter().any(|p| p.settings.project.id == id))
            }) {
                return Err(
                    "档案任务引用未选项目 / A task references a project outside the selection"
                        .into(),
                );
            }
            let raw = workpilot_storage::TaskArchiveBytes {
                index: index.clone(),
                blobs: own,
            };
            self.storage
                .call(move |s| s.validate_task_archive_bytes(&raw))
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok((bundle, blobs, codec::digest(&data)))
    }
    async fn migration_status(&self, archive: &str) -> Result<Value> {
        let a = archive.to_owned();
        let mut receipt = self
            .storage
            .call(move |s| s.migration_receipt(&a))
            .await
            .map_err(|e| e.to_string())?
            .ok_or("迁移记录不存在 / Migration not found")?;
        if let Some(tasks) = receipt["tasks"].as_object_mut() {
            for task in tasks.values_mut() {
                let id = task["task_id"]
                    .as_str()
                    .ok_or("Invalid task receipt")?
                    .to_owned();
                let exists = self
                    .storage
                    .call(move |s| Ok(s.task(&id).is_ok()))
                    .await
                    .map_err(|e| e.to_string())?;
                task["deleted"] = json!(!exists);
            }
        }
        let mut all_files = true;
        if let Some(files) = receipt["files"].as_object_mut() {
            for file in files.values_mut() {
                if file["deleted"] == true {
                    continue;
                }
                let id = file["operation_id"]
                    .as_str()
                    .ok_or("Invalid file receipt")?
                    .to_owned();
                let operation = self
                    .storage
                    .call(move |s| s.workbench_operation(&id))
                    .await
                    .map_err(|e| e.to_string())?;
                if let Some(operation) = operation {
                    file["state"] = json!(operation.state);
                }
                all_files &= file["state"] == "completed";
            }
        }
        if all_files && receipt["status"] == "awaiting_file_approval" {
            receipt["status"] = json!("complete");
        }
        Ok(receipt)
    }
    async fn persist_migration(&self, receipt: &Value) -> Result<()> {
        let data = receipt.clone();
        let id = receipt["archive_id"]
            .as_str()
            .ok_or("Invalid receipt")?
            .to_owned();
        self.storage
            .call(move |s| s.save_migration_receipt(&id, &data))
            .await
            .map_err(|e| e.to_string())
    }
}
