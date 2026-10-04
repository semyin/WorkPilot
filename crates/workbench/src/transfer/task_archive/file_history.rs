//! Verify/re-encrypt saved versions; restoring history never writes project files.
use super::*;
use zeroize::Zeroizing;

impl Manager {
    pub(in crate::transfer) async fn verify_archive_history(
        &self,
        index: &TaskArchiveIndex,
        source: bool,
    ) -> Result<()> {
        if index.file_history.is_empty() {
            return Ok(());
        }
        let vault = Vault::open(&self.data)?;
        let mut original = BTreeMap::new();
        if source {
            for task in &index.tasks {
                let t = task.id.clone();
                for r in self
                    .storage
                    .call(move |s| s.task_archive_file_history_rows(&t))
                    .await
                    .map_err(|e| e.to_string())?
                {
                    original.insert(r.id.clone(), r);
                }
            }
        }
        for item in &index.file_history {
            if self.stop.load(Ordering::SeqCst) {
                return Err("档案操作已取消 / Archive cancelled".into());
            }
            let r = &item.revision;
            let saved = if source {
                let saved = original
                    .get(&r.id)
                    .ok_or("来源文件历史缺失 / Missing source history")?;
                if serde_json::to_value(TaskArchiveHistory::from_revision(saved))
                    .map_err(|e| e.to_string())?
                    != serde_json::to_value(item).map_err(|e| e.to_string())?
                {
                    return Err("文件历史已变化 / File history changed".into());
                }
                Some(saved)
            } else {
                None
            };
            for (image, original) in [
                (&r.before, saved.map(|r| &r.before)),
                (&r.after, saved.map(|r| &r.after)),
            ] {
                if let Some(sha) = &image.sha256 {
                    let bytes = Zeroizing::new(if let Some(original) = original {
                        history::image_bytes(&self.storage, &vault, original).await?
                    } else {
                        vault.read(sha)?
                    });
                    self.check_history_image(image, &bytes).await?;
                    // Legacy text revisions move into the same encrypted vault without
                    // changing source history rows or reading the old project folder.
                    if source && vault.put(&bytes)? != *sha {
                        return Err("History checksum mismatch".into());
                    }
                }
            }
        }
        Ok(())
    }
    async fn check_history_image(&self, image: &PortableFileImage, bytes: &[u8]) -> Result<()> {
        if bytes.len() as u64 != image.bytes || Some(codec::digest(bytes)) != image.sha256 {
            return Err("历史原文不完整或校验不符 / File history checksum mismatch".into());
        }
        self.allowed_media_content(bytes).await.map_err(|_| {
            "文件历史包含已登记凭据，未迁移 / File history contains a configured credential".into()
        })
    }
    pub(in crate::transfer) async fn import_archive_history(
        &self,
        index: &TaskArchiveIndex,
        blobs: &BTreeMap<String, Vec<u8>>,
        commit: bool,
    ) -> Result<()> {
        if index.file_history.is_empty() {
            return Ok(());
        }
        let vault = commit.then(|| Vault::open(&self.data)).transpose()?;
        let mut seen = std::collections::HashSet::new();
        for item in &index.file_history {
            for image in [&item.revision.before, &item.revision.after] {
                if let Some(sha) = &image.sha256 {
                    if !seen.insert(sha) {
                        continue;
                    }
                    if self.stop.load(Ordering::SeqCst) {
                        return Err("档案操作已取消 / Archive cancelled".into());
                    }
                    let bytes = blobs
                        .get(sha)
                        .ok_or("历史原文缺失 / Missing file history image")?;
                    self.check_history_image(image, bytes).await?;
                    if let Some(vault) = &vault {
                        vault.put(bytes)?;
                    }
                }
            }
        }
        Ok(())
    }
    pub(in crate::transfer) async fn verify_restoration_history(
        &self,
        archive: &str,
        preview: &Value,
    ) -> Result<()> {
        if preview["already_restored"] == true {
            return Ok(());
        }
        let a = archive.to_owned();
        let index = self
            .storage
            .call(move |s| s.task_archive_index(&a))
            .await
            .map_err(|e| e.to_string())?;
        self.verify_archive_history(&index, false).await
    }
}
