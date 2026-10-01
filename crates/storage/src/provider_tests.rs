use super::*;
use serde_json::json;
fn req(command: Command) -> Request {
    Request {
        request_id: id(),
        command,
    }
}
fn add(store: &mut Store, name: &str) -> ProviderProfile {
    let p = ProviderProfile::new(
        name.into(),
        ProtocolKind::Responses,
        "https://example.com/v1".into(),
        "model-one".into(),
    );
    let r = req(Command::SaveProvider {
        profile: Box::new(p.clone()),
        secret: None,
        clear_credential: false,
    });
    store.commit_profile(&r, p).unwrap();
    store.profile(name).unwrap()
}
fn set(store: &mut Store, scope: ProfileScope, profile: Option<&str>) {
    store
        .set_default_profile(
            &req(Command::SetDefaultProfile {
                scope: scope.clone(),
                profile_id: profile.map(str::to_owned),
            }),
            &scope,
            profile,
        )
        .unwrap();
}
fn start(store: &mut Store, p: &ProviderProfile) -> (Request, ModelCallRecord) {
    let r = req(Command::StartModelProbe {
        profile_id: Some(p.id.clone()),
        task_id: None,
        agent_id: None,
        mode: ModelProbeMode::Text,
        prompt: "probe".into(),
    });
    let c = store
        .start_model_call(&r, p, ModelProbeMode::Text, None)
        .unwrap()
        .0;
    (r, c)
}
fn output() -> ModelOutput {
    ModelOutput {
        text: "synthetic output".into(),
        tool_calls: vec![],
        continuation: ProviderContinuation {
            protocol: ProtocolKind::Responses,
            response_id: Some("r".into()),
            items: vec![
                json!({"type":"message","content":[{"type":"output_text","text":"synthetic output"}]}),
            ],
        },
        finish_reason: "stop".into(),
        actual_model: Some("model-one".into()),
        usage: Usage {
            input_tokens: Some(12),
            output_tokens: Some(7),
            cost_microunits: None,
            currency: None,
        },
        raw_usage: Some(json!({"input_tokens":12,"output_tokens":7})),
    }
}
#[test]
fn model_resolution_inherits_and_missing_selection_never_falls_back() {
    let root = tempfile::tempdir().unwrap();
    let mut s = Store::open(root.path()).unwrap();
    for n in ["global", "project", "task", "agent", "explicit"] {
        add(&mut s, n);
    }
    set(&mut s, ProfileScope::Global, Some("global"));
    let project = Project {
        id: "project-id".into(),
        name: "Project".into(),
        root_path: root.path().to_string_lossy().into(),
        default_profile_id: None,
        permission: PermissionMode::RequestApproval,
        created_at_ms: now_ms(),
    };
    s.save_project(&project).unwrap();
    let task = s
        .apply(&req(Command::CreateTask {
            title: "test".into(),
            project_id: Some(project.id.clone()),
        }))
        .unwrap()
        .0
        .task_id
        .unwrap();
    assert_eq!(
        s.resolve_profile(Some(&task), None, None).unwrap().id,
        "global"
    );
    set(
        &mut s,
        ProfileScope::Project { id: project.id },
        Some("project"),
    );
    assert_eq!(
        s.resolve_profile(Some(&task), None, None).unwrap().id,
        "project"
    );
    set(
        &mut s,
        ProfileScope::Task { id: task.clone() },
        Some("task"),
    );
    assert_eq!(
        s.resolve_profile(Some(&task), None, None).unwrap().id,
        "task"
    );
    s.connection
        .execute(
            "INSERT INTO agents(id,task_id,data_json) VALUES('agent-id',?1,?2)",
            params![task, encode(&json!({"profile_id":null})).unwrap()],
        )
        .unwrap();
    set(
        &mut s,
        ProfileScope::Agent {
            id: "agent-id".into(),
        },
        Some("agent"),
    );
    assert_eq!(
        s.resolve_profile(Some(&task), Some("agent-id"), None)
            .unwrap()
            .id,
        "agent"
    );
    assert_eq!(
        s.resolve_profile(Some(&task), Some("agent-id"), Some("explicit"))
            .unwrap()
            .id,
        "explicit"
    );
    assert!(
        s.resolve_profile(Some(&task), None, Some("missing"))
            .is_err()
    );
    assert!(s.resolve_profile(None, Some("agent-id"), None).is_err());
    let r = req(Command::DeleteProvider {
        profile_id: "task".into(),
        expected_revision: 1,
    });
    assert!(matches!(s.delete_profile(&r, "task", 1), Err(Error::Busy)));
}
#[test]
fn revisions_snapshot_dedup_and_capabilities_are_bound_to_actual_configuration() {
    let root = tempfile::tempdir().unwrap();
    let mut s = Store::open(root.path()).unwrap();
    let p = add(&mut s, "service");
    let (r, c) = start(&mut s, &p);
    let (_, dup, events) = s
        .start_model_call(&r, &p, ModelProbeMode::Text, None)
        .unwrap();
    assert!(dup && events.is_empty());
    let mut changed = p.clone();
    changed.model = "model-two".into();
    let r = req(Command::SaveProvider {
        profile: Box::new(changed.clone()),
        secret: None,
        clear_credential: false,
    });
    s.commit_profile(&r, changed.clone()).unwrap();
    assert!(matches!(
        s.commit_profile(&req(r.command.clone()), changed),
        Err(Error::Conflict)
    ));
    assert_eq!(s.profile("service").unwrap().revision, 2);
    s.finish_model_call(&c.id, Ok(output())).unwrap();
    s.record_capabilities(&c.id, &output()).unwrap();
    let call = s.model_call(&c.id).unwrap();
    assert_eq!(call.profile_snapshot.model, "model-one");
    assert_eq!(call.profile_revision, 1);
    assert_eq!(
        s.profile_with_observations("service")
            .unwrap()
            .capabilities
            .text
            .source,
        CapabilitySource::Unknown
    );
    assert!(call.profile_snapshot.credential.is_none());
    let current = s.profile("service").unwrap();
    let (_, next) = start(&mut s, &current);
    s.finish_model_call(&next.id, Ok(output())).unwrap();
    s.record_capabilities(&next.id, &output()).unwrap();
    assert_eq!(
        s.profile_with_observations("service")
            .unwrap()
            .capabilities
            .text
            .source,
        CapabilitySource::Observed
    );
}
#[test]
fn cancellation_is_atomic_and_late_output_cannot_turn_successful() {
    let root = tempfile::tempdir().unwrap();
    let mut s = Store::open(root.path()).unwrap();
    let p = add(&mut s, "service");
    let (r, c) = start(&mut s, &p);
    s.append_model_text(&c.id, "partial", false).unwrap();
    let cancel = req(Command::CancelModelProbe {
        call_id: c.id.clone(),
    });
    let diag = ModelDiagnostic {
        code: ModelErrorCode::Cancelled,
        message_zh: "已停止".into(),
        message_en: "Stopped".into(),
        detail: None,
        http_status: None,
        provider_request_id: None,
        retryable: false,
    };
    assert!(
        !s.cancel_model_call(&cancel, &c.id, diag.clone())
            .unwrap()
            .is_empty()
    );
    assert!(
        s.cancel_model_call(&cancel, &c.id, diag)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        s.cached_receipt(&r).unwrap().unwrap().status,
        CommandStatus::Interrupted
    );
    assert!(matches!(
        s.append_model_text(&c.id, "late", false),
        Err(Error::Conflict)
    ));
    assert!(matches!(
        s.finish_model_call(&c.id, Ok(output())),
        Err(Error::Conflict)
    ));
    let call = s.model_call(&c.id).unwrap();
    assert_eq!(call.state, ModelCallState::Cancelled);
    assert!(call.output.is_none());
    let (_, interrupted) = start(&mut s, &p);
    drop(s);
    let s = Store::open(root.path()).unwrap();
    assert_eq!(
        s.model_call(&interrupted.id).unwrap().state,
        ModelCallState::Interrupted
    );
    assert_eq!(
        s.task(&interrupted.task_id).unwrap().state,
        TaskState::Interrupted
    );
}
#[test]
fn profile_bundle_excludes_credentials_and_import_is_additive() {
    let root = tempfile::tempdir().unwrap();
    let mut s = Store::open(root.path()).unwrap();
    let mut p = add(&mut s, "service");
    p.credential = Some(CredentialRef {
        id: "own-system-reference".into(),
    });
    let r = req(Command::SaveProvider {
        profile: Box::new(p.clone()),
        secret: Some(SecretInput("synthetic-sensitive-key".into())),
        clear_credential: false,
    });
    s.register_secret("synthetic-sensitive-key").unwrap();
    s.commit_profile(&r, p).unwrap();
    set(&mut s, ProfileScope::Global, Some("service"));
    let bundle = s.export_profiles().unwrap();
    assert!(bundle.profiles[0].credential.is_none());
    let json = serde_json::to_string(&bundle).unwrap();
    assert!(!json.contains("own-system-reference") && !json.contains("synthetic-sensitive-key"));
    let r = req(Command::ImportProfiles {
        bundle: Box::new(bundle.clone()),
    });
    s.import_profiles(&r, &bundle).unwrap();
    s.import_profiles(&r, &bundle).unwrap();
    assert_eq!(s.profiles().unwrap().len(), 2);
    assert_eq!(s.global_profile().unwrap().as_deref(), Some("service"));
    let mut invalid = bundle;
    invalid.profiles[0].credential = Some(CredentialRef {
        id: "forged".into(),
    });
    assert!(
        s.import_profiles(
            &req(Command::ImportProfiles {
                bundle: Box::new(invalid.clone())
            }),
            &invalid
        )
        .is_err()
    );
    assert_eq!(s.profiles().unwrap().len(), 2);
}
#[test]
fn actual_schema_one_database_upgrades_without_losing_tasks_or_profiles() {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("workpilot.sqlite3");
    std::fs::create_dir_all(root.path().join("backups")).unwrap();
    let mut connection = Connection::open(&database).unwrap();
    migrate(
        &mut connection,
        root.path(),
        &[(1, include_str!("../migrations/001_initial.sql"))],
    )
    .unwrap();
    connection.execute("INSERT INTO provider_profiles(id,data_json) VALUES('legacy',?1)",[encode(&json!({"id":"legacy","label":"Legacy","protocol":"chat_completions","base_url":"https://example.com/v1","model":"old-model","credential":null,"supports_tools":true,"supports_images":false})).unwrap()]).unwrap();
    drop(connection);
    let mut s = Store::open(root.path()).unwrap();
    let legacy = s.profile("legacy").unwrap();
    assert_eq!(legacy.revision, 1);
    assert_eq!(legacy.capabilities.tools.source, CapabilitySource::User);
    assert_eq!(
        s.connection
            .query_row("PRAGMA user_version", [], |r| r.get::<_, u32>(0))
            .unwrap(),
        2
    );
    let r = req(Command::SaveProvider {
        profile: Box::new(legacy.clone()),
        secret: None,
        clear_credential: false,
    });
    s.commit_profile(&r, legacy).unwrap();
    assert_eq!(s.profile("legacy").unwrap().revision, 2);
}
