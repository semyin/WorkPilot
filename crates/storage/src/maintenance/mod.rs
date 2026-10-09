//! Offline lifecycle operations. The desktop stops all producers before applying a preview.
use super::*;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
mod cleanup;
pub(super) mod deletion;
#[cfg(test)]
mod migration_tests;
mod references;
#[cfg(test)]
mod tests;

pub struct MaintenancePlan {
    pub selection: MaintenanceSelection,
    pub fingerprint: String,
    state_fingerprint: String,
    pub tasks: Vec<String>,
    pub revisions: Vec<FileRevision>,
    pub archives: Vec<String>,
    pub preview: Value,
}
fn strings(db: &Connection, sql: &str) -> Result<Vec<String>> {
    let mut q = db.prepare(sql)?;
    Ok(q.query_map([], |r| r.get(0))?
        .collect::<std::result::Result<_, _>>()?)
}
impl Store {
    pub fn maintenance_catalog(&self) -> Result<Value> {
        let groups = strings(
            &self.connection,
            "SELECT json_object('id',t.id,'title',t.title,'tasks',1+(SELECT count(*) FROM team_members m WHERE m.root_task_id=t.id)) FROM tasks t WHERE archived=1 AND NOT EXISTS(SELECT 1 FROM team_members m WHERE m.task_id=t.id) ORDER BY updated_at_ms DESC",
        )?;
        let roots = strings(
            &self.connection,
            "SELECT json_object('identity',root_identity,'versions',count(*),'path',COALESCE((SELECT p.root_path FROM project_workspace w JOIN projects p ON p.id=w.project_id WHERE w.root_identity=f.root_identity LIMIT 1),root_identity)) FROM file_revisions f GROUP BY root_identity",
        )?;
        Ok(
            json!({"groups":groups.iter().map(|s|serde_json::from_str::<Value>(s)).collect::<std::result::Result<Vec<_>,_>>()?,"roots":roots.iter().map(|s|serde_json::from_str::<Value>(s)).collect::<std::result::Result<Vec<_>,_>>()?,"archives":self.task_archive_list()?,"pending_cleanup":self.maintenance_cleanup_pending()?}),
        )
    }
    pub fn maintenance_plan(&self, selection: &MaintenanceSelection) -> Result<MaintenancePlan> {
        selection.validate().map_err(Error::Invalid)?;
        let busy: bool = self.connection.query_row("SELECT EXISTS(SELECT 1 FROM runs WHERE state IN ('running','queued')) OR EXISTS(SELECT 1 FROM workbench_operations WHERE json_extract(data_json,'$.state') IN ('preparing','queued','running','stopping')) OR EXISTS(SELECT 1 FROM tool_calls WHERE state='started')", [], |r|r.get(0))?;
        if busy {
            return Err(Error::Invalid(
                "请先暂停正在运行的任务 / Pause running tasks before preview",
            ));
        }
        let mut tasks = BTreeSet::new();
        let mut revisions = vec![];
        let mut archives = vec![];
        match selection {
            MaintenanceSelection::Tasks { root_task_ids } => {
                for root in root_task_ids {
                    let root_ok: bool = self.connection.query_row("SELECT EXISTS(SELECT 1 FROM tasks t WHERE id=?1 AND archived=1 AND NOT EXISTS(SELECT 1 FROM team_members WHERE task_id=t.id))",[root],|r|r.get(0))?;
                    if !root_ok {
                        return Err(Error::Invalid(
                            "只能选择已归档的根任务；助手记录随整组处理 / Select archived root tasks",
                        ));
                    }
                    tasks.insert(root.clone());
                    let mut q = self
                        .connection
                        .prepare("SELECT task_id FROM team_members WHERE root_task_id=?1")?;
                    for id in q.query_map([root], |r| r.get::<_, String>(0))? {
                        tasks.insert(id?);
                    }
                }
            }
            MaintenanceSelection::Versions {
                root_identity,
                keep_last,
                older_than_days,
            } => {
                let cutoff = now_ms().saturating_sub(u64::from(*older_than_days) * 86_400_000);
                let mut q=self.connection.prepare("SELECT data_json FROM file_revisions WHERE root_identity=?1 ORDER BY path,rowid DESC")?;
                let mut counts = BTreeMap::<String, u32>::new();
                for r in q.query_map([root_identity], |r| r.get::<_, String>(0))? {
                    let r: FileRevision = serde_json::from_str(&r?)?;
                    let n = counts.entry(r.path.clone()).or_default();
                    *n += 1;
                    if *n > *keep_last && r.at_ms < cutoff {
                        revisions.push(r);
                    }
                }
                if revisions.len() > 128 {
                    return Err(Error::Invalid(
                        "一次最多清理 128 个版本，请提高保留数量或缩小时间范围 / At most 128 revisions per cleanup",
                    ));
                }
            }
            MaintenanceSelection::Archives { archive_ids } => {
                for archive in archive_ids {
                    let exists: bool = self.connection.query_row(
                        "SELECT EXISTS(SELECT 1 FROM settings WHERE key=?1)",
                        [format!("task-archive:{archive}")],
                        |r| r.get(0),
                    )?;
                    if !exists {
                        return Err(Error::NotFound);
                    }
                    archives.push(archive.clone());
                }
            }
            MaintenanceSelection::Unreferenced | MaintenanceSelection::Reset => (),
        }
        let state_fingerprint = self.maintenance_fingerprint(selection)?;
        let tasks: Vec<_> = tasks.into_iter().collect();
        // Age-based rules can select a new row as time passes even without a database edit.
        // The confirmation therefore binds both the database state and the exact selected rows.
        let fingerprint=format!("{:x}",Sha256::digest(encode(&json!({"state":state_fingerprint,"tasks":tasks,"revisions":revisions.iter().map(|r|&r.id).collect::<Vec<_>>(),"archives":archives}))?.as_bytes()));
        let mut count = BTreeMap::new();
        for table in [
            "tasks",
            "file_revisions",
            "media_assets",
            "memories",
            "schedules",
            "provider_profiles",
            "extension_installations",
        ] {
            let n: i64 =
                self.connection
                    .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))?;
            count.insert(table, n);
        }
        let preview = json!({"selection":selection,"fingerprint":fingerprint,"tasks":tasks,"revision_ids":revisions.iter().map(|r|&r.id).collect::<Vec<_>>(),"archives":archives,"totals":count,"backup_required":matches!(selection,MaintenanceSelection::Versions {..}) && !revisions.is_empty(),"project_files_preserved":true,"confirmation":if matches!(selection,MaintenanceSelection::Reset) {"RESET"} else {"DELETE"}});
        Ok(MaintenancePlan {
            selection: selection.clone(),
            fingerprint,
            state_fingerprint,
            tasks,
            revisions,
            archives,
            preview,
        })
    }
    fn maintenance_fingerprint(&self, selection: &MaintenanceSelection) -> Result<String> {
        let mut hash = Sha256::new();
        hash.update(encode(selection)?);
        // Ignore global transport/diagnostic events added during a normal shutdown.
        // Hash actual rows, rather than only counts, to catch edits between preview and apply.
        for table in strings(
            &self.connection,
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'memory_search%' AND name NOT IN ('events','event_objects','commands','workspace_exports','objects') ORDER BY name",
        )? {
            if !table
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_')
            {
                return Err(Error::Corrupt("table identifier"));
            }
            hash.update(table.as_bytes());
            let mut q = self
                .connection
                .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))?;
            let columns = q.column_count();
            let mut rows = q.query([])?;
            while let Some(row) = rows.next()? {
                for c in 0..columns {
                    let value = row.get_ref(c)?;
                    let bytes = format!("{value:?}");
                    hash.update((bytes.len() as u64).to_le_bytes());
                    hash.update(bytes);
                }
            }
        }
        Ok(format!("{:x}", hash.finalize()))
    }
    pub fn maintenance_apply_rows(
        &mut self,
        plan: &MaintenancePlan,
        backup: Option<&Value>,
    ) -> Result<()> {
        if self.maintenance_fingerprint(&plan.selection)? != plan.state_fingerprint {
            return Err(Error::Conflict);
        }
        if matches!(plan.selection, MaintenanceSelection::Reset) {
            return self.maintenance_reset_rows();
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        deletion::delete_groups(&tx, &plan.tasks)?;
        for r in &plan.revisions {
            if backup.is_none() {
                return Err(Error::Invalid(
                    "版本清理必须先生成并校验加密备份 / Verified backup required",
                ));
            }
            tx.execute("DELETE FROM file_revisions WHERE id=?1", [&r.id])?;
            // A retained legacy command must never rehydrate deliberately pruned history.
            tx.execute(
                "INSERT OR REPLACE INTO settings(key,value_json) VALUES(?1,'true')",
                [format!("pruned-file-history:{}", r.operation_id)],
            )?;
        }
        for a in &plan.archives {
            tx.execute(
                "DELETE FROM settings WHERE key=?1",
                [format!("task-archive:{a}")],
            )?;
        }
        tx.execute_batch("UPDATE workbench_operations SET spec_blob=NULL WHERE json_extract(data_json,'$.state') IN ('completed','failed','cancelled','interrupted'); UPDATE file_captures SET data_json='[]' WHERE state='completed';")?;
        let receipt = json!({"at_ms":now_ms(),"tasks":plan.tasks,"revisions":plan.revisions.len(),"archives":plan.archives,"backup":backup});
        tx.execute(
            "INSERT INTO settings(key,value_json) VALUES(?1,?2)",
            params![
                format!("maintenance:{}", plan.fingerprint),
                encode(&receipt)?
            ],
        )?;
        let violation: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_foreign_key_check)",
            [],
            |r| r.get(0),
        )?;
        if violation {
            return Err(Error::Corrupt("cleanup references"));
        }
        tx.commit()?;
        Ok(())
    }
    pub fn maintenance_project_paths(&self) -> Result<Vec<String>> {
        strings(
            &self.connection,
            "SELECT root_path FROM projects UNION SELECT json_extract(data_json,'$.root_path') FROM task_tool_settings WHERE json_extract(data_json,'$.root_path') IS NOT NULL UNION SELECT value FROM settings,json_each(settings.value_json,'$.protected_roots') WHERE settings.key='maintenance-pending-reset'",
        )
    }
}
