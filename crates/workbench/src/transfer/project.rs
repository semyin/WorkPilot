use super::*;
impl Manager {
    pub async fn handle_project(&self, action: ProjectTransferAction) -> Result<Value> {
        action.validate().map_err(str::to_owned)?;
        let _guard = self.begin()?;
        if let ProjectTransferAction::Export {
            project_id,
            profile_ids,
            memory_ids,
            path,
            password,
        } = action
        {
            let bundle = self
                .storage
                .call(move |s| s.export_project_settings(&project_id, &profile_ids, &memory_ids))
                .await
                .map_err(|e| e.to_string())?;
            validate(&bundle)?;
            let bytes = zeroize::Zeroizing::new(
                serde_json::to_vec(&bundle).map_err(|_| "Cannot encode settings")?,
            );
            let destination = PathBuf::from(&path);
            let parent = destination.parent().ok_or("Invalid archive destination")?;
            codec::plain(parent, true)?;
            if destination.file_name().is_none() || destination.exists() {
                return Err(
                    "保存位置已存在，请选择新文件名 / Choose a new archive filename".into(),
                );
            }
            let mut temporary = tempfile::NamedTempFile::new_in(parent)
                .map_err(|_| "无法创建设置包 / Cannot create settings archive")?;
            codec::write_document(&mut temporary, &password.0, &bytes, &self.stop)?;
            temporary
                .flush()
                .and_then(|_| temporary.as_file().sync_all())
                .map_err(|_| "设置包写入未完成 / Archive write did not finish")?;
            codec::plain(parent, true)?;
            self.check_project_stop()?;
            temporary.persist_noclobber(&destination).map_err(
                |_| "保存位置已变化或无法保存 / Archive destination changed or unavailable",
            )?;
            return Ok(
                json!({"kind":"exported","archive_id":bundle.archive_id,"profiles":bundle.profiles.len(),"memories":bundle.memories.len()}),
            );
        }
        let (path, password, root_path, name, confirmed) = match action {
            ProjectTransferAction::Inspect {
                path,
                password,
                root_path,
                name,
            } => (path, password, root_path, name, None),
            ProjectTransferAction::Import {
                path,
                password,
                root_path,
                name,
                fingerprint,
            } => (path, password, root_path, name, Some(fingerprint)),
            _ => unreachable!(),
        };
        let (bytes, digest) = codec::read_document(open(&path)?, &password.0, &self.stop)?;
        let bundle: ProjectTransferBundle = serde_json::from_slice(&bytes)
            .map_err(|_| "设置包结构无效 / Invalid settings archive")?;
        validate(&bundle)?;
        let root = Root::open(&root_path, None)
            .map_err(|_| "目标文件夹不存在、已变化或无法访问 / Target folder unavailable")?;
        let canonical = root.path.to_string_lossy().into_owned();
        let (copy, identity, desired, sha) = (
            bundle.clone(),
            root.identity.clone(),
            name.trim().to_owned(),
            digest.clone(),
        );
        let state = self
            .storage
            .call(move |s| s.project_import_preview(&copy, &identity, &desired, &sha))
            .await
            .map_err(|e| e.to_string())?;
        let fingerprint = codec::digest(
            serde_json::to_vec(&json!([digest, root.identity, canonical, name.trim()]))
                .map_err(|_| "Cannot encode preview")?
                .as_slice(),
        );
        if let Some(confirmed) = confirmed {
            if confirmed != fingerprint {
                return Err("设置包或目标项目已变化，请重新预览 / Archive or destination changed; preview again".into());
            }
            Root::open(&root_path, Some(&root.identity))
                .map_err(|_| "目标文件夹已变化 / Target folder changed")?;
            self.check_project_stop()?;
            let identity = root.identity;
            let (receipt, events) = self
                .storage
                .call(move |s| {
                    s.import_project_settings(
                        &bundle, &canonical, &identity, &name, &digest, &state,
                    )
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
            return Ok(json!({"kind":"imported","duplicate":duplicate,"receipt":receipt}));
        }
        let needs_credentials = bundle.profiles.iter().any(|p| p.auth != AuthMode::None);
        Ok(
            json!({"kind":"preview","fingerprint":fingerprint,"source_project":bundle.project.settings.name,"name":name.trim(),"rules":bundle.project.settings.rules,"root_path":canonical,"profiles":bundle.profiles,"memories":bundle.memories,"already_imported":state["already_imported"],"conflicts":state["conflicts"],"permission":"request_approval","credentials_required":needs_credentials}),
        )
    }
    fn check_project_stop(&self) -> Result<()> {
        if self.stop.load(Ordering::Relaxed) {
            Err("设置迁移已取消 / Settings transfer cancelled".into())
        } else {
            Ok(())
        }
    }
}
fn validate(bundle: &ProjectTransferBundle) -> Result<()> {
    bundle.validate().map_err(str::to_owned)?;
    for p in &bundle.profiles {
        workpilot_providers::config::validate_profile(p)
            .map_err(|_| "模型配置无效，请检查设置包 / Invalid model configuration in archive")?;
    }
    Ok(())
}
