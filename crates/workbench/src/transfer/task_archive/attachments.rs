//! Attachment originals stay in the encrypted vault, separate from readable event objects.
use super::*;
use workpilot_storage::TaskRestoreMedia;
use zeroize::Zeroizing;

impl Manager {
    pub(in crate::transfer) async fn verify_archive_media(
        &self,
        index: &TaskArchiveIndex,
        source: bool,
    ) -> Result<()> {
        if index.media.is_empty() {
            return Ok(());
        }
        let vault = Vault::open(&self.data)?;
        for m in &index.media {
            if self.stop.load(Ordering::Relaxed) {
                return Err("档案操作已取消 / Archive cancelled".into());
            }
            let bytes = Zeroizing::new(vault.read(&m.entry.sha256)?);
            if bytes.len() as u64 != m.entry.bytes {
                return Err("附件原文不完整 / Incomplete attachment original".into());
            }
            self.allowed_media_content(&bytes).await?;
            if source {
                let id = m.entry.id.clone();
                let (original, parsed) = self
                    .storage
                    .call(move |s| s.archived_media_original(&id))
                    .await
                    .map_err(|e| e.to_string())?;
                if original != m.entry.sha256 {
                    return Err("附件已变化 / Attachment changed".into());
                }
                self.allowed_media_content(&Zeroizing::new(vault.read(&parsed)?))
                    .await?;
            }
        }
        Ok(())
    }
    pub(in crate::transfer) async fn import_archive_media(
        &self,
        index: &TaskArchiveIndex,
        blobs: &mut BTreeMap<String, Vec<u8>>,
        commit: bool,
    ) -> Result<()> {
        let vault = (!index.media.is_empty())
            .then(|| Vault::open(&self.data))
            .transpose()?;
        for m in &index.media {
            let bytes = blobs
                .get(&m.entry.sha256)
                .ok_or("附件原文缺失 / Missing attachment original")?;
            if bytes.len() as u64 != m.entry.bytes || codec::digest(bytes) != m.entry.sha256 {
                return Err("附件校验失败 / Attachment checksum mismatch".into());
            }
            self.allowed_media_content(bytes).await?;
            if self.stop.load(Ordering::Relaxed) {
                return Err("档案操作已取消 / Archive cancelled".into());
            }
            if commit {
                vault
                    .as_ref()
                    .ok_or("Missing attachment vault")?
                    .put(bytes)?;
            }
        }
        // Event objects retain their existing ownership rules. Arbitrary original
        // files are never installed in the plaintext conversation content store.
        blobs.retain(|id, _| index.objects.iter().any(|r| &r.object_id == id));
        Ok(())
    }
    pub(in crate::transfer) async fn prepare_archive_media(
        &self,
        archive: &str,
        media: &crate::media::Manager,
    ) -> Result<Vec<TaskRestoreMedia>> {
        let a = archive.to_owned();
        let entries = self
            .storage
            .call(move |s| s.task_archive_media(&a))
            .await
            .map_err(|e| e.to_string())?;
        if entries.is_empty() {
            return Ok(vec![]);
        }
        let vault = Vault::open(&self.data)?;
        let mut result = vec![];
        for item in entries {
            if self.stop.load(Ordering::Relaxed) {
                return Err("档案操作已取消 / Archive cancelled".into());
            }
            let e = &item.entry;
            let bytes = Zeroizing::new(vault.read(&e.sha256)?);
            if bytes.len() as u64 != e.bytes {
                return Err("附件原文不完整 / Incomplete attachment original".into());
            }
            self.allowed_media_content(&bytes).await?;
            let origin = e.origin.clone().unwrap_or_else(|| MediaAssetOrigin {
                archive_id: archive.into(),
                asset_id: e.id.clone(),
                task_id: e.task_id.clone(),
                name: e.name.clone(),
                source: e.source.clone(),
                at_ms: e.at_ms,
                path: e.path.clone(),
                operation_id: e.operation_id.clone(),
            });
            let candidate = media
                .prepare_transferred_asset(&e.task_id, &e.name, &bytes, origin, self.stop.clone())
                .await?;
            result.push(TaskRestoreMedia {
                source_id: e.id.clone(),
                source_task_id: e.task_id.clone(),
                candidate,
                removed: item.removed,
            });
        }
        Ok(result)
    }
}
