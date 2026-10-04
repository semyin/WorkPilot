use super::*;
use serde_json::{Value, json};
use std::sync::atomic::AtomicBool;

fn stop() -> AtomicBool {
    AtomicBool::new(false)
}
fn asset(s: &mut Store, task: &str, removed: bool) -> MediaAsset {
    let sha = format!("{:x}", Sha256::digest(b"Attachment 42"));
    let a = MediaAsset {
        id: id(),
        task_id: Some(task.into()),
        name: "source.txt".into(),
        source: "file".into(),
        media_type: "text/plain".into(),
        bytes: 13,
        sha256: sha.clone(),
        at_ms: now_ms(),
        units: 1,
        warnings: vec![],
        image: None,
        path: None,
        version: None,
        operation_id: None,
        origin: None,
    };
    s.media_put(&a, &sha, &"a".repeat(64)).unwrap();
    if removed {
        s.media_remove(&a.id).unwrap();
    }
    a
}
fn save(s: &mut Store, task: &str) -> (String, TaskArchiveIndex) {
    let bundle = s.export_task_archive(task, &stop()).unwrap();
    let index = bundle.index.clone();
    let sha = format!("{:x}", Sha256::digest(serde_json::to_vec(&index).unwrap()));
    s.import_task_archive(bundle, &sha, &stop()).unwrap();
    (index.archive_id.clone(), index)
}
fn candidates(index: &TaskArchiveIndex) -> Vec<TaskRestoreMedia> {
    index
        .media
        .iter()
        .map(|m| {
            let e = &m.entry;
            let a = MediaAsset {
                id: id(),
                task_id: Some(e.task_id.clone()),
                name: e.name.clone(),
                source: "file".into(),
                media_type: "text/plain".into(),
                bytes: e.bytes,
                sha256: e.sha256.clone(),
                at_ms: now_ms(),
                units: 1,
                warnings: vec![],
                image: None,
                path: None,
                version: None,
                operation_id: None,
                origin: Some(e.origin.clone().unwrap_or_else(|| MediaAssetOrigin {
                    archive_id: index.archive_id.clone(),
                    asset_id: e.id.clone(),
                    task_id: e.task_id.clone(),
                    name: e.name.clone(),
                    source: e.source.clone(),
                    at_ms: e.at_ms,
                    path: e.path.clone(),
                    operation_id: e.operation_id.clone(),
                })),
            };
            TaskRestoreMedia {
                source_id: e.id.clone(),
                source_task_id: e.task_id.clone(),
                removed: m.removed,
                candidate: MediaImportCandidate {
                    asset: a,
                    original_blob: e.sha256.clone(),
                    parsed_blob: "b".repeat(64),
                },
            }
        })
        .collect()
}
fn preview(s: &Store, archive: &str, media: &[TaskRestoreMedia]) -> Value {
    let base = s
        .task_restore_preview(archive, None, "execution-test", &stop())
        .unwrap();
    s.task_restore_media_preview(archive, base, media).unwrap()
}
fn restore(
    s: &mut Store,
    archive: &str,
    media: &[TaskRestoreMedia],
    p: &Value,
) -> Result<(Value, Vec<Event>)> {
    s.restore_task_archive_with_media(
        archive,
        None,
        "execution-test",
        p["fingerprint"].as_str().unwrap(),
        media,
        &stop(),
    )
}
#[test]
fn attachment_restore_is_atomic_preserves_removed_and_repeated_aliases() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let (task, _) = execution_tests::setup(&mut s);
    let live = asset(&mut s, &task, false);
    let removed = asset(&mut s, &task, true);
    let marker = format!("Read [workpilot-file:{}]", live.id);
    s.apply(&Request {
        request_id: id(),
        command: Command::Enqueue {
            task_id: task.clone(),
            text: marker.clone(),
        },
    })
    .unwrap();
    let (archive, index) = save(&mut s, &task);
    let media = candidates(&index);
    let p = preview(&s, &archive, &media);
    assert_eq!(p["attachments"].as_array().unwrap().len(), 2);
    s.connection.execute_batch("CREATE TRIGGER fail_attachment BEFORE INSERT ON media_assets BEGIN SELECT RAISE(ABORT,'disk failure'); END;").unwrap();
    assert!(restore(&mut s, &archive, &media, &p).is_err());
    assert!(
        s.task_restore_preview(&archive, None, "execution-test", &stop())
            .unwrap()["already_restored"]
            == false
    );
    assert_eq!(
        s.connection
            .query_row("SELECT count(*) FROM tasks", [], |r| r.get::<_, u32>(0))
            .unwrap(),
        1
    );
    s.connection
        .execute_batch("DROP TRIGGER fail_attachment")
        .unwrap();
    let result = restore(&mut s, &archive, &media, &p).unwrap().0;
    let next = result["task_id"].as_str().unwrap();
    assert_eq!(s.media_list(next).unwrap().len(), 1);
    let next_asset = s.restored_media_id(next, &live.id).unwrap();
    assert_ne!(next_asset, live.id);
    assert!(
        s.media_asset(&s.restored_media_id(next, &removed.id).unwrap())
            .is_err()
    );
    assert_eq!(s.restored_media_id(&task, &live.id).unwrap(), live.id);
    assert_eq!(
        s.restored_media_references(next, "unrelated").unwrap(),
        "unrelated"
    );
    assert!(
        s.restored_media_references(next, &marker)
            .unwrap()
            .contains(&next_asset)
    );
    let new_snapshot = s.execution_snapshot(next).unwrap();
    assert_eq!(new_snapshot.messages[0].state, MessageState::Queued);
    assert_eq!(
        s.read_text_value(&new_snapshot.messages[0].content)
            .unwrap(),
        marker
    );
    let (again, index) = save(&mut s, next);
    let new_media = candidates(&index);
    let p = preview(&s, &again, &new_media);
    let next2 = restore(&mut s, &again, &new_media, &p).unwrap().0;
    let task2 = next2["task_id"].as_str().unwrap();
    let id2 = s.media_list(task2).unwrap()[0].id.clone();
    assert_eq!(s.restored_media_id(task2, &live.id).unwrap(), id2);
    assert_eq!(s.restored_media_id(task2, &next_asset).unwrap(), id2);
}
#[test]
fn attachment_restore_rejects_changed_library_parser_or_foreign_candidates() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let (task, _) = execution_tests::setup(&mut s);
    asset(&mut s, &task, false);
    let (archive, index) = save(&mut s, &task);
    let media = candidates(&index);
    let p = preview(&s, &archive, &media);
    let mut changed = media.clone();
    changed[0].candidate.parsed_blob = "c".repeat(64);
    assert!(restore(&mut s, &archive, &changed, &p).is_err());
    changed = media.clone();
    changed[0].source_task_id = id();
    assert!(restore(&mut s, &archive, &changed, &p).is_err());
    changed = media.clone();
    changed[0].removed = true;
    assert!(restore(&mut s, &archive, &changed, &p).is_err());
    let base = s
        .task_restore_preview(&archive, None, "execution-test", &stop())
        .unwrap();
    assert!(restore(&mut s, &archive, &[], &base).is_err());
    asset(&mut s, &task, false);
    assert!(restore(&mut s, &archive, &media, &p).is_err());
    let fresh = preview(&s, &archive, &media);
    assert!(restore(&mut s, &archive, &media, &fresh).is_ok());
}
#[test]
fn attachment_restore_keeps_team_scopes_and_ancestor_references_across_two_migrations() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let root = task_archive_tests::stopped_team(&mut s);
    let members = s.direct_members(&root).unwrap();
    let parent = asset(&mut s, &root, false);
    let child = asset(&mut s, &members[0].task_id, false);
    // A child can retain an ancestor's historical marker without owning its file.
    let context = s.execution_snapshot(&members[0].task_id).unwrap().context;
    let mut value = serde_json::to_value(context).unwrap();
    value["last_text"] = json!(format!("[workpilot-file:{}]", parent.id));
    let r = s.save_json(value).unwrap();
    s.connection
        .execute(
            "UPDATE execution_sessions SET context_object_id=?2 WHERE task_id=?1",
            params![members[0].task_id, r.object_id],
        )
        .unwrap();
    let mut current = root.clone();
    for _ in 0..2 {
        let (archive, index) = save(&mut s, &current);
        let media = candidates(&index);
        let profiles = index
            .tasks
            .iter()
            .map(|t| TaskProfileMapping {
                task_id: t.id.clone(),
                profile_id: "execution-test".into(),
            })
            .collect::<Vec<_>>();
        let base = s
            .task_group_restore_preview(&archive, None, &profiles, &stop())
            .unwrap();
        let p = s
            .task_restore_media_preview(&archive, base, &media)
            .unwrap();
        let r = s
            .restore_task_group_with_media(
                &archive,
                None,
                &profiles,
                p["fingerprint"].as_str().unwrap(),
                &media,
                &stop(),
            )
            .unwrap()
            .0;
        current = r["task_id"].as_str().unwrap().into();
        let parent_id = s.restored_media_id(&current, &parent.id).unwrap();
        assert_eq!(s.media_list(&current).unwrap()[0].id, parent_id);
        let children = s.direct_members(&current).unwrap();
        let child_task = children.iter().find(|m| m.key == members[0].key).unwrap();
        let child_id = s.restored_media_id(&child_task.task_id, &child.id).unwrap();
        assert_eq!(s.media_list(&child_task.task_id).unwrap()[0].id, child_id);
        assert_eq!(
            s.restored_media_id(&child_task.task_id, &parent.id)
                .unwrap(),
            parent.id
        );
        assert_eq!(s.restored_media_id(&current, &child.id).unwrap(), child.id);
    }
}
#[test]
fn attachment_archive_v1_digest_compatibility_and_limits() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let (task, _) = execution_tests::setup(&mut s);
    let mut bundle = s.export_task_archive(&task, &stop()).unwrap();
    bundle.index.version = 1;
    let bytes = serde_json::to_vec(&bundle.index).unwrap();
    assert!(
        !serde_json::from_slice::<Value>(&bytes)
            .unwrap()
            .as_object()
            .unwrap()
            .contains_key("media")
    );
    let parsed: TaskArchiveIndex = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(serde_json::to_vec(&parsed).unwrap(), bytes);
    bundle.index = parsed;
    let archive = bundle.index.archive_id.clone();
    let sha = format!("{:x}", Sha256::digest(bytes));
    s.import_task_archive(bundle, &sha, &stop()).unwrap();
    let p = preview(&s, &archive, &[]);
    assert!(restore(&mut s, &archive, &[], &p).is_ok());
    for _ in 0..65 {
        asset(&mut s, &task, false);
    }
    assert!(s.export_task_archive(&task, &stop()).is_err());
}
