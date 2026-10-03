use super::*;
use std::sync::atomic::AtomicBool;

fn sample() -> (Manifest, Vec<u8>) {
    let content = b"binary\0\xff PRIVATE-FIXTURE-CONTENT".to_vec();
    let image = Image {
        exists: true,
        bytes: content.len() as u64,
        sha256: Some(codec::digest(&content)),
    };
    let m = Manifest {
        version: 1,
        archive_id: uuid::Uuid::new_v4().to_string(),
        created_at_ms: 1,
        revisions: vec![Revision {
            id: "revision-1".into(),
            task_id: "source-task".into(),
            operation_id: "original-operation".into(),
            path: "中文 空格.bin".into(),
            previous_path: None,
            change: "modified".into(),
            source: "editor".into(),
            at_ms: 10,
            before: image.clone(),
            after: image,
            origin: None,
        }],
    };
    (m, content)
}
const PASSWORD: &str = "fixture passphrase only";
#[test]
fn encrypted_archive_preserves_binary_and_sources_without_exporting_local_identity() {
    let (m, content) = sample();
    let stop = AtomicBool::new(false);
    let mut bytes = vec![];
    codec::write(&mut bytes, PASSWORD, &m, &stop, |_| Ok(content.clone())).unwrap();
    for secret in [
        content.as_slice(),
        PASSWORD.as_bytes(),
        "中文 空格.bin".as_bytes(),
        b"source-task",
    ] {
        assert!(!bytes.windows(secret.len()).any(|v| v == secret));
    }
    let mut copied = vec![];
    let (restored, _) = codec::read(bytes.as_slice(), PASSWORD, &stop, |_, data| {
        copied.push(data.to_vec());
        Ok(())
    })
    .unwrap();
    assert_eq!(copied, vec![content]); // identical before/after objects are stored once
    let rows = map_revisions(&restored, "new-task", "new-folder", "new-operation");
    assert_eq!(rows[0].root_identity, "new-folder");
    assert_eq!(rows[0].task_id, "new-task");
    assert!(rows[0].after.version.identity.is_none());
    assert_eq!(rows[0].origin.as_ref().unwrap().task_id, "source-task");
    assert_eq!(
        rows[0].origin.as_ref().unwrap().operation_id,
        "original-operation"
    );
}
#[test]
fn wrong_password_tampering_truncation_and_trailing_bytes_are_rejected() {
    let (m, content) = sample();
    let stop = AtomicBool::new(false);
    let mut bytes = vec![];
    codec::write(&mut bytes, PASSWORD, &m, &stop, |_| Ok(content.clone())).unwrap();
    assert!(
        codec::read(bytes.as_slice(), "incorrect passphrase", &stop, |_, _| Ok(
            ()
        ))
        .is_err()
    );
    for index in [0, 8, 24, 40, bytes.len() - 1] {
        let mut bad = bytes.clone();
        bad[index] ^= 1;
        assert!(codec::read(bad.as_slice(), PASSWORD, &stop, |_, _| Ok(())).is_err());
    }
    for length in [0, 23, bytes.len() - 1] {
        assert!(codec::read(&bytes[..length], PASSWORD, &stop, |_, _| Ok(())).is_err());
    }
    bytes.push(0);
    assert!(codec::read(bytes.as_slice(), PASSWORD, &stop, |_, _| Ok(())).is_err());
}
#[test]
fn traversal_excess_size_duplicate_entries_and_cancellation_are_rejected() {
    let (mut m, content) = sample();
    let stop = AtomicBool::new(false);
    for path in [
        "../outside.txt",
        "C:/escape.txt",
        ".git/config",
        "a/../../outside",
    ] {
        m.revisions[0].path = path.into();
        assert!(m.objects().is_err());
    }
    m.revisions[0].path = "valid.bin".into();
    m.revisions[0].before.bytes = 65 * 1024 * 1024;
    assert!(m.objects().is_err());
    let (mut m, _) = sample();
    m.revisions.push(m.revisions[0].clone());
    assert!(m.objects().is_err());
    let (m, _) = sample();
    stop.store(true, Ordering::Relaxed);
    let mut bytes = vec![];
    assert!(codec::write(&mut bytes, PASSWORD, &m, &stop, |_| Ok(content.clone())).is_err());
    assert!(bytes.is_empty());
}
#[test]
fn settings_document_is_encrypted_authenticated_bounded_and_distinct_from_history() {
    let stop = std::sync::atomic::AtomicBool::new(false);
    let payload = b"{\"version\":1,\"rules\":\"private settings\"}";
    let mut bytes = vec![];
    super::codec::write_document(&mut bytes, "fixture settings passphrase", payload, &stop)
        .unwrap();
    assert!(!bytes.windows(payload.len()).any(|v| v == payload));
    let (plain, _) =
        super::codec::read_document(bytes.as_slice(), "fixture settings passphrase", &stop)
            .unwrap();
    assert_eq!(plain.as_slice(), payload);
    assert!(
        super::codec::read_document(bytes.as_slice(), "incorrect fixture passphrase", &stop)
            .is_err()
    );
    for index in [0, 8, 32, bytes.len() - 1] {
        let mut bad = bytes.clone();
        bad[index] ^= 1;
        assert!(
            super::codec::read_document(bad.as_slice(), "fixture settings passphrase", &stop)
                .is_err()
        );
    }
    let mut tail = bytes.clone();
    tail.push(0);
    assert!(
        super::codec::read_document(tail.as_slice(), "fixture settings passphrase", &stop).is_err()
    );
    assert!(
        super::codec::read(
            bytes.as_slice(),
            "fixture settings passphrase",
            &stop,
            |_, _| Ok(())
        )
        .is_err()
    );
    assert!(
        super::codec::write_document(
            vec![],
            "fixture settings passphrase",
            &vec![0; 1048577],
            &stop
        )
        .is_err()
    );
    stop.store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(
        super::codec::read_document(bytes.as_slice(), "fixture settings passphrase", &stop)
            .is_err()
    );
}
