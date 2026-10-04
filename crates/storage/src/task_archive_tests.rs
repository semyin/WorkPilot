use super::*;
use serde_json::json;
use std::sync::atomic::AtomicBool;
fn req(command: Command) -> Request {
    Request {
        request_id: id(),
        command,
    }
}
fn sha(index: &TaskArchiveIndex) -> String {
    format!("{:x}", Sha256::digest(serde_json::to_vec(index).unwrap()))
}
pub(super) fn stopped_team(s: &mut Store) -> String {
    let (root, _) = execution_tests::setup(s);
    let settings = TeamSettings::default();
    s.configure_team(
        &req(Command::ConfigureTeam {
            task_id: root.clone(),
            settings: settings.clone(),
        }),
        &root,
        &settings,
    )
    .unwrap();
    s.delegate_members(
        &root,
        &[
            MemberSpec {
                key: "research".into(),
                role: "Research".into(),
                goal: "Find the records".into(),
                profile_id: None,
                depends_on: vec![],
            },
            MemberSpec {
                key: "review".into(),
                role: "Review".into(),
                goal: "Check evidence".into(),
                profile_id: None,
                depends_on: vec!["research".into()],
            },
        ],
        None,
        None,
        None,
    )
    .unwrap();
    root
}
#[test]
fn task_archive_transfers_complete_tree_long_bodies_and_pages_without_live_state() {
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let mut s = Store::open(source.path()).unwrap();
    let root = stopped_team(&mut s);
    let unrelated = execution_tests::setup(&mut s).0;
    let long = "保存的长正文 42\n".repeat(16000);
    let body = s.text(&long).unwrap();
    let nested = s.save_json(json!({"body":body})).unwrap();
    let wrapped = s
        .save_json(json!({"tool_result":json!({"nested":nested}).to_string()}))
        .unwrap();
    s.append(
        Some(&root),
        None,
        Payload::TextDelta {
            content: nested.clone(),
        },
    )
    .unwrap();
    s.append(
        Some(&root),
        None,
        Payload::TextDelta {
            content: wrapped.clone(),
        },
    )
    .unwrap();
    let context = s.execution_snapshot(&root).unwrap().context;
    let mut value = serde_json::to_value(context).unwrap();
    value["digest"] = json!({"compacted_items":3,"archive":wrapped,"recent_sources":[]});
    let context_ref = s.save_json(value).unwrap();
    s.connection
        .execute(
            "UPDATE execution_sessions SET context_object_id=?2 WHERE task_id=?1",
            params![root, context_ref.object_id],
        )
        .unwrap();
    for i in 0..170 {
        s.connection.execute("INSERT INTO messages(id,task_id,role,state,queue_position,object_id,created_at_ms) VALUES(?1,?2,'user','delivered',?3,?4,?3)", params![id(),root,i,body.object_id]).unwrap();
    }
    let stop = AtomicBool::new(false);
    let bundle = s.export_task_archive(&root, &stop).unwrap();
    assert_eq!(bundle.index.tasks.len(), 3);
    assert_eq!(bundle.index.counts["messages"], 170);
    assert_eq!(bundle.index.counts["team_dependencies"], 1);
    assert!(bundle.blobs.contains_key(&body.object_id));
    assert_eq!(bundle.blobs[&body.object_id], long.as_bytes());
    assert!(
        !String::from_utf8(bundle.blobs[&bundle.index.snapshot.object_id].clone())
            .unwrap()
            .contains(&unrelated)
    );
    let digest = sha(&bundle.index);
    let archive = bundle.index.archive_id.clone();
    let mut to = Store::open(target.path()).unwrap();
    assert_eq!(
        to.import_task_archive(bundle, &digest, &stop).unwrap()["duplicate"],
        false
    );
    for table in [
        "tasks",
        "agents",
        "runs",
        "approvals",
        "team_control",
        "schedules",
    ] {
        let count: u32 = to
            .connection
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0, "import activated {table}");
    }
    let page = to.read_task_archive(&archive, "messages", 160, 32).unwrap();
    assert_eq!(page["total"], 170);
    assert_eq!(page["records"].as_array().unwrap().len(), 10);
    let record: ContentRef = serde_json::from_value(page["records"][9]["content"].clone()).unwrap();
    let row: serde_json::Value = to.read_json(&record).unwrap();
    let content: ContentRef = serde_json::from_value(row["object_id"].clone()).unwrap();
    assert_eq!(to.read_text_value(&content).unwrap(), long);
    // Archive-owned content must survive the existing orphan collector even
    // though no live task/run tables were restored. View wrappers may be rebuilt.
    to.collect_unreferenced_objects().unwrap();
    assert_eq!(to.read_text_value(&content).unwrap(), long);
    let reread = to.read_task_archive(&archive, "messages", 160, 32).unwrap();
    assert_eq!(reread["records"].as_array().unwrap().len(), 10);
    drop(to);
    let mut to = Store::open(target.path()).unwrap();
    let again = to.export_saved_task_archive(&archive, &stop).unwrap();
    assert_eq!(
        to.import_task_archive(again, &digest, &stop).unwrap()["duplicate"],
        true
    );
    assert_eq!(
        to.task_archive_list().unwrap()["archives"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(to.read_task_archive(&archive, "settings", 0, 32).is_err());
}

#[test]
fn task_archive_rejects_damaged_missing_foreign_and_unconfirmed_contents() {
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let mut s = Store::open(source.path()).unwrap();
    let root = stopped_team(&mut s);
    let stop = AtomicBool::new(false);
    let mut to = Store::open(target.path()).unwrap();
    for variant in 0..4 {
        let mut bundle = s.export_task_archive(&root, &stop).unwrap();
        let digest = sha(&bundle.index);
        match variant {
            0 => {
                bundle
                    .blobs
                    .get_mut(&bundle.index.snapshot.object_id)
                    .unwrap()[0] = b'!';
            }
            1 => {
                bundle.blobs.remove(&bundle.index.snapshot.object_id);
            }
            2 => {
                bundle.index.tasks[1].parent_task_id = Some("unrelated".into());
            }
            _ => {
                bundle.index.counts.insert("settings".into(), 0);
            }
        }
        assert!(to.import_task_archive(bundle, &digest, &stop).is_err());
    }
    let bundle = s.export_task_archive(&root, &stop).unwrap();
    assert!(
        to.import_task_archive(bundle, &"0".repeat(64), &stop)
            .is_err()
    );
    let bundle = s.export_task_archive(&root, &stop).unwrap();
    let digest = sha(&bundle.index);
    assert!(
        to.import_task_archive(bundle, &digest, &AtomicBool::new(true))
            .is_err()
    );
    assert!(
        to.task_archive_list().unwrap()["archives"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn task_archive_refuses_active_work_and_later_registered_secret_without_touching_source() {
    let folder = tempfile::tempdir().unwrap();
    let mut s = Store::open(folder.path()).unwrap();
    let (root, p) = execution_tests::setup(&mut s);
    let stop = AtomicBool::new(false);
    let bundle = s.export_task_archive(&root, &stop).unwrap();
    assert_eq!(bundle.index.tasks.len(), 1); // queued task without a queued run is idle.
    execution_tests::queue(&mut s, &root, &p);
    assert!(s.export_task_archive(&root, &stop).is_err());
    let (other, _) = execution_tests::setup(&mut s);
    let secret = "ARCHIVE-UNIT-CANARY-UNIQUE";
    let reference = s.text(secret).unwrap();
    s.connection.execute("INSERT INTO messages(id,task_id,role,state,queue_position,object_id,created_at_ms) VALUES(?1,?2,'user','delivered',1,?3,1)", params![id(),other,reference.object_id]).unwrap();
    s.register_secret(secret).unwrap();
    assert!(s.export_task_archive(&other, &stop).is_err());
    assert_eq!(s.read_text_value(&reference).unwrap(), secret);
}

#[test]
fn task_archive_import_database_failure_never_exposes_partial_library() {
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let mut s = Store::open(source.path()).unwrap();
    let root = stopped_team(&mut s);
    let stop = AtomicBool::new(false);
    let bundle = s.export_task_archive(&root, &stop).unwrap();
    let digest = sha(&bundle.index);
    let mut to = Store::open(target.path()).unwrap();
    to.connection.execute_batch("CREATE TRIGGER fail_archive BEFORE INSERT ON settings WHEN NEW.key GLOB 'task-archive:*' BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
    assert!(to.import_task_archive(bundle, &digest, &stop).is_err());
    assert!(
        to.task_archive_list().unwrap()["archives"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let count: u32 = to
        .connection
        .query_row("SELECT count(*) FROM objects", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn task_archive_never_follows_untrusted_reference_to_another_task() {
    let folder = tempfile::tempdir().unwrap();
    let mut s = Store::open(folder.path()).unwrap();
    let (root, _) = execution_tests::setup(&mut s);
    let unrelated = s.text("another task's private content").unwrap();
    let forged = s
        .save_json(json!({"tool_text":json!({"stolen":unrelated}).to_string()}))
        .unwrap();
    s.append(Some(&root), None, Payload::TextDelta { content: forged })
        .unwrap();
    assert!(
        s.export_task_archive(&root, &AtomicBool::new(false))
            .is_err()
    );
    let (title_task, _) = execution_tests::setup(&mut s);
    s.connection
        .execute(
            "UPDATE tasks SET title=?2 WHERE id=?1",
            params![title_task, serde_json::to_string(&unrelated).unwrap()],
        )
        .unwrap();
    assert!(
        s.export_task_archive(&title_task, &AtomicBool::new(false))
            .is_err()
    );
}
