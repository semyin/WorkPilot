use super::*;
const MAGIC: &[u8; 8] = b"WPEXT001";
const MAX_DOCUMENT: usize = 96 * 1024 * 1024;

impl Manager {
    async fn extension_target(
        &self,
        task: Option<&str>,
    ) -> Result<(Option<String>, Option<String>)> {
        let Some(task) = task else {
            return Ok((None, None));
        };
        let task = task.to_owned();
        let policy = self
            .storage
            .call(move |s| s.tool_settings(&task))
            .await
            .map_err(|e| e.to_string())?;
        let identity = match &policy.settings.root_path {
            Some(path) => Some(
                Root::open(path, policy.root_identity.as_deref())
                    .map_err(|e| e.to_string())?
                    .identity,
            ),
            None => None,
        };
        Ok((identity, Some(policy.epoch)))
    }
    pub async fn handle_extensions(
        &self,
        task: Option<String>,
        action: ExtensionTransferAction,
        extensions: &workpilot_extensions::Manager,
    ) -> Result<Value> {
        action.validate().map_err(str::to_owned)?;
        let _guard = self.begin()?;
        let target = self.extension_target(task.as_deref()).await?;
        if matches!(action, ExtensionTransferAction::Catalog) {
            return extensions.transfer_catalog(target.0.as_deref()).await;
        }
        if let ExtensionTransferAction::Export {
            selections,
            include_history,
            draft_ids,
            path,
            password,
        } = action
        {
            let bundle = extensions
                .export_transfer_complete(
                    target.0.as_deref(),
                    &selections,
                    include_history,
                    &draft_ids,
                    &self.stop,
                )
                .await?;
            let bytes = zeroize::Zeroizing::new(
                serde_json::to_vec(&bundle).map_err(|_| "Cannot encode extension archive")?,
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
                .map_err(|_| "Cannot create extension archive")?;
            codec::write_sized_document(
                &mut temporary,
                &password.0,
                &bytes,
                &self.stop,
                MAGIC,
                MAX_DOCUMENT,
            )?;
            temporary
                .flush()
                .and_then(|_| temporary.as_file().sync_all())
                .map_err(|_| "Cannot finish extension archive")?;
            codec::plain(parent, true)?;
            self.check_extension_target(task.as_deref(), &target)
                .await?;
            temporary
                .persist_noclobber(&destination)
                .map_err(|_| "保存位置已变化 / Archive destination changed")?;
            return Ok(
                json!({"kind":"exported","archive_id":bundle.archive_id,"extensions":bundle.entries.len(),"credentials_included":false}),
            );
        }
        let (path, password, confirmed) = match action {
            ExtensionTransferAction::Inspect { path, password } => (path, password, None),
            ExtensionTransferAction::Import {
                path,
                password,
                fingerprint,
            } => (path, password, Some(fingerprint)),
            _ => unreachable!(),
        };
        let (bytes, digest) =
            codec::read_sized_document(open(&path)?, &password.0, &self.stop, MAGIC, MAX_DOCUMENT)?;
        let bundle: ExtensionTransferBundle = serde_json::from_slice(&bytes)
            .map_err(|_| "扩展备份结构无效 / Invalid extension archive")?;
        let mut preview = extensions
            .inspect_transfer(target.0.as_deref(), &bundle, &digest, &self.stop)
            .await?;
        let fingerprint = codec::digest(
            json!([digest, target, preview["state"]])
                .to_string()
                .as_bytes(),
        );
        if let Some(confirmed) = confirmed {
            if confirmed != fingerprint && preview["already_imported"] != true {
                return Err("备份或目标扩展已变化，请重新预览 / Archive or target extensions changed; preview again".into());
            }
            self.check_extension_target(task.as_deref(), &target)
                .await?;
            return extensions
                .import_transfer(
                    target.0.as_deref(),
                    &bundle,
                    &digest,
                    &preview["state"],
                    &self.stop,
                )
                .await;
        }
        self.check_extension_target(task.as_deref(), &target)
            .await?;
        preview["kind"] = json!("preview");
        preview["fingerprint"] = json!(fingerprint);
        // The destination snapshot is internal; only its fingerprint crosses the desktop boundary.
        preview.as_object_mut().unwrap().remove("state");
        Ok(preview)
    }
    async fn check_extension_target(
        &self,
        task: Option<&str>,
        expected: &(Option<String>, Option<String>),
    ) -> Result<()> {
        if self.stop.load(Ordering::SeqCst) {
            return Err("扩展迁移已取消 / Extension transfer cancelled".into());
        }
        if &self.extension_target(task).await? != expected {
            return Err(
                "项目设置已变化，请重新预览 / Project settings changed; preview again".into(),
            );
        }
        Ok(())
    }
}
