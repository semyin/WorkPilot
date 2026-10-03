use super::*;
use serde_json::Value;

fn candidate(name: &str, scope: Option<&str>) -> ExtensionImportCandidate {
    ExtensionImportCandidate {
        source_id: format!("source-{name}"),
        scope: scope.map(str::to_owned),
        version: PluginVersion {
            digest: format!("{:x}", Sha256::digest(name.as_bytes())),
            manifest: PluginManifest {
                format: 1,
                id: name.into(),
                name: name.into(),
                version: "1.0.0".into(),
                description: "Fixture".into(),
                skills: vec![],
                servers: vec![],
                dependencies: vec![],
            },
            skills: vec![],
            files: vec![],
            permissions: vec![],
            warnings: vec![],
            created_at_ms: 1,
        },
    }
}
fn apply(s: &mut Store, items: &[ExtensionImportCandidate]) -> Result<Value> {
    let preview =
        s.extension_transfer_preview("source-archive", Some("target-project"), "hash", items)?;
    s.import_extensions(
        "source-archive",
        Some("target-project"),
        "hash",
        items,
        &preview,
    )
}
#[test]
fn extension_migration_disabled_scope_and_dedup_survive_restart() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let entries = vec![
        candidate("global-skill", None),
        candidate("project-skill", Some("target-project")),
    ];
    let receipt = apply(&mut store, &entries).unwrap();
    let rows = store.extension_installations().unwrap();
    assert_eq!(rows.len(), 2);
    assert!(
        rows.iter()
            .all(|i| i.installed && !i.enabled && i.revision == 1 && !i.id.starts_with("source-"))
    );
    assert_eq!(rows.iter().filter(|i| i.scope.is_some()).count(), 1);
    assert_eq!(
        store
            .connection
            .query_row("SELECT count(*) FROM extension_credentials", [], |r| r
                .get::<_, usize>(0))
            .unwrap(),
        0
    );
    // User activation after import must not be reset by a duplicate retry.
    let mut activated = rows[0].clone();
    activated.enabled = true;
    store.extension_update(activated, 1, "enabled").unwrap();
    drop(store);
    let mut store = Store::open(directory.path()).unwrap();
    assert_eq!(apply(&mut store, &entries).unwrap(), receipt);
    assert_eq!(
        store
            .extension_installations()
            .unwrap()
            .iter()
            .filter(|i| i.enabled)
            .count(),
        1
    );
    assert!(
        store
            .extension_transfer_preview(
                "source-archive",
                Some("target-project"),
                "different",
                &entries
            )
            .is_err()
    );
}
#[test]
fn extension_migration_rolls_back_entire_batch_and_checks_stale_state() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let entries = vec![
        candidate("first", None),
        candidate("second", Some("target-project")),
    ];
    store.connection.execute_batch("CREATE TEMP TRIGGER reject_second BEFORE INSERT ON extension_installations WHEN NEW.slug='second' BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END;").unwrap();
    assert!(apply(&mut store, &entries).is_err());
    for table in [
        "extension_installations",
        "extension_versions",
        "extension_history",
    ] {
        assert_eq!(
            store
                .connection
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                    .get::<_, usize>(0))
                .unwrap(),
            0
        );
    }
    assert_eq!(
        store
            .connection
            .query_row(
                "SELECT count(*) FROM settings WHERE key LIKE 'extension-import:%'",
                [],
                |r| r.get::<_, usize>(0)
            )
            .unwrap(),
        0
    );
    store
        .connection
        .execute_batch("DROP TRIGGER reject_second")
        .unwrap();
    let old = store
        .extension_transfer_preview("source-archive", Some("target-project"), "hash", &entries)
        .unwrap();
    let extra = candidate("unrelated", None);
    let p = store
        .extension_transfer_preview(
            "other-archive",
            None,
            "different-hash",
            std::slice::from_ref(&extra),
        )
        .unwrap();
    store
        .import_extensions("other-archive", None, "different-hash", &[extra], &p)
        .unwrap();
    assert!(
        store
            .import_extensions(
                "source-archive",
                Some("target-project"),
                "hash",
                &entries,
                &old
            )
            .is_err()
    );
    apply(&mut store, &entries).unwrap();
    let conflict = store
        .extension_transfer_preview("new-archive", Some("target-project"), "new-hash", &entries)
        .unwrap();
    assert_eq!(conflict["conflicts"].as_array().unwrap().len(), 2);
    assert!(
        store
            .import_extensions(
                "new-archive",
                Some("target-project"),
                "new-hash",
                &entries,
                &conflict
            )
            .is_err()
    );
    let mut bad = entries.clone();
    bad[1].scope = Some("foreign-project".into());
    assert!(
        store
            .extension_transfer_preview("new-archive", Some("target-project"), "new-hash", &bad)
            .is_err()
    );
    assert!(
        store
            .extension_transfer_preview(
                "new-archive",
                None,
                "new-hash",
                &[entries[0].clone(), entries[0].clone()]
            )
            .is_err()
    );
    assert_eq!(store.extension_installations().unwrap().len(), 3);
}
