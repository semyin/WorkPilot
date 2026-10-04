use super::*;
use serde_json::{Value, json};
use std::sync::atomic::AtomicBool;
fn stop() -> AtomicBool {
    AtomicBool::new(false)
}
fn count(s: &Store, table: &str) -> u32 {
    assert!(["tasks", "file_revisions", "workbench_operations"].contains(&table));
    s.connection
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}
fn project(s: &mut Store, path: &std::path::Path) -> String {
    let action = WorkspaceAction::SaveProject {
        project_id: None,
        settings: ProjectSettings {
            name: "Restored project".into(),
            root_path: path.to_string_lossy().into_owned(),
            default_profile_id: None,
            permission: PermissionMode::FullAccess,
            rules: String::new(),
            revision: 0,
        },
    };
    let req = Request {
        request_id: id(),
        command: Command::Workspace {
            action: action.clone(),
        },
    };
    let WorkspaceData::ProjectSaved { project } = s
        .workspace_action(&req, &action, Some("new-root".into()))
        .unwrap()
        .0
    else {
        panic!()
    };
    project.id
}
fn revision(s: &mut Store, task: &str, path: &str, root: &str) -> FileRevision {
    let image = FileImage {
        version: FileVersion {
            exists: true,
            bytes: 4,
            sha256: Some("a".repeat(64)),
            identity: Some("old-file-identity".into()),
        },
        blob: Some("a".repeat(64)),
    };
    let row = FileRevision {
        id: id(),
        task_id: task.into(),
        root_identity: root.into(),
        path: path.into(),
        operation_id: id(),
        previous_path: None,
        change: "modified".into(),
        source: "editor".into(),
        at_ms: now_ms(),
        before: image.clone(),
        after: image,
        origin: None,
    };
    s.connection.execute("INSERT INTO file_revisions(id,task_id,root_identity,path,operation_id,data_json) VALUES(?1,?2,?3,?4,?5,?6)",params![row.id,row.task_id,row.root_identity,row.path,row.operation_id,encode(&row).unwrap()]).unwrap();
    row
}
fn import(s: &mut Store, b: TaskArchiveBytes) -> Result<String> {
    let archive = b.index.archive_id.clone();
    let sha = format!("{:x}", Sha256::digest(serde_json::to_vec(&b.index)?));
    s.import_task_archive(b, &sha, &stop())?;
    Ok(archive)
}
fn archive(s: &mut Store, task: &str) -> String {
    let b = s.export_task_archive(task, &stop()).unwrap();
    import(s, b).unwrap()
}
fn mappings(s: &Store, a: &str) -> Vec<TaskProfileMapping> {
    s.task_archive_index(a)
        .unwrap()
        .tasks
        .iter()
        .map(|t| TaskProfileMapping {
            task_id: t.id.clone(),
            profile_id: "execution-test".into(),
        })
        .collect()
}
#[test]
fn task_history_restore_keeps_repeated_paths_task_ownership_and_rolls_back_entire_group() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let root = task_archive_tests::stopped_team(&mut s);
    let child = s.direct_members(&root).unwrap()[0].task_id.clone();
    let first = revision(&mut s, &root, "repeat.txt", "old-root");
    let second = revision(&mut s, &root, "repeat.txt", "old-root");
    let other = revision(&mut s, &child, "child.bin", "old-root");
    let target = project(&mut s, dir.path());
    let a = archive(&mut s, &root);
    let models = mappings(&s, &a);
    let p = s
        .task_group_restore_preview(&a, Some(&target), &models, &stop())
        .unwrap();
    assert_eq!(p["file_history"].as_array().unwrap().len(), 3);
    s.connection.execute_batch("CREATE TRIGGER fail_history BEFORE INSERT ON file_revisions WHEN NEW.root_identity='new-root' AND EXISTS(SELECT 1 FROM file_revisions WHERE root_identity='new-root') BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END;").unwrap();
    let fp = p["fingerprint"].as_str().unwrap();
    assert!(
        s.restore_task_group(&a, Some(&target), &models, fp, &stop())
            .is_err()
    );
    assert_eq!(count(&s, "tasks"), 3);
    assert_eq!(count(&s, "file_revisions"), 3);
    assert_eq!(count(&s, "workbench_operations"), 0);
    s.connection
        .execute_batch("DROP TRIGGER fail_history")
        .unwrap();
    let result = s
        .restore_task_group(&a, Some(&target), &models, fp, &stop())
        .unwrap()
        .0;
    let new_root = result["task_id"].as_str().unwrap();
    let rows = s.file_history("new-root", None, None, 128).unwrap();
    assert_eq!(rows.len(), 3);
    for old in [&first, &second, &other] {
        let new = rows
            .iter()
            .find(|r| r.origin.as_ref().unwrap().revision_id == old.id)
            .unwrap();
        assert_ne!(new.id, old.id);
        assert_ne!(new.operation_id, old.operation_id);
        assert_eq!(new.at_ms, old.at_ms);
        assert_eq!(new.before.version.identity, None);
        let mapped = result["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["source_task_id"] == old.task_id)
            .unwrap()["task_id"]
            .as_str()
            .unwrap();
        assert_eq!(new.task_id, mapped);
        assert!(s.file_revision(&new.id, "old-root").is_err());
    }
    let again = archive(&mut s, new_root);
    let index = s.task_archive_index(&again).unwrap();
    assert_eq!(index.file_history.len(), 3);
    assert!(
        index
            .file_history
            .iter()
            .all(|h| h.root_identity == "new-root")
    );
    assert!(
        index
            .file_history
            .iter()
            .any(|h| h.revision.origin.as_ref().unwrap().revision_id == first.id)
    );
    drop(s);
    let mut s = Store::open(dir.path()).unwrap();
    assert_eq!(
        s.restore_task_group(&a, Some(&target), &models, fp, &stop())
            .unwrap()
            .0["duplicate"],
        true
    );
    assert_eq!(count(&s, "file_revisions"), 6);
}
#[test]
fn task_history_restore_requires_target_and_rejects_multiple_source_folders() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let (task, p) = execution_tests::setup(&mut s);
    revision(&mut s, &task, "one.txt", "first-root");
    let target = project(&mut s, dir.path());
    let a = archive(&mut s, &task);
    assert!(s.task_restore_preview(&a, None, &p.id, &stop()).is_err());
    assert!(
        s.task_restore_preview(&a, Some(&target), &p.id, &stop())
            .is_ok()
    );
    revision(&mut s, &task, "two.txt", "another-root");
    let a = archive(&mut s, &task);
    assert_eq!(s.task_archive_index(&a).unwrap().file_history.len(), 2);
    assert!(
        s.task_restore_preview(&a, Some(&target), &p.id, &stop())
            .is_err()
    );
    assert_eq!(count(&s, "tasks"), 1);
}
#[test]
fn task_history_archive_rejects_foreign_records_unsafe_paths_sizes_and_caps() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let (task, _) = execution_tests::setup(&mut s);
    revision(&mut s, &task, "safe.txt", "root");
    for bad in [
        "foreign",
        "../outside",
        "C:/outside",
        ".git/config",
        "a\\b",
        "bad-image",
        "duplicate",
        "object-size",
    ] {
        let mut b = s.export_task_archive(&task, &stop()).unwrap();
        let r = &mut b.index.file_history[0].revision;
        match bad {
            "foreign" => r.task_id = id(),
            "bad-image" => {
                r.before.exists = false;
            }
            "duplicate" => {
                let mut v = b.index.file_history[0].clone();
                v.revision.id = id();
                b.index.file_history.push(v);
            }
            "object-size" => {
                r.after.sha256 = Some(b.index.snapshot.object_id.clone());
                r.after.bytes = b.index.snapshot.bytes + 1;
            }
            _ => r.path = bad.into(),
        }
        assert!(import(&mut s, b).is_err(), "{bad}");
    }
    for n in 0..128 {
        revision(&mut s, &task, &format!("{n}.txt"), "root");
    }
    assert!(s.export_task_archive(&task, &stop()).is_err());
    assert!(
        s.task_archive_list().unwrap()["archives"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
#[test]
fn task_history_v1_v2_digests_stay_compatible_without_synthetic_history() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let (task, p) = execution_tests::setup(&mut s);
    for version in [1, 2] {
        let mut b = s.export_task_archive(&task, &stop()).unwrap();
        b.index.version = version;
        b.index.excluded_file_revisions = 9;
        let bytes = serde_json::to_vec(&b.index).unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert!(value.get("file_history").is_none());
        let parsed: TaskArchiveIndex = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(serde_json::to_vec(&parsed).unwrap(), bytes);
        let a = import(&mut s, b).unwrap();
        let preview = s.task_restore_preview(&a, None, &p.id, &stop()).unwrap();
        assert_eq!(preview["file_history"], json!([]));
        assert_eq!(preview["file_history_included"], false);
        s.restore_task_archive(
            &a,
            None,
            &p.id,
            preview["fingerprint"].as_str().unwrap(),
            &stop(),
        )
        .unwrap();
    }
    assert_eq!(count(&s, "file_revisions"), 0);
}
