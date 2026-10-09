use super::*;
// Shared by offline cleanup and the live task command after its active-work guards.
pub(crate) fn delete_groups(tx: &Connection, tasks: &[String]) -> Result<()> {
    tx.execute_batch("CREATE TEMP TABLE IF NOT EXISTS deleting_tasks(id TEXT PRIMARY KEY); DELETE FROM deleting_tasks;")?;
    for id in tasks {
        tx.execute("INSERT INTO deleting_tasks VALUES(?1)", [id])?;
    }
    // Remove all members/dependencies together before parent-task RESTRICT constraints fire.
    let outside:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM team_members WHERE (parent_task_id IN (SELECT id FROM deleting_tasks) OR root_task_id IN (SELECT id FROM deleting_tasks)) AND task_id NOT IN (SELECT id FROM deleting_tasks))",[],|r|r.get(0))?;
    if outside {
        return Err(Error::Conflict);
    }
    trim_migration_files(tx, tasks)?;
    tx.execute_batch("DELETE FROM team_dependencies WHERE member_id IN (SELECT id FROM deleting_tasks) OR dependency_id IN (SELECT id FROM deleting_tasks);
        DELETE FROM team_waiters WHERE task_id IN (SELECT id FROM deleting_tasks);
        DELETE FROM team_members WHERE task_id IN (SELECT id FROM deleting_tasks);
        DELETE FROM media_assets WHERE task_id IN (SELECT id FROM deleting_tasks);
        DELETE FROM memory_proposals WHERE task_id IN (SELECT id FROM deleting_tasks);
        UPDATE memories SET data_json=json_set(data_json,'$.source_task_id',NULL) WHERE source_task_id IN (SELECT id FROM deleting_tasks);
        UPDATE memory_meta SET data_json=json_set(data_json,'$.memory.source_task_id',NULL) WHERE json_extract(data_json,'$.memory.source_task_id') IN (SELECT id FROM deleting_tasks);
        UPDATE memory_versions SET data_json=json_set(data_json,'$.memory.source_task_id',NULL) WHERE json_extract(data_json,'$.memory.source_task_id') IN (SELECT id FROM deleting_tasks);
        UPDATE agents SET parent_id=NULL WHERE task_id IN (SELECT id FROM deleting_tasks);
        UPDATE revisions SET predecessor_id=NULL WHERE artifact_id IN (SELECT id FROM artifacts WHERE task_id IN (SELECT id FROM deleting_tasks));
        DELETE FROM settings WHERE key IN (SELECT 'task-restored-history:' || id FROM deleting_tasks);
        DELETE FROM tasks WHERE id IN (SELECT id FROM deleting_tasks);
        DROP TABLE deleting_tasks;")?;
    // commands and archive restore receipts remain as tombstones; delayed retries cannot recreate deleted tasks.
    Ok(())
}

fn trim_migration_files(tx: &Connection, tasks: &[String]) -> Result<()> {
    if tasks.is_empty() {
        return Ok(());
    }
    let deleting: BTreeSet<_> = tasks.iter().map(String::as_str).collect();
    let mut query =
        tx.prepare("SELECT key,value_json FROM settings WHERE key GLOB 'migration:*'")?;
    let records = query
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for (key, raw) in records {
        let mut receipt: Value = serde_json::from_str(&raw)?;
        let Some(files) = receipt["files"].as_object_mut() else {
            continue;
        };
        let mut changed = false;
        for file in files.values_mut() {
            let Some(task) = file["task_id"].as_str() else {
                continue;
            };
            if deleting.contains(task) {
                // Retain only the idempotency identities. A deleted task must not pin
                // its old manifest and source bytes or acquire fresh execution rights.
                *file = json!({"task_id":task,"operation_id":file["operation_id"],
                    "state":"deleted","deleted":true,"files":[]});
                changed = true;
            }
        }
        if changed {
            tx.execute(
                "UPDATE settings SET value_json=?2 WHERE key=?1",
                params![key, encode(&receipt)?],
            )?;
        }
    }
    Ok(())
}
