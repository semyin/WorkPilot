use super::*;
use serde_json::{Value, json};
use std::sync::atomic::AtomicBool;

fn stop() -> AtomicBool {
    AtomicBool::new(false)
}
fn req(command: Command) -> Request {
    Request {
        request_id: id(),
        command,
    }
}
fn spec(key: &str, deps: &[&str]) -> MemberSpec {
    MemberSpec {
        key: key.into(),
        role: key.into(),
        goal: format!("Assignment {key}"),
        profile_id: None,
        depends_on: deps.iter().map(|v| (*v).into()).collect(),
    }
}
fn add(s: &mut Store, root: &str, specs: &[MemberSpec]) -> Vec<TeamMember> {
    s.delegate_members(root, specs, None, None, None).unwrap();
    s.direct_members(root).unwrap()
}
fn finish(s: &mut Store, task: &str, state: TaskState) -> String {
    let p = s.profile("execution-test").unwrap();
    let run = execution_tests::queue(s, task, &p);
    s.activate_execution(&run).unwrap();
    s.deliver_execution_messages(&run, false).unwrap();
    let input = ModelInput {
        messages: vec![],
        history: vec![],
        tools: vec![],
        tool_results: vec![],
        continuation: None,
        capability_probe: None,
    };
    let step = s.begin_execution_model(&run, &input).unwrap().0;
    let output = ModelOutput {
        text: format!("Saved delivery {task}"),
        tool_calls: vec![],
        continuation: ProviderContinuation {
            protocol: ProtocolKind::Responses,
            response_id: None,
            items: vec![
                json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":"Saved delivery","annotations":[]}]}),
            ],
        },
        finish_reason: "stop".into(),
        actual_model: None,
        usage: Usage {
            input_tokens: Some(3),
            output_tokens: Some(5),
            cost_microunits: None,
            currency: None,
        },
        raw_usage: None,
    };
    s.accept_execution_model(&run, &step, &output).unwrap();
    let mut context = s.execution_snapshot(task).unwrap().context;
    context.history.push(ModelHistoryItem::Message {
        message: ModelMessage {
            role: "assistant".into(),
            content: vec![ModelContent::Text {
                text: output.text.clone(),
            }],
        },
    });
    s.save_execution_context(&run, &context, "saved").unwrap();
    s.finish_execution(&run, state, "test", None).unwrap();
    s.team_publish_reports().unwrap();
    step
}
fn count(s: &Store) -> u32 {
    s.connection
        .query_row("SELECT count(*) FROM tasks", [], |r| r.get(0))
        .unwrap()
}
fn import(s: &mut Store, bundle: TaskArchiveBytes) -> String {
    let archive = bundle.index.archive_id.clone();
    let sha = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&bundle.index).unwrap())
    );
    s.import_task_archive(bundle, &sha, &stop()).unwrap();
    archive
}
fn archive(s: &mut Store, root: &str) -> String {
    let b = s.export_task_archive(root, &stop()).unwrap();
    import(s, b)
}
fn mappings(s: &Store, archive: &str) -> Vec<TaskProfileMapping> {
    s.task_group_restore_options(archive, &stop()).unwrap()["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| TaskProfileMapping {
            task_id: n["task_id"].as_str().unwrap().into(),
            profile_id: "execution-test".into(),
        })
        .collect()
}
fn restore(s: &mut Store, archive: &str) -> Value {
    let profiles = mappings(s, archive);
    let preview = s
        .task_group_restore_preview(archive, None, &profiles, &stop())
        .unwrap();
    s.restore_task_group(
        archive,
        None,
        &profiles,
        preview["fingerprint"].as_str().unwrap(),
        &stop(),
    )
    .unwrap()
    .0
}
fn mapped(receipt: &Value, source: &str) -> String {
    receipt["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["source_task_id"] == source)
        .unwrap()["task_id"]
        .as_str()
        .unwrap()
        .into()
}
#[test]
fn team_restore_keeps_tree_inherited_directions_and_starts_only_after_manual_resume() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let root = task_archive_tests::stopped_team(&mut s);
    s.apply(&req(Command::Enqueue {
        task_id: root.clone(),
        text: "Ancestor requirement 42".into(),
    }))
    .unwrap();
    finish(&mut s, &root, TaskState::Interrupted);
    let members = add(&mut s, &root, &[spec("parent", &[])]);
    let parent = members.last().unwrap().task_id.clone();
    let nested = add(&mut s, &parent, &[spec("nested", &[])]).remove(0);
    let before = serde_json::to_value(s.team_view(&root).unwrap()).unwrap();
    let a = archive(&mut s, &root);
    let receipt = restore(&mut s, &a);
    let next = mapped(&receipt, &root);
    let team = s.team_view(&next).unwrap();
    assert_eq!(team.members.len(), 4);
    assert!(!team.scheduling_enabled);
    assert!(s.team_schedule_candidates().unwrap().is_empty());
    for m in &team.members {
        assert_eq!(m.state, TaskState::Interrupted);
        assert!(!m.pending_start);
        assert!(!s.team_enabled(&m.task_id).unwrap());
        let tools = s.tool_settings(&m.task_id).unwrap();
        assert_eq!(tools.effective_permission, PermissionMode::RequestApproval);
        assert!(!tools.settings.commands_enabled);
        assert!(
            s.execution_snapshot(&m.task_id)
                .unwrap()
                .latest_run
                .is_none()
        );
    }
    let new_nested = mapped(&receipt, &nested.task_id);
    let direction = &s
        .execution_snapshot(&new_nested)
        .unwrap()
        .context
        .directions[0];
    let root_message = &s.execution_snapshot(&next).unwrap().messages[0];
    assert_eq!(direction.message_id, root_message.id);
    assert_ne!(
        direction.message_id,
        s.execution_snapshot(&root).unwrap().messages[0].id
    );
    assert_eq!(
        s.team_member(&new_nested).unwrap().parent_task_id,
        mapped(&receipt, &parent)
    );
    assert_eq!(
        serde_json::to_value(s.team_view(&root).unwrap()).unwrap(),
        before
    );
    s.team_set_enabled(&next, true, true).unwrap();
    let candidates = s.team_schedule_candidates().unwrap();
    assert!(candidates.contains(&mapped(&receipt, &members[0].task_id)));
    assert!(!candidates.contains(&mapped(&receipt, &members[1].task_id)));
    assert!(candidates.contains(&new_nested));
}
#[test]
fn team_restore_preserves_failures_replacements_reviews_and_scoped_historical_reports() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let root = task_archive_tests::stopped_team(&mut s);
    let members = add(
        &mut s,
        &root,
        &[spec("pending-review", &[]), spec("abandoned", &[])],
    );
    let failed = &members[0].task_id;
    finish(&mut s, failed, TaskState::Failed);
    s.replace_member(&root, failed, None, "Try a new assistant", None, None)
        .unwrap();
    let replacement = s.team_member(failed).unwrap().superseded_by.unwrap();
    let step = finish(&mut s, &replacement, TaskState::Completed);
    let report = s.team_member(&replacement).unwrap().report.unwrap();
    s.inspect_member(&root, &replacement, None).unwrap();
    s.review_member(
        &root,
        &replacement,
        &report.object_id,
        true,
        "Checked 42",
        None,
    )
    .unwrap();
    let pending = &members[2].task_id;
    finish(&mut s, pending, TaskState::Completed);
    let old_pending = s.team_member(pending).unwrap().report.unwrap();
    s.inspect_member(&root, pending, None).unwrap();
    let abandoned = &members[3].task_id;
    finish(&mut s, abandoned, TaskState::Failed);
    let old = s.team_member(abandoned).unwrap().report.unwrap();
    s.inspect_member(&root, abandoned, None).unwrap();
    s.review_member(
        &root,
        abandoned,
        &old.object_id,
        false,
        "No longer required",
        None,
    )
    .unwrap();
    let a = archive(&mut s, &root);
    let receipt = restore(&mut s, &a);
    let next = mapped(&receipt, &root);
    let new_failed = mapped(&receipt, failed);
    let new_replacement = mapped(&receipt, &replacement);
    assert_eq!(s.task(&new_failed).unwrap().state, TaskState::Failed);
    assert_eq!(
        s.team_member(&new_failed).unwrap().superseded_by,
        Some(new_replacement.clone())
    );
    let new = s.team_member(&new_replacement).unwrap();
    assert_eq!(new.replaces_id, Some(new_failed.clone()));
    assert_eq!(new.attempt, 1);
    assert_eq!(new.review, "accepted");
    assert_ne!(new.report.as_ref().unwrap().object_id, report.object_id);
    assert_eq!(
        s.team_member(&mapped(&receipt, &members[1].task_id))
            .unwrap()
            .depends_on,
        vec![new_replacement.clone()]
    );
    assert!(s.inspect_member(&next, &replacement, None).is_err());
    assert!(s.inspect_member(&root, &new_replacement, None).is_err());
    let historic = s
        .inspect_member(&next, &new_replacement, Some(&step))
        .unwrap();
    assert_eq!(historic["historical"], true);
    assert!(
        historic["output"]["text"]
            .as_str()
            .unwrap()
            .contains(&replacement)
    );
    assert!(
        s.inspect_member(&next, &mapped(&receipt, pending), Some(&step))
            .is_err()
    );
    let pending = mapped(&receipt, pending);
    let current = s.team_member(&pending).unwrap().report.unwrap();
    assert!(
        s.review_member(
            &next,
            &pending,
            &old_pending.object_id,
            true,
            "Old report",
            None
        )
        .is_err()
    );
    assert!(
        s.review_member(
            &next,
            &pending,
            &current.object_id,
            true,
            "Not inspected",
            None
        )
        .is_err()
    );
    s.inspect_member(&next, &pending, None).unwrap();
    s.review_member(
        &next,
        &pending,
        &current.object_id,
        true,
        "Checked after restoration",
        None,
    )
    .unwrap();
    s.team_set_enabled(&next, true, true).unwrap();
    assert!(!s.team_enabled(&new_failed).unwrap());
    assert!(!s.team_enabled(&new_replacement).unwrap());
    assert!(!s.team_enabled(&mapped(&receipt, abandoned)).unwrap());
    assert_eq!(
        s.restored_team_ids(&pending).unwrap()[&replacement],
        new_replacement
    );
}
#[test]
fn team_restore_rolls_back_whole_tree_and_survives_restart_without_duplicates() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let root = task_archive_tests::stopped_team(&mut s);
    let a = archive(&mut s, &root);
    let map = mappings(&s, &a);
    let plan = s
        .task_group_restore_preview(&a, None, &map, &stop())
        .unwrap();
    let fp = plan["fingerprint"].as_str().unwrap();
    s.connection.execute_batch("CREATE TRIGGER fail_team BEFORE INSERT ON team_dependencies BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END;").unwrap();
    assert!(s.restore_task_group(&a, None, &map, fp, &stop()).is_err());
    assert_eq!(count(&s), 3);
    assert_eq!(
        s.task_group_restore_options(&a, &stop()).unwrap()["already_restored"],
        false
    );
    s.connection
        .execute_batch("DROP TRIGGER fail_team")
        .unwrap();
    let receipt = restore(&mut s, &a);
    assert_eq!(count(&s), 6);
    drop(s);
    let mut s = Store::open(dir.path()).unwrap();
    let repeat = s.restore_task_group(&a, None, &map, fp, &stop()).unwrap().0;
    assert_eq!(repeat["task_id"], receipt["task_id"]);
    assert_eq!(repeat["duplicate"], true);
    assert_eq!(count(&s), 6);
    assert!(s.team_schedule_candidates().unwrap().is_empty());
}
#[test]
fn team_restore_rejects_incomplete_mapping_stale_preview_wrong_models_and_cancellation() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let root = task_archive_tests::stopped_team(&mut s);
    let member = s.direct_members(&root).unwrap()[0].task_id.clone();
    finish(&mut s, &member, TaskState::Completed);
    let a = archive(&mut s, &root);
    let map = mappings(&s, &a);
    assert!(
        s.task_group_restore_preview(&a, None, &map[..2], &stop())
            .is_err()
    );
    let mut duplicate = map.clone();
    duplicate[1] = duplicate[0].clone();
    assert!(
        s.task_group_restore_preview(&a, None, &duplicate, &stop())
            .is_err()
    );
    let plan = s
        .task_group_restore_preview(&a, None, &map, &stop())
        .unwrap();
    let fp = plan["fingerprint"].as_str().unwrap();
    assert!(
        s.restore_task_group(&a, None, &map, fp, &AtomicBool::new(true))
            .is_err()
    );
    assert!(
        s.restore_task_group(&a, None, &map, &"0".repeat(64), &stop())
            .is_err()
    );
    let mut p = s.profile("execution-test").unwrap();
    p.revision += 1;
    s.connection
        .execute(
            "UPDATE provider_profiles SET data_json=?1 WHERE id=?2",
            params![encode(&p).unwrap(), p.id],
        )
        .unwrap();
    assert!(s.restore_task_group(&a, None, &map, fp, &stop()).is_err());
    p.model = "wrong-model".into();
    s.connection
        .execute(
            "UPDATE provider_profiles SET data_json=?1 WHERE id=?2",
            params![encode(&p).unwrap(), p.id],
        )
        .unwrap();
    assert!(
        s.task_group_restore_preview(&a, None, &map, &stop())
            .is_err()
    );
    assert_eq!(count(&s), 3);
}
#[test]
fn team_restore_retains_started_context_and_composes_identifiers_after_another_transfer() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let root = task_archive_tests::stopped_team(&mut s);
    let m = s.direct_members(&root).unwrap();
    finish(&mut s, &m[0].task_id, TaskState::Completed);
    s.team_set_enabled(&root, true, true).unwrap();
    s.prepare_member_start(&m[1].task_id).unwrap();
    finish(&mut s, &m[1].task_id, TaskState::Interrupted);
    s.pause_all_teams().unwrap();
    let before = s.execution_snapshot(&m[1].task_id).unwrap().context.goal;
    let a = archive(&mut s, &root);
    let receipt = restore(&mut s, &a);
    let next = mapped(&receipt, &root);
    let member = mapped(&receipt, &m[1].task_id);
    s.team_set_enabled(&next, true, true).unwrap();
    assert!(
        s.override_member(&next, &member, &spec("review", &["research"]), None)
            .is_err()
    );
    s.prepare_member_start(&member).unwrap();
    assert_eq!(s.execution_snapshot(&member).unwrap().context.goal, before);
    finish(&mut s, &member, TaskState::Interrupted);
    s.pause_all_teams().unwrap();
    let b = archive(&mut s, &next);
    let twice = restore(&mut s, &b);
    let newest = mapped(&twice, &next);
    assert_eq!(
        s.restored_team_ids(&newest).unwrap()[&m[1].task_id],
        mapped(&twice, &member)
    );
    assert_eq!(s.team_view(&newest).unwrap().members.len(), 2);
}
#[test]
fn team_restore_rejects_corrupted_graphs_without_creating_partial_tasks() {
    for case in [
        "cycle",
        "foreign_dependency",
        "wrong_parent_agent",
        "unreciprocated_replacement",
        "missing_report",
        "waiter",
        "duplicate_agent",
        "extra_agent",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path()).unwrap();
        let root = task_archive_tests::stopped_team(&mut s);
        let m = s.direct_members(&root).unwrap();
        match case {
            "cycle" => {
                s.connection
                    .execute(
                        "INSERT INTO team_dependencies(member_id,dependency_id) VALUES(?1,?2)",
                        params![m[0].task_id, m[1].task_id],
                    )
                    .unwrap();
            }
            "foreign_dependency" => {
                let other = task_archive_tests::stopped_team(&mut s);
                let outsider = s.direct_members(&other).unwrap();
                s.connection
                    .execute(
                        "INSERT INTO team_dependencies(member_id,dependency_id) VALUES(?1,?2)",
                        params![m[0].task_id, outsider[0].task_id],
                    )
                    .unwrap();
            }
            "wrong_parent_agent" => {
                s.connection.execute("UPDATE agents SET data_json=json_set(data_json,'$.parent_id',NULL) WHERE task_id=?1",[&m[0].task_id]).unwrap();
            }
            "unreciprocated_replacement" => {
                s.connection
                    .execute(
                        "UPDATE team_members SET superseded_by=?2 WHERE task_id=?1",
                        params![m[0].task_id, m[1].task_id],
                    )
                    .unwrap();
            }
            "missing_report" => {
                s.connection
                    .execute(
                        "UPDATE tasks SET state='completed' WHERE id=?1",
                        [&m[0].task_id],
                    )
                    .unwrap();
            }
            "pending_tool" => {
                s.connection
                    .execute(
                        "UPDATE tasks SET state='awaiting_approval' WHERE id=?1",
                        [&m[0].task_id],
                    )
                    .unwrap();
            }
            _ => {
                // The archive container accepts inert malformed records for inspection;
                // executable restoration must reject them.
                let mut bundle = s.export_task_archive(&root, &stop()).unwrap();
                let mut snapshot: TaskArchiveSnapshot =
                    serde_json::from_slice(&bundle.blobs[&bundle.index.snapshot.object_id])
                        .unwrap();
                if case == "waiter" {
                    snapshot.tables.get_mut("team_waiters").unwrap().push(
                        json!({"task_id":root,"action_id":"old-action","members_json":[m[0].task_id]}),
                    );
                    bundle.index.counts.insert("team_waiters".into(), 1);
                } else if case == "duplicate_agent" {
                    let rows = snapshot.tables.get_mut("agents").unwrap();
                    let duplicate = rows[0]["id"].clone();
                    let child = rows[1]["task_id"].clone();
                    rows[1]["id"] = duplicate.clone();
                    rows[1]["data_json"]["id"] = duplicate.clone();
                    for row in snapshot.tables.get_mut("execution_sessions").unwrap() {
                        if row["task_id"] == child {
                            row["agent_id"] = duplicate.clone();
                        }
                    }
                    for row in snapshot.tables.get_mut("team_members").unwrap() {
                        if row["task_id"] == child {
                            row["data_json"]["agent_id"] = duplicate.clone();
                        }
                    }
                } else {
                    let rows = snapshot.tables.get_mut("agents").unwrap();
                    let mut foreign = rows[0].clone();
                    foreign["id"] = json!("foreign-agent");
                    foreign["task_id"] = json!(root);
                    rows.push(foreign);
                    bundle
                        .index
                        .counts
                        .insert("agents".into(), rows.len() as u32);
                }
                let bytes = serde_json::to_vec(&snapshot).unwrap();
                let hash = format!("{:x}", Sha256::digest(&bytes));
                let old = bundle.index.snapshot.object_id.clone();
                bundle.blobs.remove(&old);
                bundle.index.objects.retain(|r| r.object_id != old);
                let r = ContentRef {
                    object_id: hash.clone(),
                    bytes: bytes.len() as u64,
                    media_type: "application/json".into(),
                };
                bundle.index.snapshot = r.clone();
                bundle.index.objects.push(r);
                bundle.blobs.insert(hash, bytes);
                let a = import(&mut s, bundle);
                assert!(
                    s.task_group_restore_preview(&a, None, &mappings(&s, &a), &stop())
                        .is_err()
                );
                assert_eq!(count(&s), 3);
                continue;
            }
        }
        let before = count(&s);
        let a = archive(&mut s, &root);
        assert!(
            s.task_group_restore_preview(&a, None, &mappings(&s, &a), &stop())
                .is_err(),
            "{case}"
        );
        assert_eq!(count(&s), before);
    }
}
