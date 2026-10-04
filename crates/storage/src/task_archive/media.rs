use super::*;

impl Store {
    pub(super) fn task_archive_media_rows(&self, task: &str) -> Result<Vec<TaskArchiveMedia>> {
        let mut q = self.connection.prepare(
            "SELECT data_json,removed FROM media_assets WHERE task_id=?1 ORDER BY rowid LIMIT 65",
        )?;
        let rows = q
            .query_map([task], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(raw, removed)| {
                let a: MediaAsset = serde_json::from_str(&raw)?;
                if a.task_id.as_deref() != Some(task) {
                    return Err(Error::Corrupt("attachment ownership"));
                }
                Ok(TaskArchiveMedia {
                    entry: MediaTransferEntry {
                        id: a.id,
                        task_id: task.into(),
                        name: a.name,
                        source: a.source,
                        at_ms: a.at_ms,
                        bytes: a.bytes,
                        sha256: a.sha256,
                        path: a.path,
                        operation_id: a.operation_id,
                        origin: a.origin,
                    },
                    removed,
                })
            })
            .collect()
    }
    pub fn archived_media_original(&self, id: &str) -> Result<(String, String)> {
        self.connection
            .query_row(
                "SELECT original_blob,parsed_blob FROM media_assets WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or(Error::NotFound)
    }
    pub fn task_archive_media(&self, archive: &str) -> Result<Vec<TaskArchiveMedia>> {
        Ok(self.saved_task_archive(archive)?.media)
    }
}
