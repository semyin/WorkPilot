use super::*;
use workpilot_storage::TaskArchiveBytes;

impl Manager {
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn import_migration(
        &self,
        bundle: Bundle,
        blobs: BTreeMap<String, Vec<u8>>,
        preview: Value,
        destinations: &[MigrationDestination],
        history: &[MigrationHistoryMapping],
        extensions: &workpilot_extensions::Manager,
        media: &crate::media::Manager,
    ) -> Result<Value> {
        if preview["conflicts"]
            .as_array()
            .is_none_or(|c| !c.is_empty())
        {
            return Err(
                "存在冲突，请调整目标后再导入 / Resolve destination conflicts first".into(),
            );
        }
        let mut receipt = if preview["receipt"].is_object() {
            preview["receipt"].clone()
        } else {
            json!({"archive_id":bundle.archive_id,"binding":preview["binding"],"projects":{},"tasks":{},
                "extensions":{},"files":{},"status":"importing","memory_links_complete":false,
                "destinations":destinations,"history_roots":history})
        };
        if matches!(
            receipt["status"].as_str(),
            Some("complete" | "awaiting_file_approval")
        ) {
            return self.migration_status(&bundle.archive_id).await;
        }
        self.persist_migration(&receipt).await?;
        let work = self
            .import_migration_parts(
                &bundle,
                &blobs,
                &preview,
                destinations,
                history,
                extensions,
                media,
                &mut receipt,
            )
            .await;
        match work {
            Ok(()) => {
                receipt["status"] = json!(if receipt["files"]
                    .as_object()
                    .is_some_and(|f| !f.is_empty())
                {
                    "awaiting_file_approval"
                } else {
                    "complete"
                });
                receipt.as_object_mut().unwrap().remove("error");
                self.persist_migration(&receipt).await?;
            }
            Err(error) => {
                receipt["status"] = json!("partial");
                receipt["error"] = json!(error);
                self.persist_migration(&receipt).await?;
            }
        }
        self.migration_status(
            receipt["archive_id"]
                .as_str()
                .ok_or("Invalid migration receipt")?,
        )
        .await
    }
    #[allow(clippy::too_many_arguments)]
    async fn import_migration_parts(
        &self,
        bundle: &Bundle,
        blobs: &BTreeMap<String, Vec<u8>>,
        preview: &Value,
        destinations: &[MigrationDestination],
        history: &[MigrationHistoryMapping],
        extensions: &workpilot_extensions::Manager,
        media: &crate::media::Manager,
        receipt: &mut Value,
    ) -> Result<()> {
        let stopped = || {
            if self.stop.load(Ordering::Relaxed) {
                Err("迁移已停止，成功部分可继续 / Migration stopped; completed components can be resumed".to_owned())
            } else {
                Ok(())
            }
        };
        for source in &bundle.projects {
            stopped()?;
            let key = &source.settings.project.id;
            if receipt["projects"][key].is_object() {
                continue;
            }
            let target = preview["targets"]
                .as_array()
                .ok_or("Missing targets")?
                .iter()
                .find(|t| t["source_project_id"] == *key)
                .ok_or("Missing project mapping")?;
            let d = destinations
                .iter()
                .find(|d| d.source_project_id == *key)
                .ok_or("Missing destination")?;
            let root = Root::open(&d.root_path, target["root_identity"].as_str())
                .map_err(|_| "Target folder changed")?;
            let (settings, path, identity, name, sha) = (
                source.settings.clone(),
                root.path.to_string_lossy().into_owned(),
                root.identity.clone(),
                d.name.clone(),
                codec::digest(
                    &serde_json::to_vec(&source.settings).map_err(|_| "Invalid settings")?,
                ),
            );
            let (value, events) = self
                .storage
                .call(move |s| {
                    let state = s.project_import_preview(&settings, &identity, &name, &sha)?;
                    s.import_project_settings(&settings, &path, &identity, &name, &sha, &state)
                })
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
            receipt["projects"][key] = value;
            self.persist_migration(receipt).await?;
        }
        let project_map = bundle
            .projects
            .iter()
            .map(|p| {
                Ok((
                    p.settings.project.id.clone(),
                    receipt["projects"][&p.settings.project.id]["project_id"]
                        .as_str()
                        .ok_or("Missing imported project")?
                        .to_owned(),
                ))
            })
            .collect::<Result<BTreeMap<_, _>>>()?;
        for source in &bundle.tasks {
            stopped()?;
            if receipt["tasks"][&source.archive_id].is_object() {
                continue;
            }
            let mut own = source
                .objects()?
                .keys()
                .map(|id| {
                    Ok((
                        id.clone(),
                        blobs.get(id).cloned().ok_or("Missing task object")?,
                    ))
                })
                .collect::<Result<BTreeMap<_, _>>>()?;
            self.import_archive_history(source, &own, true).await?;
            self.import_archive_media(source, &mut own, true).await?;
            let raw = TaskArchiveBytes {
                index: source.clone(),
                blobs: own,
            };
            let sha = codec::digest(&serde_json::to_vec(source).map_err(|_| "Invalid archive")?);
            let stop = self.stop.clone();
            self.storage
                .call(move |s| s.import_task_archive(raw, &sha, &stop))
                .await
                .map_err(|e| e.to_string())?;
            let id = source.archive_id.clone();
            let stop = self.stop.clone();
            let options = self
                .storage
                .call(move |s| s.task_group_restore_options(&id, &stop))
                .await
                .map_err(|e| e.to_string())?;
            if options["already_restored"] == true {
                receipt["tasks"][&source.archive_id] = options;
                self.persist_migration(receipt).await?;
                continue;
            }
            let mut profiles = vec![];
            let mut projects = BTreeMap::new();
            for task in options["tasks"]
                .as_array()
                .ok_or("Missing restoration tasks")?
            {
                let original_project = task["project_id"].as_str().map(str::to_owned);
                let destination = original_project
                    .as_ref()
                    .map(|id| {
                        project_map
                            .get(id)
                            .cloned()
                            .ok_or("Task project was not selected")
                    })
                    .transpose()?;
                projects.insert(original_project.clone(), destination);
                let pin = &task["model"];
                let candidates = bundle
                    .projects
                    .iter()
                    .filter(|p| {
                        original_project
                            .as_ref()
                            .is_none_or(|id| &p.settings.project.id == id)
                    })
                    .flat_map(|p| p.settings.profiles.iter().map(move |profile| (p, profile)));
                let (owner,model)=candidates.into_iter().find(|(_,p)|pin.is_null()||
                    (pin["protocol"]==json!(p.protocol)&&pin["model"]==p.model&&pin["base_url"]==p.base_url))
                    .ok_or("任务原模型没有被选择迁移，请在模型设置中补齐后使用档案恢复 / The original model was not selected; configure it and restore from the archive")?;
                let target = receipt["projects"][&owner.settings.project.id]["profiles"][&model.id]
                    .as_str()
                    .ok_or("Missing model mapping")?;
                profiles.push(TaskProfileMapping {
                    task_id: task["task_id"].as_str().ok_or("Invalid task")?.into(),
                    profile_id: target.into(),
                });
            }
            let required = source
                .file_history
                .iter()
                .map(|h| h.root_identity.as_str())
                .collect::<std::collections::HashSet<_>>();
            let roots = history
                .iter()
                .filter(|h| required.contains(h.source_root.as_str()))
                .map(|h| {
                    Ok(HistoryRootMapping {
                        source_root: h.source_root.clone(),
                        project_id: project_map
                            .get(&h.source_project_id)
                            .cloned()
                            .ok_or("Missing history destination")?,
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            let projects = projects
                .into_iter()
                .map(|(source_project_id, project_id)| TaskProjectMapping {
                    source_project_id,
                    project_id,
                })
                .collect::<Vec<_>>();
            let p = self
                .handle_mapped_restore(
                    TaskArchiveAction::MappedRestorePreview {
                        archive_id: source.archive_id.clone(),
                        profiles: profiles.clone(),
                        projects: projects.clone(),
                        history_roots: roots.clone(),
                    },
                    media,
                )
                .await?;
            let result = self
                .handle_mapped_restore(
                    TaskArchiveAction::MappedRestore {
                        archive_id: source.archive_id.clone(),
                        profiles,
                        projects,
                        history_roots: roots,
                        fingerprint: p["fingerprint"]
                            .as_str()
                            .ok_or("Missing restoration preview")?
                            .into(),
                    },
                    media,
                )
                .await?;
            receipt["tasks"][&source.archive_id] = result;
            self.persist_migration(receipt).await?;
        }
        for source in &bundle.projects {
            stopped()?;
            let key = &source.settings.project.id;
            let target = preview["targets"]
                .as_array()
                .ok_or("Missing targets")?
                .iter()
                .find(|t| t["source_project_id"] == *key)
                .ok_or("Missing mapping")?;
            let root = Root::open(
                target["root_path"].as_str().ok_or("Missing destination")?,
                target["root_identity"].as_str(),
            )
            .map_err(|e| e.to_string())?;
            if let Some(extension) = &source.extensions
                && !receipt["extensions"][key].is_object()
            {
                let sha =
                    codec::digest(&serde_json::to_vec(extension).map_err(|_| "Invalid extension")?);
                let p = extensions
                    .inspect_transfer(Some(&root.identity), extension, &sha, &self.stop)
                    .await?;
                let r = extensions
                    .import_transfer(
                        Some(&root.identity),
                        extension,
                        &sha,
                        &p["state"],
                        &self.stop,
                    )
                    .await?;
                receipt["extensions"][key] = r;
                self.persist_migration(receipt).await?;
            }
            if let Some(files) = &source.files
                && !receipt["files"][key].is_object()
            {
                let (a, k, p) = (
                    bundle.archive_id.clone(),
                    key.clone(),
                    project_map[key].clone(),
                );
                let task = self
                    .storage
                    .call(move |s| s.migration_file_task(&a, &k, &p))
                    .await
                    .map_err(|e| e.to_string())?;
                let vault = Vault::open(&self.data)?;
                for (sha, _) in files.objects()? {
                    if vault.put(blobs.get(&sha).ok_or("Missing selected file")?)? != sha {
                        return Err("File checksum mismatch".into());
                    }
                }
                let plan = file_index::ImportPlan {
                    index: files.clone(),
                    task: task.clone(),
                    root_identity: root.identity,
                    prefix: String::new(),
                    archive_sha256: codec::digest(
                        &serde_json::to_vec(files).map_err(|_| "Invalid file manifest")?,
                    ),
                };
                plan.paths()?;
                let blob =
                    vault.put(&serde_json::to_vec(&plan).map_err(|_| "Invalid file plan")?)?;
                receipt["files"][key] = json!({"task_id":task,"manifest_blob":blob,"operation_id":plan.operation_id(),"files":files.files,"state":"awaiting_approval"});
                self.persist_migration(receipt).await?;
            }
        }
        let id = bundle.archive_id.clone();
        self.storage
            .call(move |s| s.link_migration_memories(&id))
            .await
            .map_err(|e| e.to_string())?;
        receipt["memory_links_complete"] = json!(true);
        Ok(())
    }
}
