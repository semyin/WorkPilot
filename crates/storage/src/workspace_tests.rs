use super::execution_tests::{queue, setup};
use super::*;
fn request(command: Command) -> Request {
    Request {
        request_id: id(),
        command,
    }
}
fn action(s: &mut Store, a: WorkspaceAction) -> Result<WorkspaceData> {
    s.workspace_action(
        &request(Command::Workspace { action: a.clone() }),
        &a,
        Some("test-directory".into()),
    )
    .map(|r| r.0)
}
#[test]
fn project_defaults_are_frozen_for_new_tasks() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let (t, p) = setup(&mut s);
    let settings = ProjectSettings {
        name: "资料".into(),
        root_path: dir.path().to_string_lossy().into_owned(),
        default_profile_id: Some(p.id.clone()),
        permission: PermissionMode::AutoReview,
        rules: "Use Chinese".into(),
        revision: 0,
    };
    let WorkspaceData::ProjectSaved { project } = action(
        &mut s,
        WorkspaceAction::SaveProject {
            project_id: None,
            settings,
        },
    )
    .unwrap() else {
        panic!()
    };
    let mut config = s.execution_snapshot(&t).unwrap().config;
    config.project_id = Some(project.id.clone());
    config.profile_id = None;
    config.project_rules = "Keep files".into();
    let t = s
        .create_execution(
            &request(Command::CreateExecution {
                config: Box::new(config.clone()),
            }),
            &config,
        )
        .unwrap()
        .0
        .task_id
        .unwrap();
    assert_eq!(s.task(&t).unwrap().profile_id, Some(p.id));
    assert_eq!(
        s.execution_snapshot(&t).unwrap().context.project_rules,
        "Use Chinese\nKeep files"
    );
    let mut next = project.settings;
    next.permission = PermissionMode::FullAccess;
    action(
        &mut s,
        WorkspaceAction::SaveProject {
            project_id: Some(project.id.clone()),
            settings: next.clone(),
        },
    )
    .unwrap();
    assert_eq!(
        s.tool_settings(&t).unwrap().effective_permission,
        PermissionMode::AutoReview
    );
    assert!(matches!(
        action(
            &mut s,
            WorkspaceAction::SaveProject {
                project_id: Some(project.id),
                settings: next
            }
        ),
        Err(Error::Conflict)
    ));
}
#[test]
fn queued_edits_compare_original_content_and_cannot_rewrite_delivery() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let (t, _) = setup(&mut s);
    s.apply(&request(Command::Enqueue {
        task_id: t.clone(),
        text: "before".into(),
    }))
    .unwrap();
    let m = s.execution_snapshot(&t).unwrap().messages[0].clone();
    let edit = WorkspaceAction::EditMessage {
        task_id: t.clone(),
        message_id: m.id.clone(),
        expected_object_id: m.content.object_id.clone(),
        text: "after".into(),
    };
    action(&mut s, edit.clone()).unwrap();
    assert!(matches!(action(&mut s, edit), Err(Error::Conflict)));
    let m = s.execution_snapshot(&t).unwrap().messages[0].clone();
    assert_eq!(s.read_text_value(&m.content).unwrap(), "after");
    s.connection
        .execute("UPDATE messages SET state='delivered' WHERE id=?1", [&m.id])
        .unwrap();
    assert!(matches!(
        action(
            &mut s,
            WorkspaceAction::CancelMessage {
                task_id: t,
                message_id: m.id,
                expected_object_id: m.content.object_id
            }
        ),
        Err(Error::Conflict)
    ));
}
#[test]
fn archive_search_restore_and_active_guard() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let (t, p) = setup(&mut s);
    action(
        &mut s,
        WorkspaceAction::RenameTask {
            task_id: t.clone(),
            title: "Daily notes".into(),
        },
    )
    .unwrap();
    action(
        &mut s,
        WorkspaceAction::ArchiveTask {
            task_id: t.clone(),
            archived: true,
        },
    )
    .unwrap();
    assert!(s.execution_tasks(32).unwrap().is_empty());
    let WorkspaceData::Tasks { tasks, .. } = s
        .workspace_query(&WorkspaceQuery::Tasks {
            project_id: None,
            archived: true,
            search: "DAILY".into(),
            before: None,
            limit: 16,
        })
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(tasks.len(), 1);
    assert!(
        s.queue_execution(
            &request(Command::StartExecution { task_id: t.clone() }),
            &t,
            &p
        )
        .is_err()
    );
    action(
        &mut s,
        WorkspaceAction::ArchiveTask {
            task_id: t.clone(),
            archived: false,
        },
    )
    .unwrap();
    queue(&mut s, &t, &p);
    assert!(matches!(
        action(
            &mut s,
            WorkspaceAction::ArchiveTask {
                task_id: t,
                archived: true
            }
        ),
        Err(Error::Busy)
    ));
}
#[test]
fn record_export_is_complete_redacted_and_cannot_follow_foreign_references() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let (t, _) = setup(&mut s);
    let private = s.text("UNRELATED_PRIVATE_DOCUMENT").unwrap();
    s.register_secret("abc-secret-value").unwrap();
    let malicious = s
        .save_json(
            serde_json::json!({"nested":private,"text":"Export needle token=abc-secret-value"}),
        )
        .unwrap();
    s.append(
        Some(&t),
        None,
        Payload::TextDelta {
            content: malicious.clone(),
        },
    )
    .unwrap();
    let inspector = Inspector::open(dir.path()).unwrap();
    let WorkspaceData::SearchRecords { events, .. } = inspector
        .search_workspace_records(dir.path(), &t, "EXPORT NEEDLE", 0, 64)
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(events.len(), 1);
    let WorkspaceData::Conversation { entries, .. } = s
        .workspace_query(&WorkspaceQuery::Conversation {
            task_id: t.clone(),
            before: None,
            limit: 24,
        })
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(entries[0].text, "Original goal");
    let req = request(Command::Workspace {
        action: WorkspaceAction::ExportRecords { task_id: t.clone() },
    });
    assert!(s.begin_workspace_export(&req, &t).unwrap().is_none());
    let data = inspector
        .export_workspace_records(&s.directory, &t)
        .unwrap();
    let WorkspaceData::Exported { path, events, .. } = &data else {
        panic!()
    };
    assert!(*events > 2);
    assert!(
        !Path::new(path)
            .join("objects")
            .join(private.object_id)
            .exists()
    );
    assert!(
        Path::new(path)
            .join("objects")
            .join(&malicious.object_id)
            .exists()
    );
    let exported_text =
        std::fs::read_to_string(Path::new(path).join("objects").join(&malicious.object_id))
            .unwrap();
    assert!(!exported_text.contains("abc-secret-value"));
    assert!(exported_text.contains("REDACTED"));
    s.finish_workspace_export(&req, &t, &data).unwrap();
    assert!(matches!(
        s.begin_workspace_export(&req, &t).unwrap(),
        Some(WorkspaceData::Exported { .. })
    ));
}
#[test]
fn hundred_thousand_events_keep_detail_and_search_page_bounded() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let (t, _) = setup(&mut s);
    let tx = s.connection.transaction().unwrap();
    for i in 0..100_000 {
        record(
            &tx,
            &s.redactor,
            Some(&t),
            None,
            EventSource::Engine,
            Payload::Progress {
                current: i,
                total: 100_000,
            },
        )
        .unwrap();
    }
    tx.commit().unwrap();
    let start = std::time::Instant::now();
    let detail = s
        .workspace_query(&WorkspaceQuery::Detail { task_id: t.clone() })
        .unwrap();
    let bytes = encode(&detail).unwrap().len();
    assert!(bytes < 32_000);
    let inspector = Inspector::open(dir.path()).unwrap();
    let WorkspaceData::SearchRecords {
        events, has_more, ..
    } = inspector
        .search_workspace_records(dir.path(), &t, "progress", 0, 64)
        .unwrap()
    else {
        panic!()
    };
    assert!(has_more);
    assert!(events.len() <= 64);
    eprintln!(
        "P06 100000 events: detail bytes={bytes}, detail + search page elapsed={:?}",
        start.elapsed()
    );
}
