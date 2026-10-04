use super::*;
#[test]
fn archive_attachments_and_revision_images_are_required_roots() {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open_exclusive(dir.path()).unwrap();
    let a = "a".repeat(64);
    let b = "b".repeat(64);
    let c = "c".repeat(64);
    let index = json!({"index":{"media":[{"entry":{"sha256":a}}],"file_history":[{"revision":{"before":{"sha256":b},"after":{"sha256":c}}}]}});
    s.connection
        .execute(
            "INSERT INTO settings VALUES('task-archive:fixture',?1)",
            [encode(&index).unwrap()],
        )
        .unwrap();
    assert_eq!(
        s.maintenance_required_vault_roots().unwrap(),
        BTreeSet::from([a, b, c])
    );
}
#[test]
fn reset_retry_preserves_standalone_task_folder_protection() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open_exclusive(dir.path()).unwrap();
    let (task, _) = crate::execution_tests::setup(&mut s);
    let root = dir
        .path()
        .join("extensions/user-project")
        .to_string_lossy()
        .into_owned();
    let settings = ToolSettings {
        root_path: Some(root.clone()),
        ..Default::default()
    };
    let request = Request {
        request_id: id(),
        command: Command::ConfigureTaskTools {
            task_id: task.clone(),
            settings: settings.clone(),
        },
    };
    s.configure_task_tools(&request, &task, &settings, Some("protected-root".into()))
        .unwrap();
    assert!(s.maintenance_project_paths().unwrap().contains(&root));
    let plan = s.maintenance_plan(&MaintenanceSelection::Reset).unwrap();
    s.maintenance_apply_rows(&plan, None).unwrap();
    drop(s);
    let s = Store::open_exclusive(dir.path()).unwrap();
    assert!(s.maintenance_project_paths().unwrap().contains(&root));
}
#[test]
fn credential_cleanup_uses_original_engine_path_namespace() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open_exclusive(dir.path()).unwrap();
    let (_, mut profile) = crate::execution_tests::setup(&mut s);
    profile.credential = Some(CredentialRef {
        id: "maintenance-synthetic-reference".into(),
    });
    s.connection
        .execute(
            "UPDATE provider_profiles SET data_json=?2 WHERE id=?1",
            params![profile.id, encode(&profile).unwrap()],
        )
        .unwrap();
    let raw = dir.path().to_string_lossy().into_owned();
    s.append(
        None,
        None,
        Payload::Ready {
            pid: 1,
            version: "fixture".into(),
            data_dir: raw.clone(),
        },
    )
    .unwrap();
    let expected = format!("models-{:x}", Sha256::digest(raw.as_bytes()));
    let entries = s.maintenance_credentials().unwrap();
    assert!(
        entries
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["namespace"] == expected && v["id"] == "maintenance-synthetic-reference")
    );
}
#[test]
fn reset_is_atomic_preserves_pending_credential_refs_and_checks_changes() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open_exclusive(dir.path()).unwrap();
    let (task, _) = crate::execution_tests::setup(&mut s);
    let plan = s.maintenance_plan(&MaintenanceSelection::Reset).unwrap();
    s.connection
        .execute("UPDATE tasks SET title='changed' WHERE id=?1", [&task])
        .unwrap();
    assert!(s.maintenance_apply_rows(&plan, None).is_err());
    let plan = s.maintenance_plan(&MaintenanceSelection::Reset).unwrap();
    s.maintenance_apply_rows(&plan, None).unwrap();
    assert!(s.task(&task).is_err());
    assert!(!s.maintenance_cleanup_pending().unwrap().is_null());
    s.maintenance_finish_reset().unwrap();
    assert!(s.maintenance_cleanup_pending().unwrap().is_null());
}
#[test]
fn root_group_deletion_removes_dependants_but_keeps_project_and_tombstones() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open_exclusive(dir.path()).unwrap();
    let (task, _) = crate::execution_tests::setup(&mut s);
    let settings = TeamSettings::default();
    s.configure_team(
        &Request {
            request_id: id(),
            command: Command::ConfigureTeam {
                task_id: task.clone(),
                settings: settings.clone(),
            },
        },
        &task,
        &settings,
    )
    .unwrap();
    let members = vec![
        MemberSpec {
            key: "one".into(),
            role: "one".into(),
            goal: "first".into(),
            profile_id: None,
            depends_on: vec![],
        },
        MemberSpec {
            key: "two".into(),
            role: "two".into(),
            goal: "second".into(),
            profile_id: None,
            depends_on: vec!["one".into()],
        },
    ];
    s.delegate_members(&task, &members, None, None, None)
        .unwrap();
    let children = s.direct_members(&task).unwrap();
    let mut branch = members[0].clone();
    branch.key = "nested".into();
    s.delegate_members(&children[0].task_id, &[branch], None, None, None)
        .unwrap();
    let descendant = s.direct_members(&children[0].task_id).unwrap()[0]
        .task_id
        .clone();
    s.connection
        .execute("UPDATE tasks SET archived=1 WHERE id=?1", [&task])
        .unwrap();
    let plan = s
        .maintenance_plan(&MaintenanceSelection::Tasks {
            root_task_ids: vec![task.clone()],
        })
        .unwrap();
    assert_eq!(plan.tasks.len(), 4);
    s.connection.execute_batch("CREATE TEMP TRIGGER refuse_deletion BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
    assert!(s.maintenance_apply_rows(&plan, None).is_err());
    assert_eq!(s.direct_members(&task).unwrap().len(), 2);
    assert!(s.task(&descendant).is_ok());
    s.connection
        .execute_batch("DROP TRIGGER refuse_deletion;")
        .unwrap();
    s.maintenance_apply_rows(&plan, None).unwrap();
    assert!(s.task(&task).is_err());
    assert!(s.task(&descendant).is_err());
    assert_eq!(
        s.connection
            .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
        0
    );
    assert!(
        s.connection
            .query_row("SELECT count(*) FROM commands", [], |r| r.get::<_, i64>(0))
            .unwrap()
            > 0
    );
}
