use super::*;
use serde_json::json;
fn req(command: Command) -> Request {
    Request {
        request_id: id(),
        command,
    }
}
pub(super) fn setup(s: &mut Store) -> (String, ProviderProfile) {
    let p = ProviderProfile::new(
        "execution-test".into(),
        ProtocolKind::Responses,
        "http://127.0.0.1:1".into(),
        "synthetic".into(),
    );
    s.commit_profile(
        &req(Command::SaveProvider {
            profile: Box::new(p.clone()),
            secret: None,
            clear_credential: false,
        }),
        p.clone(),
    )
    .unwrap();
    let config = ExecutionConfig {
        title: "Test".into(),
        goal: "Original goal".into(),
        constraints: vec![],
        project_rules: String::new(),
        project_id: None,
        profile_id: Some(p.id.clone()),
        mode: WorkMode::Execute,
        controlled_tools: true,
        limits: ExecutionLimits::default(),
    };
    let task = s
        .create_execution(
            &req(Command::CreateExecution {
                config: Box::new(config.clone()),
            }),
            &config,
        )
        .unwrap()
        .0
        .task_id
        .unwrap();
    (task, p)
}
pub(super) fn queue(s: &mut Store, task: &str, p: &ProviderProfile) -> String {
    s.queue_execution(
        &req(Command::StartExecution {
            task_id: task.into(),
        }),
        task,
        p,
    )
    .unwrap();
    s.execution_snapshot(task)
        .unwrap()
        .latest_run
        .unwrap()
        .run
        .id
}

fn real_intent(s: &mut Store) -> (String, ToolIntent) {
    let (task, p) = setup(s);
    let settings = ToolSettings {
        root_path: Some("C:/synthetic".into()),
        ..Default::default()
    };
    s.configure_task_tools(
        &req(Command::ConfigureTaskTools {
            task_id: task.clone(),
            settings: settings.clone(),
        }),
        &task,
        &settings,
        Some("directory-identity".into()),
    )
    .unwrap();
    let run = queue(s, &task, &p);
    s.activate_execution(&run).unwrap();
    let input = ModelInput {
        messages: vec![],
        history: vec![],
        tools: vec![],
        tool_results: vec![],
        continuation: None,
        capability_probe: None,
    };
    let step = s.begin_execution_model(&run, &input).unwrap().0;
    let arguments = json!({"path":"a.txt","text":"new content","expected_sha256":null});
    let output = ModelOutput {
        text: String::new(),
        tool_calls: vec![ModelToolCall {
            id: "provider-call".into(),
            name: "write_file".into(),
            arguments: arguments.clone(),
            provider_item_id: None,
        }],
        continuation: ProviderContinuation {
            protocol: ProtocolKind::Responses,
            response_id: None,
            items: vec![],
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
    s.accept_execution_model(&run, &step, &output).unwrap();
    let action = s
        .execution_snapshot(&task)
        .unwrap()
        .context
        .pending
        .unwrap()
        .action_ids[0]
        .clone();
    let intent = ToolIntent {
        task_id: task.clone(),
        action_id: action,
        tool: "write_file".into(),
        arguments,
        root_path: "C:/synthetic".into(),
        root_identity: "directory-identity".into(),
        target: "a.txt".into(),
        version: FileVersion {
            exists: false,
            sha256: None,
            bytes: 0,
            identity: None,
        },
        epoch: s.tool_settings(&task).unwrap().epoch,
        mode: WorkMode::Execute,
        risk: ToolRisk::ManagedWrite,
        execution_scope: "selected folder".into(),
    };
    (run, intent)
}
#[test]
fn tool_approvals_bind_versions_are_single_use_and_settings_commands_are_idempotent() {
    let root = tempfile::tempdir().unwrap();
    let mut s = Store::open(root.path()).unwrap();
    let (_, intent) = real_intent(&mut s);
    let (approval, events) = s.ensure_tool_approval(&intent).unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(s.ensure_tool_approval(&intent).unwrap().0.id, approval.id);
    assert!(
        s.decide_tool_approval(
            None,
            &approval.id,
            "another-task",
            &approval.fingerprint,
            true,
            "test"
        )
        .is_err()
    );
    s.decide_tool_approval(
        None,
        &approval.id,
        &intent.task_id,
        &approval.fingerprint,
        true,
        "rule:test",
    )
    .unwrap();
    let mut changed = intent.clone();
    changed.version.bytes = 12;
    assert!(s.consume_tool_approval(&approval.id, &changed).is_err());
    s.consume_tool_approval(&approval.id, &intent).unwrap();
    assert!(s.consume_tool_approval(&approval.id, &intent).is_err());
    let replacement = s.ensure_tool_approval(&intent).unwrap().0;
    assert_ne!(replacement.id, approval.id);
    let settings = ToolSettings {
        root_path: None,
        revision: 1,
        ..Default::default()
    };
    let r = req(Command::ConfigureTaskTools {
        task_id: intent.task_id.clone(),
        settings: settings.clone(),
    });
    let events = s
        .configure_task_tools(&r, &intent.task_id, &settings, None)
        .unwrap();
    assert!(events.iter().any(|e| matches!(
        e.payload,
        Payload::CommandFinished {
            status: CommandStatus::Completed
        }
    )));
    assert!(
        s.configure_task_tools(&r, &intent.task_id, &settings, None)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        s.tool_approval(&replacement.id).unwrap().state,
        ApprovalState::Expired
    );
    assert!(s.consume_tool_approval(&replacement.id, &intent).is_err());
}
#[test]
fn managed_versions_and_nested_process_outputs_remain_owned_during_garbage_collection() {
    let root = tempfile::tempdir().unwrap();
    let mut s = Store::open(root.path()).unwrap();
    let (run, intent) = real_intent(&mut s);
    s.begin_execution_action(&run, &intent.action_id).unwrap();
    s.prepare_managed_write(
        &intent.task_id,
        &intent.action_id,
        "a.txt",
        &intent.version,
        None,
        "new content",
    )
    .unwrap();
    let after = FileVersion {
        exists: true,
        sha256: Some(format!("{:x}", Sha256::digest(b"new content"))),
        bytes: 11,
        identity: Some("file".into()),
    };
    s.finish_managed_write(&intent.action_id, &after).unwrap();
    let long_line = "x".repeat(150000);
    let stdout = s.save_tool_text(&intent.action_id, &long_line).unwrap();
    assert_eq!(stdout.bytes, 150000);
    let record = s
        .save_tool_json(&intent.action_id, json!({"stdout":stdout}))
        .unwrap();
    let orphan = s.text("unused orphan").unwrap();
    s.collect_unreferenced_objects().unwrap();
    assert!(content_ref(&s.connection, &orphan.object_id).is_err());
    assert!(content_ref(&s.connection, &stdout.object_id).is_ok());
    assert!(content_ref(&s.connection, &record.object_id).is_ok());
    let versions = s.tool_task_state(&intent.task_id).unwrap().changes;
    assert_eq!(versions.len(), 1);
    assert_eq!(versions[0].after, after);
    assert!(content_ref(&s.connection, &versions[0].after_content.object_id).is_ok());
}
#[test]
fn actual_schema_three_database_upgrades_with_existing_provider_intact() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join("backups")).unwrap();
    let mut c = Connection::open(root.path().join("workpilot.sqlite3")).unwrap();
    migrate(
        &mut c,
        root.path(),
        &[
            (1, include_str!("../migrations/001_initial.sql")),
            (2, include_str!("../migrations/002_providers.sql")),
            (3, include_str!("../migrations/003_execution.sql")),
        ],
    )
    .unwrap();
    let p = ProviderProfile::new(
        "legacy-p03".into(),
        ProtocolKind::Responses,
        "https://example.com/v1".into(),
        "legacy-model".into(),
    );
    c.execute(
        "INSERT INTO provider_profiles(id,data_json) VALUES(?1,?2)",
        params![p.id, encode(&p).unwrap()],
    )
    .unwrap();
    drop(c);
    let s = Store::open(root.path()).unwrap();
    assert_eq!(s.profile("legacy-p03").unwrap().model, "legacy-model");
    assert_eq!(
        s.tool_defaults().unwrap().permission,
        PermissionMode::RequestApproval
    );
    assert_eq!(
        s.connection
            .query_row("PRAGMA user_version", [], |r| r.get::<_, u32>(0))
            .unwrap(),
        SCHEMA_VERSION
    );
}
#[test]
fn queued_message_prevents_completion_and_acknowledged_stop_wins_racing_success() {
    let root = tempfile::tempdir().unwrap();
    let mut s = Store::open(root.path()).unwrap();
    let (task, p) = setup(&mut s);
    let run = queue(&mut s, &task, &p);
    s.activate_execution(&run).unwrap();
    s.apply(&req(Command::Enqueue {
        task_id: task.clone(),
        text: "do one more thing".into(),
    }))
    .unwrap();
    assert!(matches!(
        s.finish_execution(&run, TaskState::Completed, "completed", None),
        Err(Error::Busy)
    ));
    assert_eq!(s.task(&task).unwrap().state, TaskState::Running);
    let stop = req(Command::Cancel {
        task_id: task.clone(),
    });
    s.cancel_execution(&stop, &task).unwrap();
    s.finish_execution(&run, TaskState::Completed, "completed", None)
        .unwrap();
    let snapshot = s.execution_snapshot(&task).unwrap();
    assert_eq!(snapshot.task.state, TaskState::Interrupted);
    assert_eq!(
        snapshot.latest_run.unwrap().reason.as_deref(),
        Some("user_stop")
    );
    assert!(s.has_execution_messages(&task, false).unwrap());
    // A duplicate stop does not affect the manually started successor.
    let next = queue(&mut s, &task, &p);
    s.activate_execution(&next).unwrap();
    assert!(s.cancel_execution(&stop, &task).unwrap().0.duplicate);
    assert_eq!(s.task(&task).unwrap().state, TaskState::Running);
    assert!(matches!(
        s.save_execution_context(&run, &snapshot.context, "late"),
        Err(Error::Conflict)
    ));
    assert!(matches!(
        s.finish_execution(&run, TaskState::Completed, "late", None),
        Err(Error::Conflict)
    ));
}
#[test]
fn queued_runs_recover_to_interrupted_and_duplicate_start_never_restarts() {
    let root = tempfile::tempdir().unwrap();
    let mut s = Store::open(root.path()).unwrap();
    let (task, p) = setup(&mut s);
    let start = req(Command::StartExecution {
        task_id: task.clone(),
    });
    s.queue_execution(&start, &task, &p).unwrap();
    let old = s
        .execution_snapshot(&task)
        .unwrap()
        .latest_run
        .unwrap()
        .run
        .id;
    drop(s);
    let mut s = Store::open(root.path()).unwrap();
    assert_eq!(s.task(&task).unwrap().state, TaskState::Interrupted);
    assert!(s.queue_execution(&start, &task, &p).unwrap().0.duplicate);
    assert_eq!(
        s.execution_snapshot(&task)
            .unwrap()
            .latest_run
            .unwrap()
            .run
            .id,
        old
    );
    let next = queue(&mut s, &task, &p);
    assert_eq!(
        s.execution_run(&next).unwrap().predecessor_id.as_deref(),
        Some(old.as_str())
    );
}
#[test]
fn recovery_event_preserves_envelope_source_and_distinct_resolution_source() {
    let root = tempfile::tempdir().unwrap();
    let mut s = Store::open(root.path()).unwrap();
    let (task, _) = setup(&mut s);
    let tx = s.connection.transaction().unwrap();
    let event = record(
        &tx,
        &Redactor::default(),
        Some(&task),
        None,
        EventSource::Recovery,
        Payload::ActionReconciled {
            action_id: "sample-action".into(),
            resolution_source: "receipt".into(),
        },
    )
    .unwrap();
    tx.commit().unwrap();
    let encoded = encode(&event).unwrap();
    let decoded: Event = serde_json::from_str(&encoded).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap()["source"], "recovery");
    let page = s
        .query(&Query::Events {
            task_id: Some(task.clone()),
            after: 0,
            limit: 128,
        })
        .unwrap();
    assert!(encode(&page).unwrap().contains("resolution_source"));
    let decoded: Response = serde_json::from_str(&encode(&page).unwrap()).unwrap();
    assert!(matches!(decoded, Response::Events { .. }));
    let old_payload: Payload = serde_json::from_value(
        json!({"kind":"agent_changed","agent_id":"legacy-agent","state":"completed"}),
    )
    .unwrap();
    let tx = s.connection.transaction().unwrap();
    let event = record(
        &tx,
        &Redactor::default(),
        Some(&task),
        None,
        EventSource::Engine,
        old_payload,
    )
    .unwrap();
    let roundtrip: Event = serde_json::from_str(&encode(&event).unwrap()).unwrap();
    assert_eq!(roundtrip.agent_id.as_deref(), Some("legacy-agent"));
    tx.commit().unwrap();
}
#[test]
fn schema_two_upgrades_with_existing_model_profile_and_settings_intact() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join("backups")).unwrap();
    let mut c = Connection::open(root.path().join("workpilot.sqlite3")).unwrap();
    migrate(
        &mut c,
        root.path(),
        &[
            (1, include_str!("../migrations/001_initial.sql")),
            (2, include_str!("../migrations/002_providers.sql")),
        ],
    )
    .unwrap();
    let mut p = ProviderProfile::new(
        "existing".into(),
        ProtocolKind::Messages,
        "https://example.com/v1".into(),
        "original-model".into(),
    );
    p.revision = 7;
    c.execute(
        "INSERT INTO provider_profiles(id,data_json) VALUES(?1,?2)",
        params![p.id, encode(&p).unwrap()],
    )
    .unwrap();
    c.execute(
        "INSERT INTO settings(key,value_json) VALUES('global_profile',?1)",
        [encode(&json!("existing")).unwrap()],
    )
    .unwrap();
    drop(c);
    let s = Store::open(root.path()).unwrap();
    let retained = s.profile("existing").unwrap();
    assert_eq!(retained.revision, 7);
    assert_eq!(retained.model, "original-model");
    assert_eq!(
        s.connection
            .query_row("PRAGMA user_version", [], |r| r.get::<_, u32>(0))
            .unwrap(),
        SCHEMA_VERSION
    );
    assert!(s.execution_tasks(64).unwrap().is_empty());
    assert_eq!(
        s.connection
            .query_row(
                "SELECT value_json FROM settings WHERE key='global_profile'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "\"existing\""
    );
    assert!(
        std::fs::read_dir(root.path().join("backups"))
            .unwrap()
            .any(|f| f
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains("before-v2"))
    );
}
