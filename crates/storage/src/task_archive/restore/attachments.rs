//! Reparsed attachment candidates and task-scoped history aliases, never global IDs.
use super::*;

#[derive(Clone)]
pub struct TaskRestoreMedia {
    pub source_id: String,
    pub source_task_id: String,
    pub candidate: MediaImportCandidate,
    pub removed: bool,
}

impl Store {
    pub fn task_restore_media_preview(
        &self,
        archive: &str,
        mut preview: Value,
        media: &[TaskRestoreMedia],
    ) -> Result<Value> {
        if preview["already_restored"] == true {
            return Ok(preview);
        }
        let index = self.saved_task_archive(archive)?;
        let base = preview["fingerprint"]
            .as_str()
            .ok_or(Error::Invalid("missing restore preview"))?;
        preview["fingerprint"] = json!(self.restore_media_fingerprint(&index, base, media)?);
        preview["attachments"]=json!(index.media.iter().zip(media).map(|(old,m)|json!({"source_task_id":old.entry.task_id,"name":old.entry.name,"bytes":old.entry.bytes,"removed":old.removed,"source":old.entry.source,"media_type":m.candidate.asset.media_type,"units":m.candidate.asset.units,"warnings":m.candidate.asset.warnings})).collect::<Vec<_>>());
        Ok(preview)
    }
    pub(super) fn restore_media_fingerprint(
        &self,
        index: &TaskArchiveIndex,
        base: &str,
        media: &[TaskRestoreMedia],
    ) -> Result<String> {
        if index.media.len() != media.len() {
            return Err(Error::Invalid(
                "请核验档案附件原文 / Verify archive attachment originals first",
            ));
        }
        if media.is_empty() {
            return Ok(base.into());
        }
        let mut ids = HashSet::new();
        let mut proof = vec![];
        for (old, m) in index.media.iter().zip(media) {
            let e = &old.entry;
            let c = &m.candidate;
            let a = &c.asset;
            let origin = e.origin.clone().unwrap_or_else(|| MediaAssetOrigin {
                archive_id: index.archive_id.clone(),
                asset_id: e.id.clone(),
                task_id: e.task_id.clone(),
                name: e.name.clone(),
                source: e.source.clone(),
                at_ms: e.at_ms,
                path: e.path.clone(),
                operation_id: e.operation_id.clone(),
            });
            if m.source_id != e.id
                || m.source_task_id != e.task_id
                || m.removed != old.removed
                || !valid_id(&a.id)
                || !ids.insert(&a.id)
                || a.id == e.id
                || a.task_id.as_deref() != Some(&e.task_id)
                || a.name != e.name
                || a.bytes != e.bytes
                || a.sha256 != e.sha256
                || c.original_blob != e.sha256
                || !checksum(&c.parsed_blob)
                || a.source != "file"
                || a.path.is_some()
                || a.version.is_some()
                || a.operation_id.is_some()
                || serde_json::to_value(&a.origin)? != serde_json::to_value(Some(origin))?
            {
                return Err(Error::Invalid(
                    "附件映射不完整或已变化 / Inconsistent attachment mapping",
                ));
            }
            proof.push(json!([
                e.id,
                c.parsed_blob,
                a.media_type,
                a.units,
                a.image,
                a.warnings
            ]));
        }
        let count: u32 = self.connection.query_row(
            "SELECT count(*) FROM media_assets WHERE removed=0",
            [],
            |r| r.get(0),
        )?;
        if count + media.iter().filter(|m| !m.removed).count() as u32 > 10000 {
            return Err(Error::Invalid(
                "附件库超过 10000 项 / Attachment library limit exceeded",
            ));
        }
        Ok(digest(&serde_json::to_vec(&json!([base, proof, count]))?))
    }
    pub fn restored_media_id(&self, task: &str, asset: &str) -> Result<String> {
        Ok(self
            .restored_history(task)?
            .and_then(|h| h.media_ids.get(asset).cloned())
            .unwrap_or_else(|| asset.into()))
    }
    pub fn restored_media_references(&self, task: &str, text: &str) -> Result<String> {
        let mut result = text.to_owned();
        if let Some(history) = self.restored_history(task)? {
            for (old, new) in history.media_ids {
                if text.contains(&format!("[workpilot-file:{old}]")) {
                    result.push_str(&format!("\n[workpilot-file:{new}]"));
                }
            }
        }
        Ok(result)
    }
}

pub(super) fn validate_references(
    index: &TaskArchiveIndex,
    snapshot: &TaskArchiveSnapshot,
    task: &str,
    history: &HistoricalData,
    texts: &[String],
    store: &Store,
) -> Result<()> {
    if history.media_ids.len()
        + index
            .media
            .iter()
            .filter(|m| m.entry.task_id == task)
            .count()
        > 1024
    {
        return Err(Error::Invalid(
            "附件来源映射超过容量 / Too many historical attachment identities",
        ));
    }
    for (old, current) in &history.media_ids {
        if !valid_id(old)
            || !index
                .media
                .iter()
                .any(|m| m.entry.id == *current && m.entry.task_id == task)
        {
            return Err(Error::Invalid("foreign historical attachment mapping"));
        }
    }
    // Inherited directions can mention ancestor attachments. They do not grant
    // the child access; aliases are installed only for its own saved assets.
    let mut allowed = HashSet::new();
    let mut current = Some(task);
    let mut visited = HashSet::new();
    while let Some(task) = current {
        if !visited.insert(task) {
            return Err(Error::Invalid("cyclic attachment ancestry"));
        }
        for m in index.media.iter().filter(|m| m.entry.task_id == task) {
            allowed.insert(m.entry.id.clone());
        }
        for event in &snapshot.tables["events"] {
            if event["task_id"] != task || event["payload_json"]["kind"] != "task_restored" {
                continue;
            }
            let r: ContentRef = serde_json::from_value(event["payload_json"]["history"].clone())?;
            if !index.objects.contains(&r) {
                return Err(Error::Invalid("foreign attachment ancestry"));
            }
            let prior: HistoricalData = store.read_json(&r)?;
            if prior.media_ids.len() > 1024
                || prior.media_ids.iter().any(|(old, new)| {
                    !valid_id(old)
                        || !index
                            .media
                            .iter()
                            .any(|m| m.entry.task_id == task && m.entry.id == *new)
                })
            {
                return Err(Error::Invalid("foreign ancestor attachment mapping"));
            }
            allowed.extend(prior.media_ids.into_keys());
        }
        current = index
            .tasks
            .iter()
            .find(|t| t.id == task)
            .and_then(|t| t.parent_task_id.as_deref());
    }
    allowed.extend(history.media_ids.keys().cloned());
    for text in texts {
        for rest in text.split("[workpilot-file:").skip(1) {
            let reference = rest
                .split_once(']')
                .map(|r| r.0)
                .ok_or(Error::Invalid("invalid attachment marker"))?;
            if !allowed.contains(reference) {
                return Err(Error::Invalid(
                    "历史消息中的附件缺失 / Historical message references a missing attachment",
                ));
            }
        }
    }
    Ok(())
}
