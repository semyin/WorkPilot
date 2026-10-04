use super::*;
use std::sync::atomic::AtomicBool;

#[test]
fn deleted_migration_files_release_content_but_keep_restart_tombstones_and_live_plans() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open_exclusive(dir.path()).unwrap();
    let project = Project {
        id: id(),
        name: "Migration cleanup".into(),
        root_path: dir.path().join("project").to_string_lossy().into_owned(),
        default_profile_id: None,
        permission: PermissionMode::RequestApproval,
        created_at_ms: now_ms(),
    };
    store.save_project(&project).unwrap();
    let archive = id();
    let deleted_task = store
        .migration_file_task(&archive, "source-one", &project.id)
        .unwrap();
    let live_task = store
        .migration_file_task(&archive, "source-two", &project.id)
        .unwrap();
    let dead_manifest = "a".repeat(64);
    let live_manifest = "b".repeat(64);
    let dead_content = "c".repeat(64);
    let live_content = "d".repeat(64);
    let receipt = json!({"archive_id":archive,"binding":"unchanged-confirmation",
    "files":{
        "source-one":{"task_id":deleted_task,"operation_id":"first-operation",
            "manifest_blob":dead_manifest,"files":[{"path":"first.txt","sha256":dead_content}],"state":"completed"},
        "source-two":{"task_id":live_task,"operation_id":"second-operation",
            "manifest_blob":live_manifest,"files":[{"path":"second.txt","sha256":live_content}],"state":"awaiting_approval"}
    }});
    store.save_migration_receipt(&archive, &receipt).unwrap();
    let mut histories = vec![];
    for task in [&deleted_task, &live_task] {
        let history = store
            .save_json(json!({"profile":null,"results":{},"test_owner":task}))
            .unwrap();
        store
            .connection
            .execute(
                "INSERT INTO settings VALUES(?1,?2)",
                params![
                    format!("task-restored-history:{task}"),
                    encode(&history).unwrap()
                ],
            )
            .unwrap();
        record(
            &store.connection,
            &store.redactor,
            Some(task),
            None,
            EventSource::Recovery,
            Payload::TaskRestored {
                archive_id: archive.clone(),
                source_task_id: task.clone(),
                history: history.clone(),
            },
        )
        .unwrap();
        histories.push(history);
    }
    let restore_receipt = json!({"task_id":deleted_task,"title":"Deleted restored task"});
    store
        .connection
        .execute(
            "INSERT INTO settings VALUES(?1,?2)",
            params![
                format!("task-restore:{archive}"),
                encode(&restore_receipt).unwrap()
            ],
        )
        .unwrap();
    store
        .connection
        .execute("UPDATE tasks SET archived=1 WHERE id=?1", [&deleted_task])
        .unwrap();
    let selection = MaintenanceSelection::Tasks {
        root_task_ids: vec![deleted_task.clone()],
    };
    let plan = store.maintenance_plan(&selection).unwrap();
    store.connection.execute_batch("CREATE TEMP TRIGGER keep_task BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT,'fixture deletion failure'); END;").unwrap();
    assert!(store.maintenance_apply_rows(&plan, None).is_err());
    assert_eq!(store.migration_receipt(&archive).unwrap().unwrap(), receipt);
    assert!(store.task(&deleted_task).is_ok());
    store
        .connection
        .execute_batch("DROP TRIGGER keep_task;")
        .unwrap();
    store.maintenance_apply_rows(&plan, None).unwrap();
    drop(store);

    let mut store = Store::open_exclusive(dir.path()).unwrap();
    let after = store.migration_receipt(&archive).unwrap().unwrap();
    assert_eq!(after["binding"], receipt["binding"]);
    assert_eq!(after["files"]["source-two"], receipt["files"]["source-two"]);
    assert_eq!(
        after["files"]["source-one"],
        json!({"task_id":deleted_task,
        "operation_id":"first-operation","state":"deleted","deleted":true,"files":[]})
    );
    let roots = store.maintenance_vault_roots().unwrap();
    let required = store.maintenance_required_vault_roots().unwrap();
    assert!(!roots.contains(&dead_manifest));
    assert!(!roots.contains(&dead_content));
    assert!(!required.contains(&dead_manifest));
    assert!(roots.contains(&live_manifest));
    assert!(roots.contains(&live_content));
    assert!(required.contains(&live_manifest));
    let indexed = |task: &str| -> bool {
        store
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM settings WHERE key=?1)",
                [format!("task-restored-history:{task}")],
                |r| r.get(0),
            )
            .unwrap()
    };
    assert!(!indexed(&deleted_task));
    assert!(indexed(&live_task));
    store.collect_unreferenced_objects().unwrap();
    assert!(store.read_json::<Value>(&histories[0]).is_err());
    assert!(store.read_json::<Value>(&histories[1]).is_ok());
    let status = store
        .task_restore_preview(&archive, None, "unused-profile", &AtomicBool::new(false))
        .unwrap();
    assert_eq!(status["deleted"], true);
    assert_eq!(status["already_restored"], true);
    assert!(
        store
            .migration_file_task(&archive, "source-one", &project.id)
            .is_err()
    );
    assert!(store.task(&deleted_task).is_err());
    assert!(store.task(&live_task).is_ok());
}
