//! Reparse verified original bytes with the existing isolated worker; never trust parser caches from another app.
use super::*;
impl Manager {
    pub(crate) async fn prepare_transferred_asset(
        &self,
        task: &str,
        name: &str,
        bytes: &[u8],
        origin: MediaAssetOrigin,
        stop: Arc<AtomicBool>,
    ) -> Result<workpilot_storage::MediaImportCandidate> {
        let parsed = self
            .worker
            .run(
                &self.data,
                json!({"kind":"parse","name":name}),
                Some(bytes),
                stop.clone(),
            )
            .await?
            .report;
        if stop.load(Ordering::SeqCst) {
            return Err("附件迁移已取消 / Attachment transfer cancelled".into());
        }
        let text = zeroize::Zeroizing::new(parsed.to_string());
        self.storage
            .call(move |s| s.extension_content_allowed(&text))
            .await
            .map_err(|_| "附件内容包含已配置凭据 / Attachment contains a configured credential")?;
        let vault = Vault::open(&self.data)?;
        let original_blob = vault.put(bytes)?;
        let parsed_blob = vault.put(&serde_json::to_vec(&parsed).map_err(|e| e.to_string())?)?;
        let asset = MediaAsset {
            id: uuid::Uuid::new_v4().to_string(),
            task_id: Some(task.into()),
            name: name.into(),
            // Imported outputs need an explicit delivered attachment marker too.
            source: "file".into(),
            media_type: parsed["media_type"]
                .as_str()
                .ok_or("Invalid parsed media type")?
                .into(),
            bytes: bytes.len() as u64,
            sha256: original_blob.clone(),
            at_ms: workpilot_storage::now_ms(),
            units: parsed["units"].as_array().map_or(0, Vec::len) as u32,
            warnings: serde_json::from_value(parsed["warnings"].clone())
                .map_err(|e| e.to_string())?,
            image: serde_json::from_value(parsed["image"].clone()).map_err(|e| e.to_string())?,
            path: None,
            version: None,
            operation_id: None,
            origin: Some(origin),
        };
        Ok(workpilot_storage::MediaImportCandidate {
            asset,
            original_blob,
            parsed_blob,
        })
    }
}
