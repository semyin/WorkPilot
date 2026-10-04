//! One transaction binds immutable attachment copies, provenance and the import receipt.
use super::*;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone)]
pub struct MediaImportCandidate {
    pub asset: MediaAsset,
    pub original_blob: String,
    pub parsed_blob: String,
}
pub struct MediaImportBatch {
    pub bundle: MediaTransferBundle,
    pub digest: String,
    pub name_prefix: String,
    pub candidates: Vec<MediaImportCandidate>,
    pub expected: Value,
}
fn key(archive: &str, task: &str) -> String {
    format!(
        "media-import:{:x}",
        Sha256::digest(json!([archive, task]).to_string().as_bytes())
    )
}
fn task_state(connection: &Connection, task: &str) -> Result<Value> {
    let raw: String = connection.query_row(
        "SELECT json_object('id',t.id,'title',t.title,'state',t.state,'mode',t.mode,'sequence',t.last_sequence,'project',t.project_id,'archived',root.archived) FROM tasks t LEFT JOIN team_members m ON m.task_id=t.id JOIN tasks root ON root.id=COALESCE(m.root_task_id,t.id) WHERE t.id=?1 AND EXISTS(SELECT 1 FROM execution_sessions e WHERE e.task_id=t.id)",
        [task], |r| r.get(0)).optional()?.ok_or(Error::NotFound)?;
    Ok(serde_json::from_str(&raw)?)
}
fn preview(
    connection: &Connection,
    task: &str,
    bundle: &MediaTransferBundle,
    digest: &str,
    prefix: &str,
) -> Result<Value> {
    bundle.validate().map_err(Error::Invalid)?;
    if !checksum(digest)
        || !valid_id(task)
        || bundle
            .entries
            .iter()
            .any(|e| !media_transfer_name(&format!("{prefix}{}", e.name)))
    {
        return Err(Error::Invalid("invalid attachment target"));
    }
    let task_state = task_state(connection, task)?;
    let old: Option<String> = connection
        .query_row(
            "SELECT value_json FROM settings WHERE key=?1",
            [key(&bundle.archive_id, task)],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(old) = old {
        let receipt: Value = serde_json::from_str(&old)?;
        if receipt["digest"] != digest {
            return Err(Error::Conflict);
        }
        return Ok(
            json!({"already_imported":true,"receipt":receipt,"conflicts":[],"same_names":[]}),
        );
    }
    let count: u64 = connection.query_row(
        "SELECT count(*) FROM media_assets WHERE removed=0",
        [],
        |r| r.get(0),
    )?;
    let mut query = connection
        .prepare("SELECT id,data_json,removed FROM media_assets WHERE task_id=?1 ORDER BY id")?;
    let rows = query
        .query_map([task], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, bool>(2)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut names = std::collections::HashSet::new();
    for (_, raw, removed) in &rows {
        if !removed {
            names.insert(serde_json::from_str::<MediaAsset>(raw)?.name.to_lowercase());
        }
    }
    let mut same_names = Vec::new();
    for item in &bundle.entries {
        let name = format!("{prefix}{}", item.name);
        if !names.insert(name.to_lowercase()) {
            same_names.push(name);
        }
    }
    let mut conflicts = vec![];
    if task_state["archived"] == 1 {
        conflicts.push("归档任务只能查看 / Archived tasks are read-only");
    }
    let active: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM workbench_operations WHERE task_id=?1 AND json_extract(data_json,'$.state') IN ('queued','running','stopping'))",[task],|r|r.get(0))?;
    let queued_run: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM runs WHERE task_id=?1 AND state IN ('queued','running'))",
        [task],
        |r| r.get(0),
    )?;
    if active || queued_run || matches!(task_state["state"].as_str(), Some("running" | "stopping"))
    {
        conflicts.push("请先停止任务及文件操作 / Stop the task and file operations first");
    }
    if count + bundle.entries.len() as u64 > 10000 {
        conflicts.push("附件库将超过 10000 项 / Attachment library limit would be exceeded");
    }
    let state = format!(
        "{:x}",
        Sha256::digest(json!([task_state, rows, count]).to_string().as_bytes())
    );
    Ok(
        json!({"already_imported":false,"conflicts":conflicts,"same_names":same_names,"state":state}),
    )
}
impl Store {
    pub fn export_media_rows(&self, task: &str, ids: &[String]) -> Result<Vec<MediaAsset>> {
        self.execution_snapshot(task)?;
        if ids.is_empty()
            || ids.len() > 64
            || ids.iter().collect::<std::collections::HashSet<_>>().len() != ids.len()
        {
            return Err(Error::Invalid("invalid attachment selection"));
        }
        ids.iter()
            .map(|id| {
                let asset = self.media_asset(id)?.0;
                if asset.task_id.as_deref() != Some(task) {
                    return Err(Error::Invalid(
                        "附件不属于当前任务 / Attachment belongs to another task",
                    ));
                }
                if self.redactor.contains_registered_secret(&encode(&asset)?) {
                    return Err(Error::Invalid(
                        "attachment metadata contains a configured credential",
                    ));
                }
                Ok(asset)
            })
            .collect()
    }
    pub fn media_transfer_preview(
        &self,
        task: &str,
        bundle: &MediaTransferBundle,
        digest: &str,
        prefix: &str,
    ) -> Result<Value> {
        if self.redactor.contains_registered_secret(&encode(bundle)?)
            || self.redactor.contains_registered_secret(prefix)
        {
            return Err(Error::Invalid(
                "attachment metadata contains a configured credential",
            ));
        }
        preview(&self.connection, task, bundle, digest, prefix)
    }
    pub fn import_media_rows(
        &mut self,
        task: &str,
        batch: &MediaImportBatch,
        stop: &AtomicBool,
    ) -> Result<Value> {
        let MediaImportBatch {
            bundle,
            digest,
            name_prefix: prefix,
            candidates,
            expected,
        } = batch;
        if self.redactor.contains_registered_secret(&encode(bundle)?)
            || self.redactor.contains_registered_secret(prefix)
        {
            return Err(Error::Invalid(
                "attachment metadata contains a configured credential",
            ));
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = preview(&tx, task, bundle, digest, prefix)?;
        if current["already_imported"] == true {
            return Ok(current["receipt"].clone());
        }
        if &current != expected
            || current["conflicts"]
                .as_array()
                .is_none_or(|a| !a.is_empty())
            || candidates.len() != bundle.entries.len()
        {
            return Err(Error::Conflict);
        }
        let mut mappings = vec![];
        for (candidate, source) in candidates.iter().zip(&bundle.entries) {
            if stop.load(Ordering::SeqCst) {
                return Err(Error::Invalid(
                    "附件导入已取消 / Attachment import cancelled",
                ));
            }
            let a = &candidate.asset;
            if !valid_id(&a.id)
                || a.id == source.id
                || a.task_id.as_deref() != Some(task)
                || a.source != "file"
                || a.path.is_some()
                || a.version.is_some()
                || a.operation_id.is_some()
                || a.name != format!("{prefix}{}", source.name)
                || a.bytes != source.bytes
                || a.sha256 != source.sha256
                || candidate.original_blob != source.sha256
                || !checksum(&candidate.parsed_blob)
                || encode(&a.origin)? != encode(&Some(bundle.origin(source)))?
            {
                return Err(Error::Invalid("invalid attachment mapping"));
            }
            tx.execute("INSERT INTO media_assets(id,task_id,data_json,original_blob,parsed_blob) VALUES(?1,?2,?3,?4,?5)",params![a.id,task,encode(a)?,candidate.original_blob,candidate.parsed_blob])?;
            mappings.push(json!({"source_asset_id":source.id,"source_task_id":source.task_id,"asset_id":a.id,"name":a.name,"sha256":a.sha256}));
        }
        let receipt = json!({"archive_id":bundle.archive_id,"digest":digest,"task_id":task,"at_ms":now_ms(),"assets":mappings,"name_prefix":prefix,"project_files_written":false});
        tx.execute(
            "INSERT INTO settings(key,value_json) VALUES(?1,?2)",
            params![key(&bundle.archive_id, task), encode(&receipt)?],
        )?;
        if stop.load(Ordering::SeqCst) {
            return Err(Error::Invalid(
                "附件导入已取消 / Attachment import cancelled",
            ));
        }
        tx.commit()?;
        Ok(receipt)
    }
}
