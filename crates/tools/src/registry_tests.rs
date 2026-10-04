use super::*;

fn settings(directory: &std::path::Path) -> ToolSettingsView {
    ToolSettingsView {
        settings: ToolSettings {
            root_path: Some(directory.to_string_lossy().into_owned()),
            permission: Some(PermissionMode::FullAccess),
            ..Default::default()
        },
        defaults: DefaultToolSettings::default(),
        effective_permission: PermissionMode::FullAccess,
        review_profile_id: None,
        epoch: "test-epoch".into(),
        root_identity: None,
    }
}

fn write_call(path: &str, expected: Value) -> ModelToolCall {
    ModelToolCall {
        id: "test-write".into(),
        provider_item_id: None,
        name: "write_file".into(),
        arguments: json!({"path":path,"text":"replacement","expected_sha256":expected}),
    }
}

#[test]
fn malformed_hash_is_parameter_error_without_creating_or_modifying_files() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(temp.path().join("existing.txt"), "original").unwrap();
    let view = settings(temp.path());
    for invalid in [
        "null".into(),
        "None".into(),
        "".into(),
        "0".repeat(63),
        "g".repeat(64),
        "a".repeat(65),
    ] {
        for path in ["new.txt", "existing.txt"] {
            let error = prepare(
                "task",
                "action",
                &write_call(path, json!(invalid)),
                WorkMode::Execute,
                &view,
            )
            .err()
            .unwrap()
            .to_string();
            assert!(error.contains("expected_sha256") && error.contains("JSON null"));
            assert!(!error.contains("file changed"));
        }
    }
    assert!(!temp.path().join("new.txt").exists());
    assert_eq!(
        std::fs::read_to_string(temp.path().join("existing.txt")).unwrap(),
        "original"
    );
}

#[test]
fn actual_hash_and_real_json_null_prepare_bound_actions_without_writing() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(temp.path().join("existing.txt"), "original").unwrap();
    let view = settings(temp.path());
    let hash = Root::open(temp.path().to_str().unwrap(), None)
        .unwrap()
        .snapshot("existing.txt")
        .unwrap()
        .version
        .sha256
        .unwrap();
    let existing = prepare(
        "task",
        "action",
        &write_call("existing.txt", json!(hash)),
        WorkMode::Execute,
        &view,
    )
    .unwrap();
    assert_eq!(
        existing.intent.version.sha256.as_deref(),
        Some(hash.as_str())
    );
    assert!(matches!(existing.action, Action::Write { .. }));
    let new = prepare(
        "task",
        "action2",
        &write_call("new.txt", Value::Null),
        WorkMode::Execute,
        &view,
    )
    .unwrap();
    assert!(!new.intent.version.exists);
    assert!(!temp.path().join("new.txt").exists());
    assert_eq!(
        std::fs::read_to_string(temp.path().join("existing.txt")).unwrap(),
        "original"
    );
}

#[test]
fn a_well_formed_but_stale_hash_or_null_for_an_existing_file_still_rejects() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(temp.path().join("existing.txt"), "original").unwrap();
    let view = settings(temp.path());
    for expected in [json!("0".repeat(64)), Value::Null] {
        let error = prepare(
            "task",
            "action",
            &write_call("existing.txt", expected),
            WorkMode::Execute,
            &view,
        )
        .err()
        .unwrap()
        .to_string();
        assert!(error.contains("file changed"));
    }
    assert_eq!(
        std::fs::read_to_string(temp.path().join("existing.txt")).unwrap(),
        "original"
    );
}
