//! Only revisions owned by the selected task are portable. Export never opens project paths.
use super::*;

impl Store {
    pub fn task_archive_file_history_rows(&self, task: &str) -> Result<Vec<FileRevision>> {
        let mut q=self.connection.prepare("SELECT id,root_identity,path,operation_id,data_json FROM file_revisions WHERE task_id=?1 ORDER BY rowid LIMIT 129")?;
        let mut rows = q
            .query_map([task], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })?
            .map(|r| {
                let (id, root, path, operation, raw) = r?;
                let revision: FileRevision = serde_json::from_str(&raw)?;
                if revision.id != id
                    || revision.root_identity != root
                    || revision.task_id != task
                    || revision.path != path
                    || revision.operation_id != operation
                {
                    return Err(Error::Corrupt("file revision ownership"));
                }
                Ok(revision)
            })
            .collect::<Result<Vec<_>>>()?;
        let mut legacy=self.connection.prepare("SELECT action_id,root_identity,path,before_json,after_json,before_object_id,after_object_id FROM managed_file_changes WHERE task_id=?1 AND after_json IS NOT NULL AND action_id NOT IN (SELECT operation_id FROM file_revisions) ORDER BY rowid LIMIT 129")?;
        let extra = legacy
            .query_map([task], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, String>(6)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for (operation, root, path, before, after, old, new) in extra {
            let before: FileVersion = serde_json::from_str(&before)?;
            let after: FileVersion = serde_json::from_str(&after)?;
            let at_ms=self.connection.query_row("SELECT at_ms FROM events WHERE task_id=?1 AND json_extract(payload_json,'$.change.action_id')=?2 ORDER BY sequence DESC LIMIT 1",params![task,operation],|r|r.get::<_,u64>(0)).optional()?.unwrap_or(0);
            rows.push(FileRevision {
                id: format!("managed-{}", digest(operation.as_bytes())),
                task_id: task.into(),
                operation_id: operation,
                root_identity: root,
                path,
                previous_path: None,
                change: if before.exists { "modified" } else { "created" }.into(),
                source: "write_file".into(),
                at_ms,
                before: FileImage {
                    version: before,
                    blob: old.map(|id| format!("legacy:{id}")),
                },
                after: FileImage {
                    version: after,
                    blob: Some(format!("legacy:{new}")),
                },
                origin: None,
            });
        }
        if rows.len() > 128 {
            return Err(Error::Invalid(
                "文件历史超过 128 条，未截断 / Task history exceeds 128 revisions; nothing was truncated",
            ));
        }
        for r in &rows {
            TaskArchiveHistory::from_revision(r)
                .validate()
                .map_err(Error::Invalid)?;
        }
        Ok(rows)
    }
    pub fn task_archive_index(&self, archive: &str) -> Result<TaskArchiveIndex> {
        self.saved_task_archive(archive)
    }
}
