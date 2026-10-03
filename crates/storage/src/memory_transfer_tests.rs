use super::*;
use serde_json::{Value, json};

fn act(s: &mut Store, action: MemoryAction) -> MemoryData {
    s.memory_action(&Request {
        request_id: id(),
        command: Command::Memory { action },
    })
    .unwrap()
    .0
}
fn sample(s: &mut Store, root: &Path) -> (String, Vec<String>) {
    let action = WorkspaceAction::SaveProject {
        project_id: None,
        settings: ProjectSettings {
            name: "来源项目".into(),
            root_path: root.to_string_lossy().into_owned(),
            default_profile_id: None,
            permission: PermissionMode::RequestApproval,
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
        .workspace_action(&req, &action, Some("source-root".into()))
        .unwrap()
        .0
    else {
        panic!()
    };
    let (task, _) = super::execution_tests::setup(s);
    let (candidate, _) = s
        .memory_propose(&task, "pending", "待确认的偏好", false, "Original goal")
        .unwrap();
    let (rejected, _) = s
        .memory_propose(&task, "reject", "已拒绝的偏好", false, "Original goal")
        .unwrap();
    act(
        s,
        MemoryAction::Decide {
            memory_id: rejected.clone(),
            revision: 1,
            confirm: false,
        },
    );
    let MemoryData::Updated { memory_id: deleted } = act(
        s,
        MemoryAction::Save {
            memory_id: None,
            revision: 0,
            project_id: None,
            text: "历史通用版本".into(),
        },
    ) else {
        panic!()
    };
    act(
        s,
        MemoryAction::Save {
            memory_id: Some(deleted.clone()),
            revision: 1,
            project_id: Some(project.id.clone()),
            text: "历史项目版本".into(),
        },
    );
    act(
        s,
        MemoryAction::Delete {
            memory_id: deleted.clone(),
            revision: 2,
        },
    );
    (project.id, vec![deleted, candidate, rejected])
}
fn import(s: &mut Store, b: &ProjectTransferBundle) -> Result<(Value, Vec<Event>)> {
    let view = s.project_import_preview(b, "target-root", "目标项目", "digest")?;
    s.import_project_settings(b, "C:/target", "target-root", "目标项目", "digest", &view)
}

#[test]
fn history_transfer_preserves_inactive_states_and_restorable_scopes_after_restart_and_gc() {
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let mut s = Store::open(source.path()).unwrap();
    let (project, ids) = sample(&mut s, source.path());
    assert!(
        s.export_project_settings(&project, &[], &ids, false)
            .is_err()
    );
    let b = s
        .export_project_settings(&project, &[], &ids, true)
        .unwrap();
    assert_eq!(b.version, 2);
    assert_eq!(
        b.memory_history
            .iter()
            .map(|h| h.versions.len())
            .collect::<Vec<_>>(),
        vec![3, 1, 2]
    );
    let mut dest = Store::open(target.path()).unwrap();
    let (receipt, _) = import(&mut dest, &b).unwrap();
    let get_id = |n: usize| {
        receipt["memories"][n]["target_id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let restored = get_id(0);
    let candidate = get_id(1);
    let rejected = get_id(2);
    assert!(
        dest.memory_active(Some(receipt["project_id"].as_str().unwrap()), "", 64)
            .unwrap()
            .is_empty()
    );
    assert!(dest.memory_get(&restored).unwrap().deleted);
    assert_eq!(
        dest.memory_get(&candidate).unwrap().state,
        MemoryState::Suggested
    );
    assert_eq!(
        dest.memory_get(&rejected).unwrap().state,
        MemoryState::Rejected
    );
    assert!(
        dest.memory_get(&candidate)
            .unwrap()
            .source_task_id
            .is_none()
    );
    assert_eq!(dest.memory_get(&restored).unwrap().revision, 4);
    assert!(import(&mut dest, &b).unwrap().1.is_empty());
    dest.collect_unreferenced_objects().unwrap();
    drop(dest);
    let mut dest = Store::open(target.path()).unwrap();
    let MemoryData::History { items, has_more } = act(
        &mut dest,
        MemoryAction::History {
            memory_id: restored.clone(),
            before_revision: None,
            limit: 64,
        },
    ) else {
        panic!()
    };
    assert!(!has_more);
    assert_eq!(items.len(), 4);
    assert_eq!(items.last().unwrap().text, "历史通用版本");
    assert!(items.iter().all(|m| m.source_task_id.is_none()));
    act(
        &mut dest,
        MemoryAction::Restore {
            memory_id: restored.clone(),
            revision: 4,
            target_revision: 1,
        },
    );
    let current = dest.memory_get(&restored).unwrap();
    assert_eq!(current.text, "历史通用版本");
    assert!(current.project_id.is_none() && !current.deleted);
    act(
        &mut dest,
        MemoryAction::Restore {
            memory_id: restored.clone(),
            revision: 5,
            target_revision: 2,
        },
    );
    assert_eq!(
        dest.memory_get(&restored).unwrap().project_id.as_deref(),
        receipt["project_id"].as_str()
    );
    act(
        &mut dest,
        MemoryAction::Restore {
            memory_id: candidate.clone(),
            revision: 2,
            target_revision: 1,
        },
    );
    assert_eq!(
        dest.memory_get(&candidate).unwrap().state,
        MemoryState::Suggested
    );
    assert!(dest.memory_active(None, "待确认", 64).unwrap().is_empty());
    act(
        &mut dest,
        MemoryAction::Decide {
            memory_id: candidate,
            revision: 3,
            confirm: true,
        },
    );
    assert_eq!(dest.memory_active(None, "待确认", 64).unwrap().len(), 1);
}

#[test]
fn history_import_failure_rolls_back_all_records_and_rejects_malformed_or_foreign_revisions() {
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let mut s = Store::open(source.path()).unwrap();
    let (project, ids) = sample(&mut s, source.path());
    let b = s
        .export_project_settings(&project, &[], &ids, true)
        .unwrap();
    let mut dest = Store::open(target.path()).unwrap();
    dest.connection.execute_batch("CREATE TEMP TRIGGER fail_version BEFORE INSERT ON memory_versions WHEN NEW.revision=2 BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
    assert!(import(&mut dest, &b).is_err());
    for table in ["projects", "memories", "memory_meta", "memory_versions"] {
        assert_eq!(
            dest.connection
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                    .get::<_, u64>(0))
                .unwrap(),
            0
        );
    }
    dest.connection
        .execute_batch("DROP TRIGGER fail_version")
        .unwrap();
    for mutate in 0..5 {
        let mut bad = b.clone();
        match mutate {
            0 => bad.memory_history[0].versions[0].project_id = Some("foreign-project".into()),
            1 => bad.memory_history[0].versions[1].revision = 1,
            2 => {
                bad.memory_history.pop();
            }
            3 => bad.memory_history[0].versions.last_mut().unwrap().text = "different".into(),
            _ => bad.version = 1,
        }
        assert!(import(&mut dest, &bad).is_err());
    }
    let mut oversized = b.clone();
    oversized.memory_history[0].versions = vec![b.memory_history[0].versions[0].clone(); 257];
    assert!(oversized.validate().is_err());
    import(&mut dest, &b).unwrap();
    assert_eq!(
        dest.connection
            .query_row("SELECT count(*) FROM memory_versions", [], |r| r
                .get::<_, u32>(0))
            .unwrap(),
        9
    );
    // A historical credential prevents export even when the current entry no longer contains it.
    s.register_secret("历史通用版本").unwrap();
    assert!(
        s.export_project_settings(&project, &[], &ids, true)
            .is_err()
    );
}

#[test]
fn legacy_settings_without_history_remain_readable() {
    let source = tempfile::tempdir().unwrap();
    let mut s = Store::open(source.path()).unwrap();
    let (project, _) = sample(&mut s, source.path());
    let b = s
        .export_project_settings(&project, &[], &[], false)
        .unwrap();
    let value = serde_json::to_value(b).unwrap();
    assert!(value.get("memory_history").is_none());
    serde_json::from_value::<ProjectTransferBundle>(value)
        .unwrap()
        .validate()
        .unwrap();
    let action: ProjectTransferAction = serde_json::from_value(json!({"kind":"export","project_id":project,"profile_ids":[],"memory_ids":[],"path":"C:/archive.wpsettings","password":"fixture password long"})).unwrap();
    assert!(matches!(
        action,
        ProjectTransferAction::Export {
            include_memory_history: false,
            ..
        }
    ));
}
