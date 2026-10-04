//! Immutable imported archives live outside tasks/runs/approvals. No scheduler
//! or model can discover them as actionable state.
mod export;
mod file_history;
mod media;
mod restore;
pub use restore::TaskRestoreMedia;
mod validate;
use super::*;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::atomic::{AtomicBool, Ordering},
};
use validate::{collect_refs, validate_bundle};

pub struct TaskArchiveBytes {
    pub index: TaskArchiveIndex,
    pub blobs: BTreeMap<String, Vec<u8>>,
}
pub fn task_archive_summary(index: &TaskArchiveIndex) -> Value {
    json!({"archive_id":index.archive_id,"created_at_ms":index.created_at_ms,
        "root_task_id":index.root_task_id,"tasks":index.tasks,"counts":index.counts,
        "objects":index.objects.len(),"bytes":index.objects.iter().map(|r|r.bytes).sum::<u64>(),
        "included_media":index.media.len(),"media_bytes":index.media.iter().map(|m|m.entry.bytes).sum::<u64>(),
        "included_file_revisions":index.file_history.len(),"history_bytes":index.file_history.iter().flat_map(|h|[&h.revision.before,&h.revision.after]).filter_map(|i|i.sha256.as_ref().map(|sha|(sha,i.bytes))).collect::<BTreeMap<_,_>>().values().sum::<u64>(),
        "excluded_media":index.excluded_media,"excluded_file_revisions":index.excluded_file_revisions})
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn check_stop(stop: &AtomicBool) -> Result<()> {
    if stop.load(Ordering::Relaxed) {
        Err(Error::Invalid(
            "档案操作已取消 / Archive operation cancelled",
        ))
    } else {
        Ok(())
    }
}
fn key(id: &str) -> String {
    format!("task-archive:{id}")
}
impl Store {
    pub fn task_archive_recovery_preview(&self, bundle: &TaskArchiveBytes) -> Result<Value> {
        self.validate_task_archive_bytes(bundle)?;
        restore::recovery_preview(bundle)
    }
    pub fn validate_task_archive_bytes(&self, bundle: &TaskArchiveBytes) -> Result<()> {
        validate_bundle(&bundle.index, &bundle.blobs)?;
        self.check_archive_secret(&serde_json::to_vec(&bundle.index)?)?;
        for bytes in bundle.blobs.values() {
            self.check_archive_secret(bytes)?;
        }
        Ok(())
    }
    fn check_archive_secret(&self, bytes: &[u8]) -> Result<()> {
        if self
            .redactor
            .contains_registered_secret(&String::from_utf8_lossy(bytes))
        {
            return Err(Error::Invalid(
                "档案包含已登记凭据，未保存 / Archive contains a configured credential",
            ));
        }
        Ok(())
    }
    pub fn task_archive_list(&self) -> Result<Value> {
        let mut query = self.connection.prepare("SELECT json_object('archive_id',json_extract(value_json,'$.index.archive_id'),'title',json_extract(value_json,'$.index.tasks[0].title'),'tasks',json_array_length(value_json,'$.index.tasks'),'imported_at_ms',json_extract(value_json,'$.imported_at_ms')) FROM settings WHERE key GLOB 'task-archive:*' ORDER BY json_extract(value_json,'$.imported_at_ms') DESC,key")?;
        let rows = query
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let summaries = rows
            .into_iter()
            .map(|raw| {
                let v: Value = serde_json::from_str(&raw)?;
                Ok(v)
            })
            .collect::<Result<Vec<Value>>>()?;
        Ok(json!({"kind":"archives","archives":summaries}))
    }
    pub fn task_archive_preview(
        &self,
        index: &TaskArchiveIndex,
        logical_digest: &str,
    ) -> Result<Value> {
        index.validate().map_err(Error::Invalid)?;
        let old: Option<String> = self
            .connection
            .query_row(
                "SELECT value_json FROM settings WHERE key=?1",
                [key(&index.archive_id)],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(raw) = old {
            let saved: Value = serde_json::from_str(&raw)?;
            if saved["logical_digest"] != logical_digest {
                return Err(Error::Conflict);
            }
            return Ok(json!({"already_imported":true,"imported_at_ms":saved["imported_at_ms"]}));
        }
        let count: u32 = self.connection.query_row(
            "SELECT count(*) FROM settings WHERE key GLOB 'task-archive:*'",
            [],
            |r| r.get(0),
        )?;
        if count >= 128 {
            return Err(Error::Invalid(
                "档案库已达到 128 份 / Archive library limit reached",
            ));
        }
        Ok(json!({"already_imported":false,"imported_at_ms":null}))
    }
    pub fn import_task_archive(
        &mut self,
        bundle: TaskArchiveBytes,
        logical_digest: &str,
        stop: &AtomicBool,
    ) -> Result<Value> {
        check_stop(stop)?;
        self.validate_task_archive_bytes(&bundle)?;
        if digest(&serde_json::to_vec(&bundle.index)?) != logical_digest {
            return Err(Error::Invalid("archive digest mismatch"));
        }
        let state = self.task_archive_preview(&bundle.index, logical_digest)?;
        if state["already_imported"] == true {
            return Ok(
                json!({"kind":"imported","duplicate":true,"archive_id":bundle.index.archive_id}),
            );
        }
        // Files are durable before metadata. A failure leaves at most unreferenced
        // immutable content, never a half-visible archive or any live task.
        for reference in &bundle.index.objects {
            check_stop(stop)?;
            objects::put_archive_bytes(
                &self.directory,
                &bundle.blobs[&reference.object_id],
                &reference.media_type,
            )?;
        }
        let receipt =
            json!({"index":bundle.index,"logical_digest":logical_digest,"imported_at_ms":now_ms()});
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        for reference in &bundle.index.objects {
            tx.execute(
                "INSERT OR IGNORE INTO objects(id,bytes,media_type) VALUES(?1,?2,?3)",
                params![reference.object_id, reference.bytes, reference.media_type],
            )?;
        }
        tx.execute(
            "INSERT INTO settings(key,value_json) VALUES(?1,?2)",
            params![key(&bundle.index.archive_id), encode(&receipt)?],
        )?;
        check_stop(stop)?;
        tx.commit()?;
        Ok(json!({"kind":"imported","duplicate":false,"archive_id":bundle.index.archive_id}))
    }
    fn saved_task_archive(&self, archive: &str) -> Result<TaskArchiveIndex> {
        if !valid_id(archive) {
            return Err(Error::Invalid("invalid archive identity"));
        }
        let raw: String = self
            .connection
            .query_row(
                "SELECT value_json FROM settings WHERE key=?1",
                [key(archive)],
                |r| r.get(0),
            )
            .optional()?
            .ok_or(Error::NotFound)?;
        let receipt: Value = serde_json::from_str(&raw)?;
        let index: TaskArchiveIndex = serde_json::from_value(receipt["index"].clone())?;
        index.validate().map_err(Error::Invalid)?;
        if digest(&serde_json::to_vec(&index)?) != receipt["logical_digest"] {
            return Err(Error::Corrupt("archive receipt digest"));
        }
        Ok(index)
    }
    pub fn read_task_archive(
        &mut self,
        archive: &str,
        table: &str,
        offset: u32,
        limit: u32,
    ) -> Result<Value> {
        TaskArchiveAction::Records {
            archive_id: archive.into(),
            table: table.into(),
            offset,
            limit,
        }
        .validate()
        .map_err(Error::Invalid)?;
        let index = self.saved_task_archive(archive)?;
        if table == "contents" {
            let records = index.objects.iter().enumerate().skip(offset as usize).take(limit as usize).map(|(i,r)|json!({"ordinal":i+1,"label":format!("{} · {} bytes",r.media_type,r.bytes),"task_id":null,"content":r})).collect::<Vec<_>>();
            return Ok(
                json!({"kind":"records","summary":task_archive_summary(&index),"table":table,"total":index.objects.len(),"next_offset":offset as usize+records.len(),"records":records}),
            );
        }
        let snapshot: TaskArchiveSnapshot = self.read_json(&index.snapshot)?;
        let rows = snapshot.tables.get(table).ok_or(Error::NotFound)?;
        let mut records = Vec::new();
        for (i, row) in rows
            .iter()
            .enumerate()
            .skip(offset as usize)
            .take(limit as usize)
        {
            let data = serde_json::to_vec(row)?;
            let reference = objects::put_archive_bytes(&self.directory, &data, "application/json")?;
            self.connection.execute(
                "INSERT OR IGNORE INTO objects(id,bytes,media_type) VALUES(?1,?2,?3)",
                params![reference.object_id, reference.bytes, reference.media_type],
            )?;
            let label = [
                "title",
                "name",
                "role",
                "member_key",
                "phase",
                "command_kind",
                "state",
            ]
            .iter()
            .filter_map(|k| row[*k].as_str())
            .collect::<Vec<_>>()
            .join(" · ");
            records.push(json!({"ordinal":i+1,"label":label.chars().take(200).collect::<String>(),"task_id":row["task_id"],"content":reference}));
        }
        Ok(
            json!({"kind":"records","summary":task_archive_summary(&index),"table":table,"total":rows.len(),"next_offset":offset as usize+records.len(),"records":records}),
        )
    }
    pub fn export_saved_task_archive(
        &self,
        archive: &str,
        stop: &AtomicBool,
    ) -> Result<TaskArchiveBytes> {
        let index = self.saved_task_archive(archive)?;
        let mut blobs = BTreeMap::new();
        for reference in &index.objects {
            check_stop(stop)?;
            objects::verify(&self.directory, reference)?;
            let bytes =
                std::fs::read(objects::object_path(&self.directory, &reference.object_id)?)?;
            self.check_archive_secret(&bytes)?;
            blobs.insert(reference.object_id.clone(), bytes);
        }
        validate_bundle(&index, &blobs)?;
        Ok(TaskArchiveBytes { index, blobs })
    }
}
