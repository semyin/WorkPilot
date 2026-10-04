//! Durable coordination receipts; each component retains its existing atomic importer.
use super::*;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};

impl Store {
    pub fn migration_catalog(&self) -> Result<Value> {
        let mut q = self
            .connection
            .prepare("SELECT id FROM projects ORDER BY rowid")?;
        let ids = q
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let projects = ids
            .iter()
            .map(|id| self.workspace_project(id))
            .collect::<Result<Vec<_>>>()?;
        let mut q=self.connection.prepare("SELECT t.id,t.project_id,t.title,t.state,t.archived FROM tasks t WHERE EXISTS(SELECT 1 FROM execution_sessions s WHERE s.task_id=t.id) AND NOT EXISTS(SELECT 1 FROM team_members m WHERE m.task_id=t.id) ORDER BY t.updated_at_ms DESC")?;
        let tasks=q.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"project_id":r.get::<_,Option<String>>(1)?,
            "title":r.get::<_,String>(2)?,"state":r.get::<_,String>(3)?,"archived":r.get::<_,bool>(4)?})))?
            .collect::<std::result::Result<Vec<_>,_>>()?;
        let mut q = self
            .connection
            .prepare("SELECT memory_id FROM memory_meta ORDER BY memory_id")?;
        let ids = q
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let memories = ids
            .iter()
            .map(|id| self.memory_get(id))
            .collect::<Result<Vec<_>>>()?;
        Ok(
            json!({"projects":projects,"tasks":tasks,"profiles":self.export_profiles()?.profiles,"memories":memories}),
        )
    }
    pub fn migration_receipt(&self, archive: &str) -> Result<Option<Value>> {
        if !valid_id(archive) {
            return Err(Error::Invalid("invalid migration identity"));
        }
        let raw: Option<String> = self
            .connection
            .query_row(
                "SELECT value_json FROM settings WHERE key=?1",
                [format!("migration:{archive}")],
                |r| r.get(0),
            )
            .optional()?;
        raw.map(|r| Ok(serde_json::from_str(&r)?)).transpose()
    }
    pub fn save_migration_receipt(&mut self, archive: &str, receipt: &Value) -> Result<()> {
        if !valid_id(archive)
            || receipt["archive_id"] != archive
            || receipt["binding"].as_str().is_none()
        {
            return Err(Error::Invalid("invalid migration receipt"));
        }
        if self
            .migration_receipt(archive)?
            .is_some_and(|r| r["binding"] != receipt["binding"])
        {
            return Err(Error::Conflict);
        }
        self.connection.execute("INSERT INTO settings(key,value_json) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
            params![format!("migration:{archive}"),encode(receipt)?])?;
        Ok(())
    }
    pub fn migration_file_task(
        &mut self,
        archive: &str,
        source_project: &str,
        project: &str,
    ) -> Result<String> {
        let request = Request {
            request_id: format!(
                "migration-files-{:x}",
                Sha256::digest(format!("{archive}\0{source_project}").as_bytes())
            ),
            command: Command::CreateExecution {
                config: Box::new(ExecutionConfig {
                    title: "迁入项目文件 / Imported project files".into(),
                    goal: "核对并导入用户选定的项目文件 / Review and import selected project files"
                        .into(),
                    constraints: vec![],
                    project_rules: String::new(),
                    project_id: Some(project.into()),
                    profile_id: None,
                    mode: WorkMode::Execute,
                    controlled_tools: false,
                    limits: ExecutionLimits::default(),
                }),
            },
        };
        let Command::CreateExecution { config } = &request.command else {
            unreachable!()
        };
        let (receipt, _) = self.create_execution(&request, config)?;
        let task = receipt.task_id.ok_or(Error::NotFound)?;
        self.task(&task)?;
        Ok(task)
    }
    pub fn link_migration_memories(&mut self, archive: &str) -> Result<()> {
        let mut receipt = self.migration_receipt(archive)?.ok_or(Error::NotFound)?;
        if receipt["memory_links_complete"] == true {
            return Ok(());
        }
        let mut tasks = BTreeMap::new();
        for group in receipt["tasks"]
            .as_object()
            .ok_or(Error::Invalid("missing task receipts"))?
            .values()
        {
            for task in group["tasks"]
                .as_array()
                .ok_or(Error::Invalid("invalid task mapping"))?
            {
                tasks.insert(
                    task["source_task_id"]
                        .as_str()
                        .ok_or(Error::NotFound)?
                        .to_owned(),
                    task["task_id"].as_str().ok_or(Error::NotFound)?.to_owned(),
                );
            }
        }
        let mut links = vec![];
        let mut version_links = vec![];
        let mut selected = HashSet::new();
        for project in receipt["projects"]
            .as_object()
            .ok_or(Error::Invalid("missing project receipts"))?
            .values()
        {
            for memory in project["memories"]
                .as_array()
                .ok_or(Error::Invalid("missing memory mapping"))?
            {
                let memory_id = memory["target_id"].as_str().ok_or(Error::NotFound)?;
                if let Some(versions) = memory["version_sources"].as_array() {
                    for version in versions {
                        if let Some(task) = version["source_task_id"]
                            .as_str()
                            .and_then(|id| tasks.get(id))
                        {
                            self.task(task)?;
                            version_links.push((
                                memory_id.to_owned(),
                                version["revision"]
                                    .as_u64()
                                    .ok_or(Error::Invalid("invalid memory revision"))?,
                                task.clone(),
                            ));
                        }
                    }
                }
                if let Some(target) = memory["source_task_id"]
                    .as_str()
                    .and_then(|id| tasks.get(id))
                {
                    self.task(target)?;
                    let id = memory["target_id"].as_str().ok_or(Error::NotFound)?;
                    if !selected.insert(id.to_owned()) {
                        return Err(Error::Invalid("duplicate migrated memory"));
                    }
                    // Only entries created by this migration are touched. Later user edits are retained.
                    let current = self.memory_get(id)?;
                    if current.source_task_id.is_none() {
                        links.push((id.to_owned(), target.clone()));
                    }
                }
            }
        }
        receipt["memory_links_complete"] = json!(true);
        let tx = self.connection.transaction()?;
        for (id, task) in links {
            tx.execute(
                "UPDATE memories SET source_task_id=?2 WHERE id=?1 AND source_task_id IS NULL",
                params![id, task],
            )?;
            tx.execute("UPDATE memory_meta SET data_json=json_set(data_json,'$.memory.source_task_id',?2) WHERE memory_id=?1",params![id,task])?;
        }
        for (id, revision, task) in version_links {
            tx.execute("UPDATE memory_versions SET data_json=json_set(data_json,'$.memory.source_task_id',?3) WHERE memory_id=?1 AND revision=?2 AND json_extract(data_json,'$.memory.source_task_id') IS NULL",
                params![id,revision,task])?;
        }
        tx.execute(
            "UPDATE settings SET value_json=?2 WHERE key=?1",
            params![format!("migration:{archive}"), encode(&receipt)?],
        )?;
        tx.commit()?;
        Ok(())
    }
}
