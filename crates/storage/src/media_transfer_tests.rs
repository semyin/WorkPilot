use super::*;
use serde_json::json;
use std::sync::atomic::AtomicBool;

fn bundle() -> MediaTransferBundle {
    MediaTransferBundle {
        version: 1,
        archive_id: id(),
        created_at_ms: 1,
        entries: ["one.txt", "two.txt"]
            .iter()
            .map(|name| MediaTransferEntry {
                id: id(),
                task_id: "source-task".into(),
                name: name.to_string(),
                source: "generated".into(),
                at_ms: 5,
                bytes: 3,
                sha256: "a".repeat(64),
                path: Some(name.to_string()),
                operation_id: Some("source-operation".into()),
                origin: None,
            })
            .collect(),
    }
}
fn batch(
    store: &Store,
    task: &str,
    bundle: &MediaTransferBundle,
    prefix: &str,
) -> MediaImportBatch {
    let digest = "d".repeat(64);
    MediaImportBatch {
        bundle: bundle.clone(),
        digest: digest.clone(),
        name_prefix: prefix.into(),
        expected: store
            .media_transfer_preview(task, bundle, &digest, prefix)
            .unwrap(),
        candidates: bundle
            .entries
            .iter()
            .map(|entry| MediaImportCandidate {
                asset: MediaAsset {
                    id: id(),
                    task_id: Some(task.into()),
                    name: format!("{prefix}{}", entry.name),
                    source: "file".into(),
                    media_type: "text/plain".into(),
                    bytes: entry.bytes,
                    sha256: entry.sha256.clone(),
                    at_ms: 10,
                    units: 1,
                    warnings: vec![],
                    image: None,
                    path: None,
                    version: None,
                    operation_id: None,
                    origin: Some(bundle.origin(entry)),
                },
                original_blob: entry.sha256.clone(),
                parsed_blob: "b".repeat(64),
            })
            .collect(),
    }
}
#[test]
fn attachment_import_preserves_origin_and_ids_without_rebinding_or_resurrecting() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let (task, _) = crate::execution_tests::setup(&mut store);
    let bundle = bundle();
    let batch = batch(&store, &task, &bundle, "copy-");
    let stop = AtomicBool::new(false);
    let receipt = store.import_media_rows(&task, &batch, &stop).unwrap();
    let rows = store.media_list(&task).unwrap();
    assert_eq!(rows.len(), 2);
    for row in &rows {
        assert_eq!(row.source, "file");
        assert!(row.path.is_none() && row.version.is_none() && row.operation_id.is_none());
        let origin = row.origin.as_ref().unwrap();
        assert_eq!(origin.task_id, "source-task");
        assert_eq!(origin.source, "generated");
        assert_ne!(row.id, origin.asset_id);
    }
    let removed = rows[0].id.clone();
    store.media_remove(&removed).unwrap();
    drop(store);
    let mut store = Store::open(directory.path()).unwrap();
    assert_eq!(
        store.import_media_rows(&task, &batch, &stop).unwrap(),
        receipt
    );
    assert_eq!(store.media_list(&task).unwrap().len(), 1);
    assert!(store.media_asset(&removed).is_err());
    assert!(
        store
            .media_transfer_preview(&task, &bundle, &"c".repeat(64), "copy-")
            .is_err()
    );
}
#[test]
fn attachment_batch_rolls_back_on_second_insert_cancel_stale_state_and_foreign_mapping() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let (task, _) = crate::execution_tests::setup(&mut store);
    let bundle = bundle();
    let original = batch(&store, &task, &bundle, "");
    let stop = AtomicBool::new(false);
    store.connection.execute_batch("CREATE TEMP TRIGGER reject_second BEFORE INSERT ON media_assets WHEN json_extract(NEW.data_json,'$.name')='two.txt' BEGIN SELECT RAISE(ABORT,'fixture write failure'); END;").unwrap();
    assert!(store.import_media_rows(&task, &original, &stop).is_err());
    assert!(store.media_list(&task).unwrap().is_empty());
    assert_eq!(
        store
            .connection
            .query_row(
                "SELECT count(*) FROM settings WHERE key LIKE 'media-import:%'",
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
    assert!(
        store
            .import_media_rows(&task, &original, &AtomicBool::new(true))
            .is_err()
    );
    let mut foreign = batch(&store, &task, &bundle, "");
    foreign.candidates[1].asset.task_id = Some("foreign-task".into());
    assert!(store.import_media_rows(&task, &foreign, &stop).is_err());
    assert!(store.media_list(&task).unwrap().is_empty());
    store
        .connection
        .execute(
            "UPDATE tasks SET last_sequence=last_sequence+1 WHERE id=?1",
            [&task],
        )
        .unwrap();
    assert!(store.import_media_rows(&task, &original, &stop).is_err());
    let fresh = batch(&store, &task, &bundle, "");
    store.import_media_rows(&task, &fresh, &stop).unwrap();
    assert_eq!(store.media_list(&task).unwrap().len(), 2);
}
#[test]
fn attachment_preview_uses_whole_library_and_rejects_archived_running_or_secret_metadata() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let (task, _) = crate::execution_tests::setup(&mut store);
    let mut bundle = bundle();
    let initial = batch(&store, &task, &bundle, "");
    let stop = AtomicBool::new(false);
    store.import_media_rows(&task, &initial, &stop).unwrap();
    bundle.archive_id = id();
    let preview = store
        .media_transfer_preview(&task, &bundle, &"f".repeat(64), "")
        .unwrap();
    assert_eq!(preview["same_names"], json!(["one.txt", "two.txt"]));
    assert_eq!(preview["conflicts"], json!([]));
    store
        .connection
        .execute("UPDATE tasks SET state='running' WHERE id=?1", [&task])
        .unwrap();
    let blocked = batch(&store, &task, &bundle, "");
    assert!(!blocked.expected["conflicts"].as_array().unwrap().is_empty());
    assert!(store.import_media_rows(&task, &blocked, &stop).is_err());
    store
        .connection
        .execute(
            "UPDATE tasks SET state='interrupted',archived=1 WHERE id=?1",
            [&task],
        )
        .unwrap();
    assert!(
        !store
            .media_transfer_preview(&task, &bundle, &"f".repeat(64), "")
            .unwrap()["conflicts"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let prefix = "MEDIA-METADATA-CREDENTIAL-CANARY";
    store
        .connection
        .execute("UPDATE tasks SET archived=0 WHERE id=?1", [&task])
        .unwrap();
    let before_registration = batch(&store, &task, &bundle, prefix);
    store.register_secret(prefix).unwrap();
    assert!(
        store
            .media_transfer_preview(&task, &bundle, &"f".repeat(64), prefix)
            .is_err()
    );
    // Recheck at commit too: credentials can be registered after preview.
    assert!(
        store
            .import_media_rows(&task, &before_registration, &stop)
            .is_err()
    );
    bundle.entries[0].name = "MEDIA-METADATA-CREDENTIAL-CANARY.txt".into();
    assert!(
        store
            .media_transfer_preview(&task, &bundle, &"f".repeat(64), "")
            .is_err()
    );
}
