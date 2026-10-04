use super::*;
use serde_json::{Value, json};
use std::sync::atomic::AtomicBool;
fn stop() -> AtomicBool {
    AtomicBool::new(false)
}
fn request(command: Command) -> Request {
    Request {
        request_id: id(),
        command,
    }
}
fn archive(s: &mut Store, task: &str) -> String {
    let bundle = s.export_task_archive(task, &stop()).unwrap();
    let id = bundle.index.archive_id.clone();
    let digest = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&bundle.index).unwrap())
    );
    s.import_task_archive(bundle, &digest, &stop()).unwrap();
    id
}
fn pending(s: &mut Store, task: &str, p: &ProviderProfile, name: &str) -> (String, String) {
    let run = execution_tests::queue(s, task, p);
    s.activate_execution(&run).unwrap();
    let input = ModelInput {
        history: vec![],
        messages: vec![],
        tools: vec![],
        tool_results: vec![],
        continuation: None,
        capability_probe: None,
    };
    let model = s.begin_execution_model(&run, &input).unwrap().0;
    let output = ModelOutput {
        text: String::new(),
        tool_calls: vec![ModelToolCall {
            id: "old-call".into(),
            name: name.into(),
            arguments: json!({}),
            provider_item_id: None,
        }],
        continuation: ProviderContinuation {
            protocol: p.protocol,
            response_id: None,
            items: vec![match p.protocol {
                ProtocolKind::Responses => {
                    json!({"type":"function_call","call_id":"old-call","name":name,"arguments":"{}"})
                }
                ProtocolKind::ChatCompletions => {
                    json!({"role":"assistant","content":null,"tool_calls":[{"id":"old-call","type":"function","function":{"name":name,"arguments":"{}"}}]})
                }
                ProtocolKind::Messages => {
                    json!({"type":"tool_use","id":"old-call","name":name,"input":{}})
                }
            }],
        },
        finish_reason: "tool_calls".into(),
        actual_model: None,
        usage: Usage {
            input_tokens: None,
            output_tokens: None,
            cost_microunits: None,
            currency: None,
        },
        raw_usage: None,
    };
    s.accept_execution_model(&run, &model, &output).unwrap();
    let action = s
        .execution_snapshot(task)
        .unwrap()
        .context
        .pending
        .unwrap()
        .action_ids[0]
        .clone();
    (run, action)
}
#[test]
fn pending_batches_restore_as_reviewed_history_in_all_three_protocols() {
    for protocol in [
        ProtocolKind::Responses,
        ProtocolKind::ChatCompletions,
        ProtocolKind::Messages,
    ] {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path()).unwrap();
        let (task, mut p) = execution_tests::setup(&mut s);
        p.protocol = protocol;
        s.connection
            .execute(
                "UPDATE provider_profiles SET data_json=?2 WHERE id=?1",
                params![p.id, encode(&p).unwrap()],
            )
            .unwrap();
        let (run, _) = pending(&mut s, &task, &p, "write_file");
        s.finish_execution(&run, TaskState::AwaitingApproval, "awaiting review", None)
            .unwrap();
        let a = archive(&mut s, &task);
        let next = restore(&mut s, &a, &p);
        let snapshot = s.execution_snapshot(&next).unwrap();
        assert!(snapshot.context.pending.is_none());
        let ModelHistoryItem::Exchange { tool_results, .. } = &snapshot.context.history[0] else {
            panic!()
        };
        assert_eq!(tool_results.len(), 1);
        assert!(tool_results[0].is_error);
        assert!(
            tool_results[0]
                .output
                .contains("migration_requires_reconciliation")
        );
        assert_eq!(
            s.migration_recovery_status(&next).unwrap()["required"],
            true
        );
    }
}
fn restore(s: &mut Store, a: &str, p: &ProviderProfile) -> String {
    let preview = s.task_restore_preview(a, None, &p.id, &stop()).unwrap();
    s.restore_task_archive(
        a,
        None,
        &p.id,
        preview["fingerprint"].as_str().unwrap(),
        &stop(),
    )
    .unwrap()
    .0["task_id"]
        .as_str()
        .unwrap()
        .into()
}
#[test]
fn migrated_unknown_effect_is_blocked_until_explicit_review_survives_restart_and_never_replays() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let (task, p) = execution_tests::setup(&mut s);
    let (run, action) = pending(&mut s, &task, &p, "sample_write");
    s.begin_execution_action(&run, &action).unwrap();
    s.apply_controlled_effect(&run, &action, "sample", "already happened")
        .unwrap();
    s.finish_execution(&run, TaskState::Interrupted, "test-stop", None)
        .unwrap();
    let a = archive(&mut s, &task);
    let next = restore(&mut s, &a, &p);
    let snap = s.execution_snapshot(&next).unwrap();
    assert!(snap.context.pending.is_none());
    assert!(snap.latest_run.is_none());
    let status = s.migration_recovery_status(&next).unwrap();
    assert_eq!(status["required"], true);
    let start = request(Command::StartExecution {
        task_id: next.clone(),
    });
    assert!(s.queue_execution(&start, &next, &p).is_err());
    s.apply(&request(Command::Enqueue {
        task_id: next.clone(),
        text: "queued instructions cannot bypass review".into(),
    }))
    .unwrap();
    assert!(s.queue_execution(&start, &next, &p).is_err());
    assert!(
        s.resolve_migration_recovery(&next, &["one insufficient item".into()])
            .is_err()
    );
    let notes = status["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|_| {
            "Confirmed original sample already happened; inspect destination before any new action."
                .into()
        })
        .collect::<Vec<_>>();
    drop(s);
    let mut s = Store::open(dir.path()).unwrap();
    assert_eq!(
        s.migration_recovery_status(&next).unwrap()["required"],
        true
    );
    s.resolve_migration_recovery(&next, &notes).unwrap();
    assert_eq!(
        s.migration_recovery_status(&next).unwrap()["required"],
        false
    );
    assert!(s.execution_snapshot(&next).unwrap().latest_run.is_none());
    assert!(s.queue_execution(&start, &next, &p).is_ok());
    assert_eq!(
        s.connection
            .query_row("SELECT count(*) FROM controlled_effects", [], |r| r
                .get::<_, u32>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        s.tool_settings(&next).unwrap().effective_permission,
        PermissionMode::RequestApproval
    );
}
#[test]
fn migrated_command_pages_keep_owned_streams_and_reject_other_tasks_and_channels() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let (task, p) = execution_tests::setup(&mut s);
    let (run, action) = pending(&mut s, &task, &p, "run_command");
    s.begin_execution_action(&run, &action).unwrap();
    let stdout = s.save_tool_text(&action, "first\nsecond\nthird\n").unwrap();
    let stderr = s.save_tool_text(&action, "stderr content").unwrap();
    s.complete_execution_action(
        &run,
        &action,
        &ModelToolResult {
            call_id: "old-call".into(),
            output: json!({"stdout":stdout,"stderr":stderr}).to_string(),
            is_error: false,
        },
        None,
        None,
        "tool",
    )
    .unwrap();
    s.finish_execution(&run, TaskState::Completed, "done", None)
        .unwrap();
    let a = archive(&mut s, &task);
    let next = restore(&mut s, &a, &p);
    s.apply(&request(Command::Enqueue {
        task_id: next.clone(),
        text: "Read historical command output".into(),
    }))
    .unwrap();
    let new_run = execution_tests::queue(&mut s, &next, &p);
    let page = s
        .read_command_output(&new_run, &action, "stdout", 6, 7)
        .unwrap();
    assert_eq!(page["text"], "second\n");
    assert!(
        s.read_command_output(&new_run, &action, "foreign", 0, 20)
            .is_err()
    );
    let (other, op) = execution_tests::setup(&mut s);
    let other_run = execution_tests::queue(&mut s, &other, &op);
    assert!(
        s.read_command_output(&other_run, &action, "stdout", 0, 20)
            .is_err()
    );
}
#[test]
fn approved_state_without_pending_payload_still_requires_review_and_deleted_restore_is_not_recreated()
 {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let (task, p) = execution_tests::setup(&mut s);
    s.connection
        .execute(
            "UPDATE tasks SET state='awaiting_approval' WHERE id=?1",
            [&task],
        )
        .unwrap();
    let a = archive(&mut s, &task);
    let next = restore(&mut s, &a, &p);
    assert_eq!(
        s.migration_recovery_status(&next).unwrap()["required"],
        true
    );
    let initial = s.task_restore_preview(&a, None, &p.id, &stop()).unwrap();
    assert_eq!(initial["deleted"], false);
    s.connection
        .execute("DELETE FROM tasks WHERE id=?1", [&next])
        .unwrap();
    let deleted = s.task_restore_preview(&a, None, &p.id, &stop()).unwrap();
    assert_eq!(deleted["already_restored"], true);
    assert_eq!(deleted["deleted"], true);
    assert_eq!(restore(&mut s, &a, &p), next);
    assert!(s.task(&next).is_err());
}
#[test]
fn mapped_restore_requires_exact_projects_and_keeps_each_history_folder_separate() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let (task, p) = execution_tests::setup(&mut s);
    let mut project_ids = vec![];
    for n in 0..2 {
        let action = WorkspaceAction::SaveProject {
            project_id: None,
            settings: ProjectSettings {
                name: format!("Project {n}"),
                root_path: format!("synthetic/{n}"),
                default_profile_id: None,
                permission: PermissionMode::FullAccess,
                rules: String::new(),
                revision: 0,
            },
        };
        let req = request(Command::Workspace {
            action: action.clone(),
        });
        let WorkspaceData::ProjectSaved { project } = s
            .workspace_action(&req, &action, Some(format!("target-{n}")))
            .unwrap()
            .0
        else {
            panic!()
        };
        project_ids.push(project.id);
    }
    let mut b = s.export_task_archive(&task, &stop()).unwrap();
    for n in 0..2 {
        let image = PortableFileImage {
            exists: true,
            bytes: 0,
            sha256: Some(format!("{:x}", Sha256::digest([]))),
        };
        b.index.file_history.push(TaskArchiveHistory {
            root_identity: format!("source-{n}"),
            revision: PortableFileRevision {
                id: id(),
                task_id: task.clone(),
                operation_id: id(),
                path: "same.txt".into(),
                previous_path: None,
                change: "modified".into(),
                source: "test".into(),
                at_ms: 1,
                before: image.clone(),
                after: image,
                origin: None,
            },
        });
    }
    let a = b.index.archive_id.clone();
    let sha = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&b.index).unwrap())
    );
    s.import_task_archive(b, &sha, &stop()).unwrap();
    let profiles = [TaskProfileMapping {
        task_id: task.clone(),
        profile_id: p.id.clone(),
    }];
    let projects = [TaskProjectMapping {
        source_project_id: None,
        project_id: Some(project_ids[0].clone()),
    }];
    let roots = (0..2)
        .map(|n| HistoryRootMapping {
            source_root: format!("source-{n}"),
            project_id: project_ids[n].clone(),
        })
        .collect::<Vec<_>>();
    assert!(
        s.mapped_task_restore_preview(&a, &profiles, &[], &roots, &stop())
            .is_err()
    );
    assert!(
        s.mapped_task_restore_preview(&a, &profiles, &projects, &roots[..1], &stop())
            .is_err()
    );
    let p = s
        .mapped_task_restore_preview(&a, &profiles, &projects, &roots, &stop())
        .unwrap();
    s.restore_mapped_task_group(
        &a,
        &profiles,
        &projects,
        &roots,
        p["fingerprint"].as_str().unwrap(),
        &[],
        &stop(),
    )
    .unwrap();
    let counts: Value = s
        .connection
        .query_row(
            "SELECT json_group_array(root_identity) FROM file_revisions",
            [],
            |r| r.get::<_, String>(0),
        )
        .map(|v| serde_json::from_str(&v).unwrap())
        .unwrap();
    assert_eq!(counts, json!(["target-0", "target-1"]));
}
