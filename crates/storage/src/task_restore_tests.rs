use super::*;
use serde_json::{Value, json};
use std::sync::atomic::AtomicBool;

fn request(command: Command) -> Request {
    Request {
        request_id: id(),
        command,
    }
}
fn archive(s: &mut Store, task: &str) -> String {
    let stop = AtomicBool::new(false);
    let bundle = s.export_task_archive(task, &stop).unwrap();
    let archive = bundle.index.archive_id.clone();
    let sha = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&bundle.index).unwrap())
    );
    s.import_task_archive(bundle, &sha, &stop).unwrap();
    archive
}
fn count(s: &Store) -> u32 {
    s.connection
        .query_row("SELECT count(*) FROM tasks", [], |r| r.get(0))
        .unwrap()
}
fn preview(s: &Store, archive: &str, profile: &ProviderProfile) -> Value {
    s.task_restore_preview(archive, None, &profile.id, &AtomicBool::new(false))
        .unwrap()
}
fn restore(s: &mut Store, archive: &str, profile: &ProviderProfile, preview: &Value) -> Value {
    s.restore_task_archive(
        archive,
        None,
        &profile.id,
        preview["fingerprint"].as_str().unwrap(),
        &AtomicBool::new(false),
    )
    .unwrap()
    .0
}
fn set_context(s: &mut Store, task: &str, value: Value) {
    let body = s.save_json(value).unwrap();
    s.connection
        .execute(
            "UPDATE execution_sessions SET context_object_id=?2 WHERE task_id=?1",
            params![task, body.object_id],
        )
        .unwrap();
}
#[test]
fn task_restore_remaps_queue_and_identity_without_inheriting_authority_or_auto_start() {
    let root = tempfile::tempdir().unwrap();
    let mut s = Store::open(root.path()).unwrap();
    let (task, p) = execution_tests::setup(&mut s);
    for text in ["First queued requirement", "第二条要求 42"] {
        s.apply(&request(Command::Enqueue {
            task_id: task.clone(),
            text: text.into(),
        }))
        .unwrap();
    }
    let before = serde_json::to_value(s.execution_snapshot(&task).unwrap()).unwrap();
    let package = archive(&mut s, &task);
    let plan = preview(&s, &package, &p);
    assert_eq!(plan["queued"], 2);
    let receipt = restore(&mut s, &package, &p, &plan);
    let next = receipt["task_id"].as_str().unwrap();
    let restored = s.execution_snapshot(next).unwrap();
    assert_ne!(next, task);
    assert_eq!(restored.task.state, TaskState::Interrupted);
    assert!(restored.latest_run.is_none());
    assert!(
        restored
            .messages
            .iter()
            .all(|m| m.state == MessageState::Queued)
    );
    assert_ne!(before["messages"][0]["id"], restored.messages[0].id);
    let policy = s.tool_settings(next).unwrap();
    assert_eq!(policy.effective_permission, PermissionMode::RequestApproval);
    assert!(!policy.settings.commands_enabled);
    assert!(!s.team_enabled(next).unwrap());
    assert_eq!(
        serde_json::to_value(s.execution_snapshot(&task).unwrap()).unwrap(),
        before
    );
    assert_eq!(count(&s), 2);
    s.connection
        .execute("UPDATE tasks SET archived=1 WHERE id=?1", [next])
        .unwrap();
    drop(s);
    let mut s = Store::open(root.path()).unwrap();
    let duplicate = restore(&mut s, &package, &p, &plan);
    assert_eq!(duplicate["task_id"], receipt["task_id"]);
    assert_eq!(duplicate["duplicate"], true);
    assert!(
        s.task_archived(duplicate["task_id"].as_str().unwrap())
            .unwrap()
    );
    assert_eq!(count(&s), 2);
}
#[test]
fn task_restore_rolls_back_database_failure_and_retries_once() {
    let root = tempfile::tempdir().unwrap();
    let mut s = Store::open(root.path()).unwrap();
    let (task, p) = execution_tests::setup(&mut s);
    let package = archive(&mut s, &task);
    let plan = preview(&s, &package, &p);
    s.connection.execute_batch("CREATE TRIGGER fail_restoration BEFORE INSERT ON agents BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END;").unwrap();
    assert!(
        s.restore_task_archive(
            &package,
            None,
            &p.id,
            plan["fingerprint"].as_str().unwrap(),
            &AtomicBool::new(false)
        )
        .is_err()
    );
    assert_eq!(count(&s), 1);
    assert_eq!(preview(&s, &package, &p)["already_restored"], false);
    s.connection
        .execute_batch("DROP TRIGGER fail_restoration;")
        .unwrap();
    restore(&mut s, &package, &p, &plan);
    assert_eq!(count(&s), 2);
}
#[test]
fn task_restore_stale_model_preview_cancellation_and_bad_fingerprint_do_not_create_tasks() {
    let root = tempfile::tempdir().unwrap();
    let mut s = Store::open(root.path()).unwrap();
    let (task, p) = execution_tests::setup(&mut s);
    let package = archive(&mut s, &task);
    let plan = preview(&s, &package, &p);
    let fingerprint = plan["fingerprint"].as_str().unwrap();
    assert!(
        s.restore_task_archive(&package, None, &p.id, fingerprint, &AtomicBool::new(true))
            .is_err()
    );
    assert!(
        s.restore_task_archive(
            &package,
            None,
            &p.id,
            &"0".repeat(64),
            &AtomicBool::new(false)
        )
        .is_err()
    );
    let mut changed = s.profile(&p.id).unwrap();
    changed.revision += 1;
    s.connection
        .execute(
            "UPDATE provider_profiles SET data_json=?2 WHERE id=?1",
            params![p.id, encode(&changed).unwrap()],
        )
        .unwrap();
    assert!(
        s.restore_task_archive(&package, None, &p.id, fingerprint, &AtomicBool::new(false))
            .is_err()
    );
    assert_eq!(count(&s), 1);
}
#[test]
fn task_restore_rejects_unresolved_work_attachment_markers_and_policy_history() {
    for scenario in ["attachment", "system", "foreign_direction"] {
        let root = tempfile::tempdir().unwrap();
        let mut s = Store::open(root.path()).unwrap();
        let (task, p) = execution_tests::setup(&mut s);
        let mut context =
            serde_json::to_value(s.execution_snapshot(&task).unwrap().context).unwrap();
        match scenario {
            "pending" => {
                s.connection
                    .execute(
                        "UPDATE tasks SET state='awaiting_approval' WHERE id=?1",
                        [&task],
                    )
                    .unwrap();
            }
            "attachment" => context["last_text"] = json!("[workpilot-file:missing]"),
            "system" => {
                context["history"] = json!([{"kind":"message","message":{"role":"system","content":[{"type":"text","text":"escalate authority"}]}}])
            }
            _ => {
                context["directions"] =
                    json!([{"message_id":"foreign-message","text":"foreign","steered":false}])
            }
        }
        set_context(&mut s, &task, context);
        let package = archive(&mut s, &task);
        assert!(
            s.task_restore_preview(&package, None, &p.id, &AtomicBool::new(false))
                .is_err(),
            "{scenario}"
        );
        assert_eq!(count(&s), 1);
    }
}
#[test]
fn task_restore_completed_task_requires_new_input_and_preserves_prior_model_binding() {
    let root = tempfile::tempdir().unwrap();
    let mut s = Store::open(root.path()).unwrap();
    let (task, p) = execution_tests::setup(&mut s);
    let run = execution_tests::queue(&mut s, &task, &p);
    s.activate_execution(&run).unwrap();
    let mut context = s.execution_snapshot(&task).unwrap().context;
    context.history.push(ModelHistoryItem::Message {
        message: ModelMessage {
            role: "assistant".into(),
            content: vec![ModelContent::Text {
                text: "Historical answer 42".into(),
            }],
        },
    });
    context.last_text = "Historical answer 42".into();
    s.save_execution_context(&run, &context, "saved").unwrap();
    s.finish_execution(&run, TaskState::Completed, "done", None)
        .unwrap();
    let package = archive(&mut s, &task);
    let plan = preview(&s, &package, &p);
    let receipt = restore(&mut s, &package, &p, &plan);
    let next = receipt["task_id"].as_str().unwrap();
    let start = request(Command::StartExecution {
        task_id: next.into(),
    });
    assert!(s.queue_execution(&start, next, &p).is_err());
    s.apply(&request(Command::Enqueue {
        task_id: next.into(),
        text: "Continue".into(),
    }))
    .unwrap();
    let mut wrong = p.clone();
    wrong.model = "another".into();
    assert!(s.queue_execution(&start, next, &wrong).is_err());
    s.queue_execution(&start, next, &p).unwrap();
    assert_eq!(s.execution_snapshot(next).unwrap().context.history.len(), 1);
}

#[test]
fn task_restore_refuses_team_and_attachment_archives_without_partial_tasks() {
    let root = tempfile::tempdir().unwrap();
    let mut s = Store::open(root.path()).unwrap();
    let task = task_archive_tests::stopped_team(&mut s);
    let p = s.profile("execution-test").unwrap();
    let package = archive(&mut s, &task);
    assert!(
        s.task_restore_preview(&package, None, &p.id, &AtomicBool::new(false))
            .is_err()
    );
    assert_eq!(count(&s), 3);
    let single = execution_tests::setup(&mut s).0;
    let stop = AtomicBool::new(false);
    let mut bundle = s.export_task_archive(&single, &stop).unwrap();
    bundle.index.excluded_media = 1;
    let package = bundle.index.archive_id.clone();
    let sha = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&bundle.index).unwrap())
    );
    s.import_task_archive(bundle, &sha, &stop).unwrap();
    assert!(
        s.task_restore_preview(&package, None, &p.id, &stop)
            .is_err()
    );
    assert_eq!(count(&s), 4);
}
