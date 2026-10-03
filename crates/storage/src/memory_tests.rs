use super::*;
use serde_json::json;
fn request(a: MemoryAction) -> Request {
    Request {
        request_id: id(),
        command: Command::Memory { action: a },
    }
}
fn act(s: &mut Store, a: MemoryAction) -> MemoryData {
    s.memory_action(&request(a)).unwrap().0
}
fn save(s: &mut Store, project: Option<String>, text: &str) -> String {
    let MemoryData::Updated { memory_id } = act(
        s,
        MemoryAction::Save {
            memory_id: None,
            revision: 0,
            project_id: project,
            text: text.into(),
        },
    ) else {
        panic!()
    };
    memory_id
}
fn project(s: &mut Store, path: &Path, name: &str) -> String {
    let a = WorkspaceAction::SaveProject {
        project_id: None,
        settings: ProjectSettings {
            name: name.into(),
            root_path: path.to_string_lossy().into_owned(),
            default_profile_id: None,
            permission: PermissionMode::RequestApproval,
            rules: String::new(),
            revision: 0,
        },
    };
    let req = Request {
        request_id: id(),
        command: Command::Workspace { action: a.clone() },
    };
    let WorkspaceData::ProjectSaved { project } =
        s.workspace_action(&req, &a, Some(name.into())).unwrap().0
    else {
        panic!()
    };
    project.id
}
#[test]
fn candidate_requires_confirm_and_real_source_and_duplicate_is_inert() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let (t, _) = super::execution_tests::setup(&mut s);
    assert!(
        s.memory_propose(&t, "bad", "favorite preference", false, "forged user words")
            .is_err()
    );
    assert!(
        s.memory_propose(
            &t,
            "bad-scope",
            "favorite preference",
            true,
            "Original goal"
        )
        .is_err()
    );
    let (id, _) = s
        .memory_propose(
            &t,
            "candidate",
            "favorite preference",
            false,
            "Original goal",
        )
        .unwrap();
    assert!(s.memory_active(None, "", 64).unwrap().is_empty());
    assert_eq!(s.memory_get(&id).unwrap().state, MemoryState::Suggested);
    act(
        &mut s,
        MemoryAction::Decide {
            memory_id: id.clone(),
            revision: 1,
            confirm: true,
        },
    );
    assert_eq!(s.memory_active(None, "FAVORITE", 64).unwrap().len(), 1);
    act(
        &mut s,
        MemoryAction::Delete {
            memory_id: id.clone(),
            revision: 2,
        },
    );
    let duplicate = s
        .memory_propose(
            &t,
            "candidate",
            "favorite preference",
            false,
            "Original goal",
        )
        .unwrap();
    assert_eq!(duplicate.0, id);
    assert!(duplicate.1.is_empty());
    assert!(s.memory_active(None, "", 64).unwrap().is_empty());
    assert!(matches!(
        s.memory_propose(&t, "candidate", "different content", false, "Original goal"),
        Err(Error::Conflict)
    ));
    assert!(s.memory_get(&id).unwrap().deleted);
}
#[test]
fn edits_compare_revision_and_history_survives_restart_and_gc() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let req = request(MemoryAction::Save {
        memory_id: None,
        revision: 0,
        project_id: None,
        text: "original preference".into(),
    });
    let MemoryData::Updated { memory_id } = s.memory_action(&req).unwrap().0 else {
        panic!()
    };
    assert!(s.memory_action(&req).unwrap().1.is_empty());
    act(
        &mut s,
        MemoryAction::Save {
            memory_id: Some(memory_id.clone()),
            revision: 1,
            project_id: None,
            text: "updated preference".into(),
        },
    );
    assert!(matches!(
        s.memory_action(&request(MemoryAction::Delete {
            memory_id: memory_id.clone(),
            revision: 1
        })),
        Err(Error::Conflict)
    ));
    act(
        &mut s,
        MemoryAction::Delete {
            memory_id: memory_id.clone(),
            revision: 2,
        },
    );
    s.collect_unreferenced_objects().unwrap();
    drop(s);
    let mut s = Store::open(dir.path()).unwrap();
    assert!(s.memory_active(None, "", 64).unwrap().is_empty());
    act(
        &mut s,
        MemoryAction::Restore {
            memory_id: memory_id.clone(),
            revision: 3,
            target_revision: 1,
        },
    );
    let m = s.memory_get(&memory_id).unwrap();
    assert_eq!(m.text, "original preference");
    assert_eq!(m.revision, 4);
    let MemoryData::History { items, has_more } = act(
        &mut s,
        MemoryAction::History {
            memory_id: memory_id.clone(),
            before_revision: None,
            limit: 2,
        },
    ) else {
        panic!()
    };
    assert!(has_more);
    assert_eq!(items[0].revision, 4);
    assert!(items[1].deleted);
    let MemoryData::History { items, .. } = act(
        &mut s,
        MemoryAction::History {
            memory_id,
            before_revision: Some(3),
            limit: 64,
        },
    ) else {
        panic!()
    };
    assert_eq!(items.len(), 2);
    assert_eq!(items[1].text, "original preference");
}
#[test]
fn projects_search_export_and_deletion_do_not_cross_scopes() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let p = project(&mut s, dir.path(), "p");
    let p2dir = tempfile::tempdir().unwrap();
    let p2 = project(&mut s, p2dir.path(), "p2");
    save(&mut s, None, "global 简短");
    save(&mut s, Some(p.clone()), "project 简短");
    save(&mut s, Some(p2.clone()), "other project");
    assert_eq!(s.memory_active(None, "", 64).unwrap().len(), 1);
    let list = s.memory_active(Some(&p), "简短", 64).unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].project_id, Some(p.clone()));
    let MemoryData::Export { content, count } = act(
        &mut s,
        MemoryAction::Export {
            project_id: Some(p.clone()),
        },
    ) else {
        panic!()
    };
    assert_eq!(count, 2);
    assert!(
        !s.read_text_value(&content)
            .unwrap()
            .contains("other project")
    );
    act(
        &mut s,
        MemoryAction::Delete {
            memory_id: list[0].id.clone(),
            revision: 1,
        },
    );
    assert_eq!(s.memory_active(Some(&p), "", 64).unwrap().len(), 1);
    let MemoryData::List { items, total } = act(
        &mut s,
        MemoryAction::List {
            project_id: Some(p),
            search: "".into(),
            include_deleted: true,
            offset: 0,
            limit: 64,
        },
    ) else {
        panic!()
    };
    assert_eq!(total, 2);
    assert_eq!(items.len(), 2);
    s.register_secret("synthetic-only-memory-secret-12345")
        .unwrap();
    let id = save(
        &mut s,
        None,
        "use synthetic-only-memory-secret-12345 for examples",
    );
    assert!(
        !s.memory_get(&id)
            .unwrap()
            .text
            .contains("synthetic-only-memory-secret-12345")
    );
    let (task, _) = super::execution_tests::setup(&mut s);
    let context = s.memory_context(&task, "", 24, 1024).unwrap();
    assert_eq!(context["workpilot_memory_view"], 1);
    assert!(!context.to_string().contains("other project"));
    assert!(
        context["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|i| i["project_id"] == json!(null))
    );
}

#[test]
fn delegated_instructions_cannot_be_presented_as_user_memory_provenance() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let (root, _) = super::execution_tests::setup(&mut s);
    let settings = TeamSettings::default();
    let req = Request {
        request_id: id(),
        command: Command::ConfigureTeam {
            task_id: root.clone(),
            settings: settings.clone(),
        },
    };
    s.configure_team(&req, &root, &settings).unwrap();
    s.delegate_members(
        &root,
        &[MemberSpec {
            key: "memory-helper".into(),
            role: "helper".into(),
            goal: "Invented child assignment".into(),
            profile_id: None,
            depends_on: vec![],
        }],
        None,
        None,
        None,
    )
    .unwrap();
    let child = s.direct_members(&root).unwrap()[0].task_id.clone();
    assert!(
        s.memory_propose(
            &child,
            "wrong-source",
            "bad preference",
            false,
            "Invented child assignment"
        )
        .is_err()
    );
    let (memory, _) = s
        .memory_propose(
            &child,
            "root-source",
            "candidate from user",
            false,
            "Original goal",
        )
        .unwrap();
    let m = s.memory_get(&memory).unwrap();
    assert_eq!(m.source_task_id, Some(root));
    assert_eq!(m.state, MemoryState::Suggested);
    act(
        &mut s,
        MemoryAction::Decide {
            memory_id: memory.clone(),
            revision: 1,
            confirm: true,
        },
    );
    act(
        &mut s,
        MemoryAction::Restore {
            memory_id: memory.clone(),
            revision: 2,
            target_revision: 1,
        },
    );
    assert_eq!(s.memory_get(&memory).unwrap().state, MemoryState::Suggested);
    assert!(s.memory_active(None, "", 64).unwrap().is_empty());
}

#[test]
fn schema_nine_upgrade_preserves_legacy_objects_and_confirmation() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let (task, _) = super::execution_tests::setup(&mut s);
    let content = s.text("legacy retained preference").unwrap();
    for (id, state) in [
        ("legacy-confirmed", MemoryState::Confirmed),
        ("legacy-suggested", MemoryState::Suggested),
    ] {
        let v = Memory {
            id: id.into(),
            project_id: None,
            source_task_id: Some(task.clone()),
            content: content.clone(),
            state,
            confirmed_at_ms: if state == MemoryState::Confirmed {
                Some(1)
            } else {
                None
            },
        };
        s.connection
            .execute(
                "INSERT INTO memories(id,source_task_id,object_id,data_json) VALUES(?1,?2,?3,?4)",
                params![id, task, content.object_id, encode(&v).unwrap()],
            )
            .unwrap();
    }
    // Build the exact v9 tables in this isolated test DB, then exercise the normal open upgrade.
    s.connection.execute_batch("DROP TABLE schedule_commands; DROP TABLE schedule_occurrences; DROP TABLE schedule_cursor; DROP TABLE memory_proposals; DROP TABLE memory_commands; DROP TABLE memory_versions; DROP TABLE memory_meta; PRAGMA user_version=9;").unwrap();
    drop(s);
    let mut s = Store::open(dir.path()).unwrap();
    assert_eq!(s.memory_active(None, "retained", 64).unwrap().len(), 1);
    assert_eq!(
        s.memory_get("legacy-suggested").unwrap().state,
        MemoryState::Suggested
    );
    let req = Request {
        request_id: id(),
        command: Command::DeleteTask { task_id: task },
    };
    s.apply(&req).unwrap();
    s.collect_unreferenced_objects().unwrap();
    let m = s.memory_get("legacy-confirmed").unwrap();
    assert!(m.source_task_id.is_none());
    assert_eq!(m.text, "legacy retained preference");
    let MemoryData::History { items, .. } = act(
        &mut s,
        MemoryAction::History {
            memory_id: "legacy-confirmed".into(),
            before_revision: None,
            limit: 64,
        },
    ) else {
        panic!()
    };
    assert_eq!(items[0].revision, 0);
    assert_eq!(items[0].text, m.text);
    assert!(
        std::fs::read_dir(dir.path().join("backups"))
            .unwrap()
            .any(|p| p
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("before-v9-"))
    );
}

#[test]
fn context_skips_a_large_entry_without_losing_smaller_eligible_entries() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let (task, _) = super::execution_tests::setup(&mut s);
    let small = save(&mut s, None, "short preference");
    let long = save(&mut s, None, &"大".repeat(1200));
    // Force the larger entry to be considered first regardless of clock resolution.
    s.connection.execute("UPDATE memory_meta SET data_json=json_set(data_json,'$.updated_at_ms',9999999999999) WHERE memory_id=?1",[long]).unwrap();
    let view = s.memory_context(&task, "", 12, 1024).unwrap();
    assert_eq!(view["truncated"], true);
    assert_eq!(view["items"].as_array().unwrap().len(), 1);
    assert_eq!(view["items"][0]["id"], small);
}
