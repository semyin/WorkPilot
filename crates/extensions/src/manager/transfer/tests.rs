use super::*;

fn fixture() -> ExtensionTransferBundle {
    let files: package::Contents = [
        ("SKILL.md".into(), b"---\nname: portable-skill\ndescription: Portable test fixture\n---\nRead the binary template.\n".to_vec()),
        ("assets/template.bin".into(), vec![0, 255, 10, 3]),
    ].into_iter().collect();
    let (version, files) = package::validate(files).unwrap();
    ExtensionTransferBundle {
        version: 1,
        archive_id: uuid::Uuid::new_v4().to_string(),
        created_at_ms: 1,
        entries: vec![PortableExtension {
            source_id: "source-installation".into(),
            project_scoped: true,
            was_enabled: true,
            digest: version.digest,
            files: files
                .into_iter()
                .map(|(path, bytes)| ExtensionArchiveFile {
                    path,
                    base64: STANDARD.encode(bytes),
                })
                .collect(),
        }],
    }
}
#[tokio::test]
async fn extension_migration_revalidates_resources_and_imports_inactive() {
    let dir = tempfile::tempdir().unwrap();
    let storage = Storage::open(dir.path().into()).await.unwrap();
    let manager = Manager::new(storage, dir.path().into());
    let stop = AtomicBool::new(false);
    let bundle = fixture();
    let preview = manager
        .inspect_transfer(Some("new-project"), &bundle, "archive-digest", &stop)
        .await
        .unwrap();
    assert_eq!(preview["entries"][0]["project_scoped"], true);
    assert_eq!(preview["entries"][0]["was_enabled"], true);
    let receipt = manager
        .import_transfer(
            Some("new-project"),
            &bundle,
            "archive-digest",
            &preview["state"],
            &stop,
        )
        .await
        .unwrap();
    let id = receipt["receipt"]["installations"][0]["installation_id"]
        .as_str()
        .unwrap();
    let (installation, version) = manager
        .installation(id, Some(1), Some("new-project"), false)
        .await
        .unwrap();
    assert!(!installation.enabled);
    assert!(
        manager
            .installation(id, None, Some("old-project"), false)
            .await
            .is_err()
    );
    assert!(
        manager
            .installation(id, None, Some("new-project"), true)
            .await
            .is_err()
    );
    assert_eq!(
        package::read_verified(
            &manager.version_path(&version.digest),
            &version,
            "assets/template.bin"
        )
        .unwrap(),
        vec![0, 255, 10, 3]
    );
    let selection = [ExtensionSelection {
        installation_id: id.into(),
        revision: 1,
    }];
    let exported = manager
        .export_transfer(Some("new-project"), &selection, &stop)
        .await
        .unwrap();
    assert_eq!(exported.entries[0].digest, bundle.entries[0].digest);
    assert!(!exported.entries[0].was_enabled);
    std::fs::write(
        manager
            .version_path(&version.digest)
            .join("assets/template.bin"),
        "changed",
    )
    .unwrap();
    assert!(
        manager
            .export_transfer(Some("new-project"), &selection, &stop)
            .await
            .is_err()
    );
}
#[tokio::test]
async fn extension_migration_rejects_bad_packages_credentials_and_cancel() {
    let dir = tempfile::tempdir().unwrap();
    let storage = Storage::open(dir.path().into()).await.unwrap();
    let manager = Manager::new(storage.clone(), dir.path().into());
    let stop = AtomicBool::new(false);
    let bundle = fixture();
    assert!(
        manager
            .prepare_transfer(&bundle, None, &stop)
            .await
            .is_err()
    );
    let mut broken = Vec::new();
    let mut b = bundle.clone();
    b.version = 99;
    broken.push(b);
    let mut b = bundle.clone();
    b.entries.push(b.entries[0].clone());
    broken.push(b);
    let mut b = bundle.clone();
    let duplicate = b.entries[0].files[0].clone();
    b.entries[0].files.push(duplicate);
    broken.push(b);
    let mut b = bundle.clone();
    b.entries[0].files[0].path = "../outside".into();
    broken.push(b);
    let mut b = bundle.clone();
    b.entries[0].files[0].base64 = "?not-base64".into();
    broken.push(b);
    let mut b = bundle.clone();
    b.entries[0].digest = "0".repeat(64);
    broken.push(b);
    let mut b = bundle.clone();
    b.entries[0].files = vec![b.entries[0].files[0].clone(); 513];
    broken.push(b);
    for invalid in broken {
        assert!(
            manager
                .prepare_transfer(&invalid, Some("target"), &stop)
                .await
                .is_err()
        );
    }
    storage
        .call(|s| s.register_secret("Portable test fixture"))
        .await
        .unwrap();
    assert!(
        manager
            .prepare_transfer(&bundle, Some("target"), &stop)
            .await
            .is_err()
    );
    stop.store(true, Ordering::SeqCst);
    assert!(
        manager
            .prepare_transfer(&fixture(), Some("target"), &stop)
            .await
            .is_err()
    );
    assert!(!manager.version_path(&bundle.entries[0].digest).exists());
}
