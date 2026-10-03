use super::*;
impl Store {
    pub fn import_history_rows(
        &mut self,
        task: &str,
        root: &str,
        epoch: &str,
        operation: &str,
        digest: &str,
        rows: &[FileRevision],
    ) -> Result<Vec<Event>> {
        let policy = self.tool_settings(task)?;
        if self.task_archived(task)?
            || policy.epoch != epoch
            || policy.root_identity.as_deref() != Some(root)
            || rows.is_empty()
            || rows.len() > 128
        {
            return Err(Error::Conflict);
        }
        if let Some(old) = self.workbench_operation(operation)? {
            if old.kind == "history_import" && old.fingerprint == digest {
                return Ok(vec![]);
            }
            return Err(Error::Conflict);
        }
        let op = WorkbenchOperation {
            id: operation.into(),
            task_id: task.into(),
            fingerprint: digest.into(),
            kind: "history_import".into(),
            summary: format!(
                "导入 {} 条文件历史；项目文件未改动 / Imported file history; project files unchanged",
                rows.len()
            ),
            state: "completed".into(),
            at_ms: now_ms(),
            output: None,
            input: None,
            stdout: None,
            stderr: None,
            error: None,
            pid: None,
            preview_port: None,
        };
        let tx = self.connection.transaction()?;
        tx.execute("INSERT INTO workbench_operations(id,task_id,fingerprint,data_json,started) VALUES(?1,?2,?3,?4,1)",params![op.id,task,digest,encode(&op)?])?;
        for r in rows {
            if r.task_id != task
                || r.root_identity != root
                || r.operation_id != operation
                || r.origin.is_none()
            {
                return Err(Error::Conflict);
            }
            tx.execute("INSERT INTO file_revisions(id,task_id,root_identity,path,operation_id,data_json) VALUES(?1,?2,?3,?4,?5,?6)",params![r.id,task,root,r.path,operation,encode(r)?])?;
        }
        let event = record(
            &tx,
            &self.redactor,
            Some(task),
            Some(operation),
            EventSource::User,
            Payload::WorkbenchChanged {
                operation_id: operation.into(),
                state: "history_imported".into(),
                record: None,
            },
        )?;
        tx.commit()?;
        Ok(vec![event])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn partial_import_rolls_back_and_replay_or_stale_policy_cannot_duplicate_history() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path()).unwrap();
        let (task, _) = crate::execution_tests::setup(&mut s);
        let settings = ToolSettings {
            root_path: Some(dir.path().to_string_lossy().into_owned()),
            permission: Some(PermissionMode::RequestApproval),
            ..Default::default()
        };
        let request = Request {
            request_id: id(),
            command: Command::ConfigureTaskTools {
                task_id: task.clone(),
                settings: settings.clone(),
            },
        };
        s.configure_task_tools(&request, &task, &settings, Some("target-root".into()))
            .unwrap();
        let epoch = s.tool_settings(&task).unwrap().epoch;
        let empty = FileImage {
            version: FileVersion {
                exists: false,
                bytes: 0,
                sha256: None,
                identity: None,
            },
            blob: None,
        };
        let row = FileRevision {
            id: id(),
            task_id: task.clone(),
            operation_id: "import-test".into(),
            root_identity: "target-root".into(),
            path: "one.txt".into(),
            previous_path: None,
            change: "deleted".into(),
            source: "history_import".into(),
            at_ms: 1,
            before: empty.clone(),
            after: empty,
            origin: Some(FileRevisionOrigin {
                archive_id: id(),
                revision_id: id(),
                task_id: "original-task".into(),
                operation_id: "original-operation".into(),
                source: "editor".into(),
            }),
        };
        let mut bad = row.clone();
        bad.id = id();
        bad.task_id = "wrong-task".into();
        assert!(
            s.import_history_rows(
                &task,
                "target-root",
                &epoch,
                "import-test",
                "hash",
                &[row.clone(), bad]
            )
            .is_err()
        );
        assert!(
            s.file_history("target-root", None, None, 100)
                .unwrap()
                .is_empty()
        );
        assert!(s.workbench_operation("import-test").unwrap().is_none());
        assert!(
            s.import_history_rows(
                &task,
                "target-root",
                "stale-epoch",
                "import-test",
                "hash",
                std::slice::from_ref(&row)
            )
            .is_err()
        );
        assert_eq!(
            s.import_history_rows(
                &task,
                "target-root",
                &epoch,
                "import-test",
                "hash",
                std::slice::from_ref(&row)
            )
            .unwrap()
            .len(),
            1
        );
        assert!(
            s.import_history_rows(
                &task,
                "target-root",
                &epoch,
                "import-test",
                "hash",
                std::slice::from_ref(&row)
            )
            .unwrap()
            .is_empty()
        );
        drop(s);
        let s = Store::open(dir.path()).unwrap();
        assert_eq!(
            s.file_history("target-root", None, None, 100)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            s.workbench_operation("import-test").unwrap().unwrap().state,
            "completed"
        );
    }
}
