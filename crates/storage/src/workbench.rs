use super::*;
use serde_json::{Value, json};

impl Store {
    pub fn register_browser_artifact(
        &mut self,
        task: &str,
        path: &str,
        version: &FileVersion,
        blob: &str,
        url: Value,
    ) -> Result<Vec<Event>> {
        let metadata = json!({"kind":"browser_download_receipt","path":path,"version":version,"encrypted_version":blob,"source_url":url});
        let safe = self.redactor.text(&metadata.to_string());
        self.register_file_artifact(task, path, &safe)
    }
    pub fn attach_workbench_input(
        &mut self,
        operation: &mut WorkbenchOperation,
        value: Value,
    ) -> Result<Vec<Event>> {
        let content = self.save_json(value)?;
        self.connection.execute(
            "INSERT OR IGNORE INTO workbench_output_objects(operation_id,object_id) VALUES(?1,?2)",
            params![operation.id, content.object_id],
        )?;
        operation.input = Some(content);
        self.put_workbench_operation(operation, false)
    }
    pub fn has_active_workbench(&self, task: &str) -> Result<bool> {
        Ok(self.connection.query_row("SELECT EXISTS(SELECT 1 FROM workbench_operations WHERE task_id=?1 AND json_extract(data_json,'$.state') IN ('queued','running','stopping'))",[task],|r|r.get(0))?)
    }
    pub fn save_operation_output(&mut self, operation: &str, text: &str) -> Result<ContentRef> {
        let content = self.save_workbench_output(text)?;
        self.connection.execute(
            "INSERT OR IGNORE INTO workbench_output_objects(operation_id,object_id) VALUES(?1,?2)",
            params![operation, content.object_id],
        )?;
        Ok(content)
    }
    pub fn claim_workbench_operation(
        &mut self,
        operation: &WorkbenchOperation,
    ) -> Result<Vec<Event>> {
        if self.connection.execute("UPDATE workbench_operations SET started=1 WHERE id=?1 AND fingerprint=?2 AND started=0 AND json_extract(data_json,'$.state') IN ('awaiting_approval','queued')",params![operation.id,operation.fingerprint])?!=1 {return Err(Error::Conflict);}
        self.put_workbench_operation(operation, false)
    }
    pub fn workbench_spec(&self, id: &str) -> Result<String> {
        self.connection
            .query_row(
                "SELECT spec_blob FROM workbench_operations WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or(Error::NotFound)
    }
    pub fn save_workbench_spec(&mut self, id: &str, blob: &str) -> Result<()> {
        self.connection.execute(
            "UPDATE workbench_operations SET spec_blob=?2 WHERE id=?1",
            params![id, blob],
        )?;
        Ok(())
    }
    pub fn workbench_operation(&self, id: &str) -> Result<Option<WorkbenchOperation>> {
        let raw: Option<String> = self
            .connection
            .query_row(
                "SELECT data_json FROM workbench_operations WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        raw.map(|r| serde_json::from_str(&r).map_err(Error::from))
            .transpose()
    }
    pub fn workbench_operations(&self, task: &str) -> Result<Vec<WorkbenchOperation>> {
        self.task(task)?;
        let mut q = self.connection.prepare("SELECT data_json FROM workbench_operations WHERE task_id=?1 ORDER BY CASE WHEN json_extract(data_json,'$.state') IN ('awaiting_approval','queued','running','stopping') THEN 0 ELSE 1 END, rowid DESC LIMIT 64")?;
        q.query_map([task], |r| r.get::<_, String>(0))?
            .map(|r| Ok(serde_json::from_str(&r?)?))
            .collect()
    }
    pub fn put_workbench_operation(
        &mut self,
        operation: &WorkbenchOperation,
        insert: bool,
    ) -> Result<Vec<Event>> {
        self.task(&operation.task_id)?;
        let mut safe = operation.clone();
        safe.summary = self.redactor.text(&safe.summary);
        safe.error = safe.error.map(|e| self.redactor.text(&e));
        let tx = self.connection.transaction()?;
        if insert {
            tx.execute("INSERT INTO workbench_operations(id,task_id,fingerprint,data_json) VALUES(?1,?2,?3,?4)",params![safe.id,safe.task_id,safe.fingerprint,encode(&safe)?])?;
        } else {
            if tx.execute(
                "UPDATE workbench_operations SET data_json=?2 WHERE id=?1 AND fingerprint=?3",
                params![safe.id, encode(&safe)?, safe.fingerprint],
            )? != 1
            {
                return Err(Error::Conflict);
            }
        }
        let event = record(
            &tx,
            &self.redactor,
            Some(&safe.task_id),
            Some(&safe.id),
            EventSource::Engine,
            Payload::WorkbenchChanged {
                operation_id: safe.id.clone(),
                state: safe.state.clone(),
                record: safe.output.clone().or(safe.input.clone()),
            },
        )?;
        tx.commit()?;
        Ok(vec![event])
    }
    pub fn recover_workbench(&mut self) -> Result<()> {
        let mut q=self.connection.prepare("SELECT data_json FROM workbench_operations WHERE json_extract(data_json,'$.state') IN ('preparing','queued','running','stopping') OR (started=1 AND json_extract(data_json,'$.state')='awaiting_approval')")?;
        let operations = q
            .query_map([], |r| r.get::<_, String>(0))?
            .map(|r| Ok(serde_json::from_str::<WorkbenchOperation>(&r?)?))
            .collect::<Result<Vec<_>>>()?;
        drop(q);
        for mut op in operations {
            op.state = "interrupted".into();
            op.error = Some("应用退出；此操作不会自动重跑。请核对文件历史和 Git 状态。".into());
            self.put_workbench_operation(&op, false)?;
        }
        Ok(())
    }
    pub fn save_workbench_output(&mut self, text: &str) -> Result<ContentRef> {
        let content = objects::put_tool_text(&self.directory, text, &self.redactor)?;
        self.connection.execute(
            "INSERT OR IGNORE INTO objects(id,bytes,media_type) VALUES(?1,?2,?3)",
            params![content.object_id, content.bytes, content.media_type],
        )?;
        Ok(content)
    }
    pub fn safe_workbench_text(&self, text: &str) -> String {
        self.redactor.text(text)
    }
    pub fn begin_file_capture(
        &mut self,
        operation: &str,
        task: &str,
        root_path: &str,
        root_identity: &str,
        source: &str,
        images: &Value,
    ) -> Result<()> {
        self.task(task)?;
        self.connection.execute("INSERT INTO file_captures(operation_id,task_id,root_path,root_identity,source,data_json,state) VALUES(?1,?2,?3,?4,?5,?6,'prepared')",params![operation,task,root_path,root_identity,source,encode(images)?])?;
        Ok(())
    }
    pub fn finish_file_capture(
        &mut self,
        operation: &str,
        revisions: &[FileRevision],
    ) -> Result<Vec<Event>> {
        let tx = self.connection.transaction()?;
        let task: String = tx.query_row(
            "SELECT task_id FROM file_captures WHERE operation_id=?1",
            [operation],
            |r| r.get(0),
        )?;
        for r in revisions {
            if r.operation_id != operation || r.task_id != task {
                return Err(Error::Conflict);
            }
            tx.execute("INSERT OR IGNORE INTO file_revisions(id,task_id,root_identity,path,operation_id,data_json) VALUES(?1,?2,?3,?4,?5,?6)",params![r.id,r.task_id,r.root_identity,r.path,r.operation_id,encode(r)?])?;
        }
        tx.execute(
            "UPDATE file_captures SET state='completed' WHERE operation_id=?1",
            [operation],
        )?;
        let event = record(
            &tx,
            &self.redactor,
            Some(&task),
            Some(operation),
            EventSource::Tool,
            Payload::WorkbenchChanged {
                operation_id: operation.into(),
                state: format!("files_recorded:{}", revisions.len()),
                record: None,
            },
        )?;
        tx.commit()?;
        Ok(vec![event])
    }
    pub fn pending_file_captures(&self) -> Result<Vec<Value>> {
        let mut q=self.connection.prepare("SELECT operation_id,task_id,root_path,root_identity,source,data_json FROM file_captures WHERE state='prepared' ORDER BY rowid LIMIT 128")?;
        q.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?)))?.map(|r|{let (operation,task,path,identity,source,data)=r?;Ok(json!({"operation":operation,"task":task,"root_path":path,"root_identity":identity,"source":source,"images":serde_json::from_str::<Value>(&data)?}))}).collect()
    }
    pub fn file_history(
        &self,
        root: &str,
        path: Option<&str>,
        before: Option<&str>,
        limit: u32,
    ) -> Result<Vec<FileRevision>> {
        let mut q=self.connection.prepare("SELECT data_json FROM file_revisions WHERE root_identity=?1 AND (?2 IS NULL OR path=?2) AND (?3 IS NULL OR rowid < (SELECT rowid FROM file_revisions WHERE id=?3)) ORDER BY rowid DESC LIMIT ?4")?;
        q.query_map(params![root, path, before, limit], |r| {
            r.get::<_, String>(0)
        })?
        .map(|r| Ok(serde_json::from_str(&r?)?))
        .collect()
    }
    pub fn file_revision(&self, id: &str, root: &str) -> Result<FileRevision> {
        let raw: String = self
            .connection
            .query_row(
                "SELECT data_json FROM file_revisions WHERE id=?1 AND root_identity=?2",
                params![id, root],
                |r| r.get(0),
            )
            .optional()?
            .ok_or(Error::NotFound)?;
        Ok(serde_json::from_str(&raw)?)
    }
    pub fn import_managed_revisions(&mut self, root: &str) -> Result<()> {
        let mut q=self.connection.prepare("SELECT action_id,task_id,path,before_json,after_json,before_object_id,after_object_id FROM managed_file_changes WHERE root_identity=?1 AND after_json IS NOT NULL AND action_id NOT IN (SELECT operation_id FROM file_revisions)")?;
        let rows = q
            .query_map([root], |r| {
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
        drop(q);
        for (operation, task, path, before, after, old, new) in rows {
            let at_ms=self.connection.query_row("SELECT at_ms FROM events WHERE task_id=?1 AND json_extract(payload_json,'$.change.action_id')=?2 ORDER BY sequence DESC LIMIT 1",params![task,operation],|r|r.get::<_,u64>(0)).optional()?.unwrap_or(0);
            let before: FileVersion = serde_json::from_str(&before)?;
            let revision = FileRevision {
                id: id(),
                operation_id: operation,
                task_id: task,
                root_identity: root.into(),
                path,
                previous_path: None,
                change: if before.exists { "modified" } else { "created" }.into(),
                source: "write_file".into(),
                at_ms,
                before: FileImage {
                    version: before,
                    blob: old.map(|v| format!("legacy:{v}")),
                },
                after: FileImage {
                    version: serde_json::from_str(&after)?,
                    blob: Some(format!("legacy:{new}")),
                },
                origin: None,
            };
            self.connection.execute("INSERT OR IGNORE INTO file_revisions(id,task_id,root_identity,path,operation_id,data_json) VALUES(?1,?2,?3,?4,?5,?6)",params![revision.id,revision.task_id,revision.root_identity,revision.path,revision.operation_id,encode(&revision)?])?;
        }
        Ok(())
    }
    pub fn legacy_file_bytes(&self, object: &str) -> Result<Vec<u8>> {
        let content = content_ref(&self.connection, object)?;
        if content.bytes > 1024 * 1024 {
            return Err(Error::Invalid("legacy file limit"));
        }
        objects::verify(&self.directory, &content)?;
        Ok(std::fs::read(objects::object_path(
            &self.directory,
            object,
        )?)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::execution_tests::setup;
    fn operation(task: &str) -> WorkbenchOperation {
        WorkbenchOperation {
            id: id(),
            task_id: task.into(),
            fingerprint: "a".repeat(64),
            kind: "terminal".into(),
            summary: "synthetic command".into(),
            state: "awaiting_approval".into(),
            at_ms: now_ms(),
            input: None,
            output: None,
            stdout: None,
            stderr: None,
            error: None,
            pid: None,
            preview_port: None,
        }
    }
    #[test]
    fn approval_claim_survives_restart_and_cannot_be_consumed_twice() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path()).unwrap();
        let (task, _) = setup(&mut s);
        let mut op = operation(&task);
        s.put_workbench_operation(&op, true).unwrap();
        op.state = "queued".into();
        s.claim_workbench_operation(&op).unwrap();
        assert!(s.claim_workbench_operation(&op).is_err());
        drop(s);
        let mut s = Store::open(dir.path()).unwrap();
        assert_eq!(
            s.workbench_operation(&op.id).unwrap().unwrap().state,
            "interrupted"
        );
        assert!(s.claim_workbench_operation(&op).is_err());
    }
    #[test]
    fn full_terminal_outputs_survive_gc_and_are_in_complete_export() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path()).unwrap();
        let (task, _) = setup(&mut s);
        let mut op = operation(&task);
        s.put_workbench_operation(&op, true).unwrap();
        let output = "long output ".repeat(100000);
        let stdout = s.save_operation_output(&op.id, &output).unwrap();
        let stderr = s.save_operation_output(&op.id, "synthetic stderr").unwrap();
        s.attach_workbench_input(
            &mut op,
            json!({"command":"sample","api_key":"synthetic-should-be-redacted"}),
        )
        .unwrap();
        op.stdout = Some(stdout.clone());
        op.stderr = Some(stderr.clone());
        op.output = Some(s.save_operation_output(&op.id, "finished").unwrap());
        op.state = "completed".into();
        s.put_workbench_operation(&op, false).unwrap();
        s.collect_unreferenced_objects().unwrap();
        assert_eq!(
            std::fs::read(objects::object_path(&s.directory, &stdout.object_id).unwrap()).unwrap(),
            output.as_bytes()
        );
        let exported = Inspector::open(dir.path())
            .unwrap()
            .export_workspace_records(dir.path(), &task)
            .unwrap();
        let WorkspaceData::Exported { path, .. } = exported else {
            panic!()
        };
        assert_eq!(
            std::fs::read(Path::new(&path).join("objects").join(&stderr.object_id)).unwrap(),
            b"synthetic stderr"
        );
        assert!(
            Path::new(&path)
                .join("objects")
                .join(stdout.object_id)
                .is_file()
        );
        assert!(
            !std::fs::read_to_string(
                objects::object_path(&s.directory, &op.input.unwrap().object_id).unwrap()
            )
            .unwrap()
            .contains("synthetic-should-be-redacted")
        );
    }
    #[test]
    fn active_terminal_blocks_archive_even_when_it_is_older_than_display_page() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path()).unwrap();
        let (task, _) = setup(&mut s);
        let mut active = operation(&task);
        active.state = "running".into();
        s.put_workbench_operation(&active, true).unwrap();
        for _ in 0..70 {
            let mut old = operation(&task);
            old.state = "completed".into();
            s.put_workbench_operation(&old, true).unwrap();
        }
        assert!(s.has_active_workbench(&task).unwrap());
        assert!(
            s.workbench_operations(&task)
                .unwrap()
                .iter()
                .any(|op| op.id == active.id)
        );
        let action = WorkspaceAction::ArchiveTask {
            task_id: task.clone(),
            archived: true,
        };
        let request = Request {
            request_id: id(),
            command: Command::Workspace {
                action: action.clone(),
            },
        };
        assert!(s.workspace_action(&request, &action, None).is_err());
        active.state = "completed".into();
        s.put_workbench_operation(&active, false).unwrap();
        assert!(!s.has_active_workbench(&task).unwrap());
    }
}
