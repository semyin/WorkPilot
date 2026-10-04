//! Explicit table allowlist: never copy databases, credentials or live capabilities.
use super::*;
use rusqlite::types::ValueRef;

const TREE: &str = "WITH RECURSIVE tree(id) AS (SELECT ?1 UNION ALL SELECT m.task_id FROM team_members m JOIN tree t ON m.parent_task_id=t.id) ";
const TASKS: &str = "task_id IN (SELECT id FROM tree)";
const RUNS: &str = "run_id IN (SELECT id FROM runs WHERE task_id IN (SELECT id FROM tree))";
const ACTIONS: &str = "action_id IN (SELECT e.id FROM execution_steps e JOIN runs r ON r.id=e.run_id WHERE r.task_id IN (SELECT id FROM tree))";

fn filter(table: &str) -> &'static str {
    match table {
        "tasks" => "id IN (SELECT id FROM tree)",
        "execution_runs" | "execution_steps" => RUNS,
        "execution_checkpoints" | "controlled_effects" => {
            "session_id IN (SELECT id FROM execution_sessions WHERE task_id IN (SELECT id FROM tree))"
        }
        "execution_resolutions"
        | "team_action_receipts"
        | "tool_approval_objects"
        | "tool_result_objects" => ACTIONS,
        "team_dependencies" => "member_id IN (SELECT id FROM tree)",
        "workbench_output_objects" => {
            "operation_id IN (SELECT id FROM workbench_operations WHERE task_id IN (SELECT id FROM tree))"
        }
        "revisions" => {
            "artifact_id IN (SELECT id FROM artifacts WHERE task_id IN (SELECT id FROM tree))"
        }
        "event_objects" => {
            "event_sequence IN (SELECT sequence FROM events WHERE task_id IN (SELECT id FROM tree))"
        }
        _ => TASKS,
    }
}
fn rows(store: &Store, root: &str, table: &str, stop: &AtomicBool) -> Result<Vec<Value>> {
    // `table` comes exclusively from the compile-time list, never a SQL fragment from an archive.
    let mut query = store.connection.prepare(&format!(
        "{TREE}SELECT * FROM {table} WHERE {} ORDER BY rowid LIMIT 50001",
        filter(table)
    ))?;
    let columns = query
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let mut cursor = query.query([root])?;
    let mut values = Vec::new();
    let mut total_bytes = 0;
    while let Some(row) = cursor.next()? {
        check_stop(stop)?;
        let mut value = serde_json::Map::new();
        for (i, column) in columns.iter().enumerate() {
            let data = match row.get_ref(i)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(n) => json!(n),
                ValueRef::Real(_) | ValueRef::Blob(_) => {
                    return Err(Error::Invalid("unsupported archive column"));
                }
                ValueRef::Text(bytes) => {
                    let text = std::str::from_utf8(bytes)
                        .map_err(|_| Error::Invalid("record is not UTF-8"))?;
                    if column == "object_id" || column.ends_with("_object_id") {
                        serde_json::to_value(content_ref(&store.connection, text)?)?
                    } else if column.ends_with("_json") {
                        serde_json::from_str(text)?
                    } else {
                        Value::String(text.into())
                    }
                }
            };
            value.insert(column.clone(), data);
        }
        let mut value = Value::Object(value);
        remove_credential_locators(&mut value);
        total_bytes += serde_json::to_vec(&value)?.len();
        if total_bytes > TASK_ARCHIVE_MAX_SNAPSHOT as usize || values.len() >= 50_000 {
            return Err(Error::Invalid(
                "任务记录超过本批档案容量，未截断导出 / Task records exceed archive capacity; nothing was truncated",
            ));
        }
        values.push(value);
    }
    Ok(values)
}
fn remove_credential_locators(value: &mut Value) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(remove_credential_locators),
        Value::Object(map) => {
            for (key, value) in map {
                if key == "credential" {
                    *value = Value::Null;
                } else {
                    remove_credential_locators(value);
                }
            }
        }
        _ => {}
    }
}
impl Store {
    pub fn export_task_archive(&self, root: &str, stop: &AtomicBool) -> Result<TaskArchiveBytes> {
        if self.team_root(root)? != root || !self.is_execution(root)? {
            return Err(Error::Invalid(
                "请选择主任务，助手会一同保存 / Select the root task to include its assistants",
            ));
        }
        let tree = self.team_subtree(root)?;
        if tree.len() > 33 {
            return Err(Error::Invalid("too many archive tasks"));
        }
        let mut tasks = Vec::new();
        let mut media = vec![];
        let mut file_history = vec![];
        for task in &tree {
            check_stop(stop)?;
            let item = self.task(task)?;
            let active: bool = self.connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM runs WHERE task_id=?1 AND state IN ('queued','running')) OR EXISTS(SELECT 1 FROM model_calls WHERE task_id=?1 AND state='running') OR EXISTS(SELECT 1 FROM workbench_operations WHERE task_id=?1 AND json_extract(data_json,'$.state') IN ('queued','running','stopping'))",
                [task], |r| r.get(0))?;
            if active || matches!(item.state, TaskState::Running | TaskState::Stopping) {
                return Err(Error::Invalid(
                    "请先停止主任务、助手和文件操作 / Stop the task, assistants and file operations before archiving",
                ));
            }
            tasks.push(ArchiveTask {
                id: task.clone(),
                title: item.title,
                state: item.state,
                parent_task_id: self.member_parent(task)?,
            });
            media.extend(self.task_archive_media_rows(task)?);
            if media.len() > 64 {
                return Err(Error::Invalid(
                    "任务组附件超过 64 项，未截断导出 / Task group exceeds 64 attachments; nothing was truncated",
                ));
            }
            file_history.extend(
                self.task_archive_file_history_rows(task)?
                    .iter()
                    .map(TaskArchiveHistory::from_revision),
            );
            if file_history.len() > 128 {
                return Err(Error::Invalid(
                    "任务组文件历史超过 128 条，未截断 / Task group history exceeds 128 revisions; nothing was truncated",
                ));
            }
        }
        let mut tables = BTreeMap::new();
        let mut counts = BTreeMap::new();
        let mut row_count = 0;
        for table in TASK_ARCHIVE_TABLES {
            let data = rows(self, root, table, stop)?;
            row_count += data.len();
            if row_count > 50_000 {
                return Err(Error::Invalid("archive exceeds 50000 rows"));
            }
            counts.insert((*table).to_owned(), data.len() as u32);
            tables.insert((*table).to_owned(), data);
        }
        let snapshot = TaskArchiveSnapshot {
            version: 1,
            source_schema: SCHEMA_VERSION,
            root_task_id: root.into(),
            tables,
        };
        let snapshot_bytes = serde_json::to_vec(&snapshot)?;
        if snapshot_bytes.len() > TASK_ARCHIVE_MAX_SNAPSHOT as usize {
            return Err(Error::Invalid(
                "任务记录索引超过 8 MiB，未截断导出 / Task index exceeds 8 MiB; nothing was truncated",
            ));
        }
        let mut refs = BTreeMap::new();
        // Establish ownership only from the selected rows' actual object-link
        // columns. User-controlled JSON in titles, plans or event text is data,
        // never a grant to fetch a hash from the shared content store.
        for rows in snapshot.tables.values() {
            for row in rows {
                for (column, value) in row.as_object().ok_or(Error::Corrupt("archive row"))? {
                    if (column == "object_id" || column.ends_with("_object_id")) && !value.is_null()
                    {
                        let reference: ContentRef = serde_json::from_value(value.clone())?;
                        if let Some(old) =
                            refs.insert(reference.object_id.clone(), reference.clone())
                            && old != reference
                        {
                            return Err(Error::Corrupt("inconsistent owned content reference"));
                        }
                    }
                }
            }
        }
        let mut pending = refs.values().cloned().collect::<Vec<_>>();
        let mut blobs = BTreeMap::new();
        let mut bytes = snapshot_bytes.len() as u64;
        while let Some(reference) = pending.pop() {
            check_stop(stop)?;
            if blobs.contains_key(&reference.object_id) {
                continue;
            }
            bytes = bytes
                .checked_add(reference.bytes)
                .ok_or(Error::Invalid("archive size overflow"))?;
            if reference.bytes > 64 * 1024 * 1024
                || bytes > TASK_ARCHIVE_MAX_BYTES
                || refs.len() >= 4096
            {
                return Err(Error::Invalid(
                    "任务正文超过档案容量，未截断导出 / Task content exceeds archive capacity; nothing was truncated",
                ));
            }
            if content_ref(&self.connection, &reference.object_id)?.bytes != reference.bytes {
                return Err(Error::Corrupt("archive content reference"));
            }
            objects::verify(&self.directory, &reference)?;
            let data = std::fs::read(objects::object_path(&self.directory, &reference.object_id)?)?;
            self.check_archive_secret(&data)?;
            let mut nested = BTreeMap::new();
            if reference.media_type == "application/json" {
                collect_refs(&serde_json::from_slice(&data)?, &mut nested, 0)?;
            }
            for (id, r) in nested {
                if let Some(old) = refs.get(&id) {
                    if old != &r {
                        return Err(Error::Corrupt("inconsistent content reference"));
                    }
                } else {
                    // Nested model/tool text must not turn an arbitrary hash into
                    // authority to copy another task's stored content. Every linked
                    // object must also be owned by this tree's durable records.
                    return Err(Error::Invalid(
                        "正文引用未登记在所选任务中 / Linked content is not owned by this task tree",
                    ));
                }
            }
            blobs.insert(reference.object_id.clone(), data);
        }
        self.check_archive_secret(&snapshot_bytes)?;
        let snapshot_ref = ContentRef {
            object_id: digest(&snapshot_bytes),
            bytes: snapshot_bytes.len() as u64,
            media_type: "application/json".into(),
        };
        refs.insert(snapshot_ref.object_id.clone(), snapshot_ref.clone());
        blobs.insert(snapshot_ref.object_id.clone(), snapshot_bytes);
        file_history.sort_by(|a, b| {
            (a.revision.at_ms, &a.revision.id).cmp(&(b.revision.at_ms, &b.revision.id))
        });
        let index = TaskArchiveIndex {
            version: 3,
            archive_id: id(),
            created_at_ms: now_ms(),
            root_task_id: root.into(),
            tasks,
            snapshot: snapshot_ref,
            objects: refs.into_values().collect(),
            counts,
            media,
            file_history,
            excluded_media: 0,
            excluded_file_revisions: 0,
        };
        validate_bundle(&index, &blobs)?;
        self.check_archive_secret(&serde_json::to_vec(&index)?)?;
        Ok(TaskArchiveBytes { index, blobs })
    }
}
