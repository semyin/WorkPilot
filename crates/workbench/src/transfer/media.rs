//! Portable attachment originals. Cached parser output and live project paths are never imported.
use super::{codec::ArchiveIndex, *};
use workpilot_storage::MediaImportBatch;
use zeroize::Zeroizing;

impl ArchiveIndex for MediaTransferBundle {
    const MAGIC: &'static [u8; 8] = b"WPMEDIA1";
    fn objects(&self) -> Result<BTreeMap<String, u64>> {
        self.validate().map_err(str::to_owned)?;
        let mut objects = BTreeMap::new();
        for entry in &self.entries {
            super::file_index::safe_path(&entry.name)?;
            if let Some(size) = objects.insert(entry.sha256.clone(), entry.bytes)
                && size != entry.bytes
            {
                return Err("附件内容大小不一致 / Inconsistent attachment sizes".into());
            }
        }
        Ok(objects)
    }
}
struct Owner<'a>(&'a Manager);
impl Drop for Owner<'_> {
    fn drop(&mut self) {
        self.0.stop.store(true, Ordering::SeqCst);
        *self.0.media_owner.lock().unwrap() = None;
    }
}
impl Manager {
    async fn allowed_media_content(&self, bytes: &[u8]) -> Result<()> {
        let text = Zeroizing::new(String::from_utf8_lossy(bytes).into_owned());
        self.storage
            .call(move |s| s.extension_content_allowed(&text))
            .await
            .map_err(|_| {
                "附件包含已配置凭据，未迁移 / Attachment contains a configured credential".into()
            })
    }
    fn check_media_stop(&self) -> Result<()> {
        if self.stop.load(Ordering::SeqCst) {
            Err("附件迁移已取消 / Attachment transfer cancelled".into())
        } else {
            Ok(())
        }
    }
    pub async fn handle_media(
        &self,
        task: String,
        action: MediaTransferAction,
        media: &crate::media::Manager,
    ) -> Result<Value> {
        action.validate().map_err(str::to_owned)?;
        if matches!(action, MediaTransferAction::Cancel) {
            let owned = self.media_owner.lock().unwrap().as_deref() == Some(&task);
            if owned {
                self.stop.store(true, Ordering::SeqCst);
            }
            return Ok(json!({"cancel_requested":owned}));
        }
        let _gate = self.begin()?;
        *self.media_owner.lock().unwrap() = Some(task.clone());
        let _owner = Owner(self);
        let mut work = Box::pin(self.media_transfer_inner(task, action, media));
        tokio::select! {
            result = &mut work => result,
            _ = tokio::time::sleep(std::time::Duration::from_secs(90)) => {
                self.stop.store(true,Ordering::SeqCst);
                // Await cancellation cleanup; a committed result remains a successful result.
                match work.await {
                    Ok(result) if matches!(result["kind"].as_str(),Some("imported"|"exported")) => Ok(result),
                    _ => Err("附件处理超过 90 秒，已停止；请减少所选数量 / Attachment transfer timed out; select fewer files".into()),
                }
            }
        }
    }
    async fn media_transfer_inner(
        &self,
        task: String,
        action: MediaTransferAction,
        media: &crate::media::Manager,
    ) -> Result<Value> {
        let vault = Vault::open(&self.data)?;
        if let MediaTransferAction::Export {
            asset_ids,
            path,
            password,
        } = action
        {
            let (t, ids) = (task.clone(), asset_ids.clone());
            let assets = self
                .storage
                .call(move |s| s.export_media_rows(&t, &ids))
                .await
                .map_err(|e| e.to_string())?;
            let bundle = MediaTransferBundle {
                version: 1,
                archive_id: uuid::Uuid::new_v4().to_string(),
                created_at_ms: workpilot_storage::now_ms(),
                entries: assets
                    .iter()
                    .map(|a| MediaTransferEntry {
                        id: a.id.clone(),
                        task_id: task.clone(),
                        name: a.name.clone(),
                        source: a.source.clone(),
                        at_ms: a.at_ms,
                        bytes: a.bytes,
                        sha256: a.sha256.clone(),
                        path: a.path.clone(),
                        operation_id: a.operation_id.clone(),
                        origin: a.origin.clone(),
                    })
                    .collect(),
            };
            bundle.objects()?;
            for asset in &assets {
                self.check_media_stop()?;
                let id = asset.id.clone();
                let (_, original, parsed) = self
                    .storage
                    .call(move |s| s.media_asset(&id))
                    .await
                    .map_err(|e| e.to_string())?;
                let bytes = Zeroizing::new(vault.read(&original)?);
                if bytes.len() as u64 != asset.bytes || codec::digest(&bytes) != asset.sha256 {
                    return Err("附件原内容校验失败 / Attachment checksum mismatch".into());
                }
                self.allowed_media_content(&bytes).await?;
                self.allowed_media_content(&Zeroizing::new(vault.read(&parsed)?))
                    .await?;
            }
            let destination = PathBuf::from(&path);
            let parent = destination.parent().ok_or("Invalid archive destination")?;
            codec::plain(parent, true)?;
            if destination.file_name().is_none() || destination.exists() {
                return Err(
                    "保存位置已存在，请选择新文件名 / Choose a new archive filename".into(),
                );
            }
            let mut temporary = tempfile::NamedTempFile::new_in(parent)
                .map_err(|_| "Cannot create attachment archive")?;
            codec::write_index(&mut temporary, &password.0, &bundle, &self.stop, |sha| {
                vault.read(sha)
            })?;
            temporary
                .flush()
                .and_then(|_| temporary.as_file().sync_all())
                .map_err(|_| "Cannot finish attachment archive")?;
            let fresh = self
                .storage
                .call(move |s| s.export_media_rows(&task, &asset_ids))
                .await
                .map_err(|e| e.to_string())?;
            if serde_json::to_value(fresh).ok() != serde_json::to_value(&assets).ok() {
                return Err("原附件记录已变化，请重新选择 / Attachment selection changed".into());
            }
            codec::plain(parent, true)?;
            self.check_media_stop()?;
            temporary
                .persist_noclobber(&destination)
                .map_err(|_| "Archive destination changed")?;
            return Ok(
                json!({"kind":"exported","archive_id":bundle.archive_id,"assets":bundle.entries.len(),"bytes":bundle.entries.iter().map(|e|e.bytes).sum::<u64>()}),
            );
        }
        let (path, password, prefix, confirmed) = match action {
            MediaTransferAction::Inspect {
                path,
                password,
                name_prefix,
            } => (path, password, name_prefix, None),
            MediaTransferAction::Import {
                path,
                password,
                name_prefix,
                fingerprint,
            } => (path, password, name_prefix, Some(fingerprint)),
            _ => unreachable!(),
        };
        let (bundle, digest) = codec::read_index::<MediaTransferBundle>(
            open(&path)?,
            &password.0,
            &self.stop,
            |sha, bytes| {
                if vault.put(bytes)? != sha {
                    return Err("Attachment staging checksum mismatch".into());
                }
                Ok(())
            },
        )?;
        let (t, b, d, p) = (task.clone(), bundle.clone(), digest.clone(), prefix.clone());
        let expected = self
            .storage
            .call(move |s| s.media_transfer_preview(&t, &b, &d, &p))
            .await
            .map_err(|e| e.to_string())?;
        let mut candidates = vec![];
        let mut entries = vec![];
        for item in &bundle.entries {
            self.check_media_stop()?;
            let bytes = Zeroizing::new(vault.read(&item.sha256)?);
            self.allowed_media_content(&bytes).await?;
            let name = format!("{prefix}{}", item.name);
            if !media_transfer_name(&name) {
                return Err("导入名称太长或无效 / Invalid imported name".into());
            }
            // Existing receipt needs no parser or runtime replay.
            if expected["already_imported"] != true
                && expected["conflicts"].as_array().is_some_and(Vec::is_empty)
            {
                let candidate = media
                    .prepare_transferred_asset(
                        &task,
                        &name,
                        &bytes,
                        bundle.origin(item),
                        self.stop.clone(),
                    )
                    .await?;
                entries.push(json!({"source_id":item.id,"source_name":item.name,"name":name,"bytes":item.bytes,"media_type":candidate.asset.media_type,"units":candidate.asset.units,"image":candidate.asset.image,"warnings":candidate.asset.warnings,"source":bundle.origin(item),"parsed_blob":candidate.parsed_blob}));
                candidates.push(candidate);
            } else {
                entries.push(json!({"source_id":item.id,"source_name":item.name,"name":name,"bytes":item.bytes,"source":bundle.origin(item)}));
            }
        }
        let fingerprint = codec::digest(
            json!([task, digest, prefix, expected, entries])
                .to_string()
                .as_bytes(),
        );
        self.check_media_stop()?;
        if let Some(confirmed) = confirmed {
            if expected["already_imported"] != true && confirmed != fingerprint {
                return Err("附件、目标或解析结果已变化，请重新预览 / Attachment preview changed; preview again".into());
            }
            let batch = MediaImportBatch {
                bundle,
                digest,
                name_prefix: prefix,
                candidates,
                expected: expected.clone(),
            };
            let stop = self.stop.clone();
            let receipt = self
                .storage
                .call(move |s| s.import_media_rows(&task, &batch, &stop))
                .await
                .map_err(|e| e.to_string())?;
            return Ok(
                json!({"kind":"imported","duplicate":expected["already_imported"],"receipt":receipt}),
            );
        }
        // Recheck destination after parsing before exposing an actionable preview.
        let (t, b, d, p) = (task.clone(), bundle.clone(), digest.clone(), prefix.clone());
        let fresh = self
            .storage
            .call(move |s| s.media_transfer_preview(&t, &b, &d, &p))
            .await
            .map_err(|e| e.to_string())?;
        if fresh != expected {
            return Err("目标任务已变化，请重新预览 / Target task changed; preview again".into());
        }
        for entry in &mut entries {
            entry.as_object_mut().unwrap().remove("parsed_blob");
        }
        Ok(
            json!({"kind":"preview","fingerprint":fingerprint,"archive_id":bundle.archive_id,"entries":entries,"already_imported":expected["already_imported"],"receipt":expected["receipt"],"conflicts":expected["conflicts"],"same_names":expected["same_names"],"project_files_written":false}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn bundle(name: &str) -> MediaTransferBundle {
        MediaTransferBundle {
            version: 1,
            archive_id: uuid::Uuid::new_v4().to_string(),
            created_at_ms: 1,
            entries: vec![MediaTransferEntry {
                id: "asset".into(),
                task_id: "task".into(),
                name: name.into(),
                source: "file".into(),
                at_ms: 1,
                bytes: 3,
                sha256: codec::digest(b"abc"),
                path: None,
                operation_id: None,
                origin: None,
            }],
        }
    }
    #[test]
    fn media_archive_authenticates_originals_and_rejects_bad_names_and_limits() {
        let stop = AtomicBool::new(false);
        let mut bytes = vec![];
        codec::write_index(
            &mut bytes,
            "fixture passphrase",
            &bundle("资料.txt"),
            &stop,
            |_| Ok(b"abc".to_vec()),
        )
        .unwrap();
        let mut original = vec![];
        codec::read_index::<MediaTransferBundle>(
            &bytes[..],
            "fixture passphrase",
            &stop,
            |_, b| {
                original.extend_from_slice(b);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(original, b"abc");
        assert!(
            codec::read_index::<MediaTransferBundle>(
                &bytes[..],
                "wrong passphrase",
                &stop,
                |_, _| Ok(())
            )
            .is_err()
        );
        assert!(codec::read(&bytes[..], "fixture passphrase", &stop, |_, _| Ok(())).is_err());
        *bytes.last_mut().unwrap() ^= 1;
        assert!(
            codec::read_index::<MediaTransferBundle>(
                &bytes[..],
                "fixture passphrase",
                &stop,
                |_, _| Ok(())
            )
            .is_err()
        );
        for name in ["../bad.txt", "folder/file.txt", ".env", "key.pem"] {
            assert!(bundle(name).objects().is_err());
        }
        let mut bad = bundle("file.txt");
        bad.entries[0].bytes = 33 * 1024 * 1024;
        assert!(bad.objects().is_err());
        let mut bad = bundle("file.txt");
        bad.entries.push(bad.entries[0].clone());
        assert!(bad.objects().is_err());
    }
}
