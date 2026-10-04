use super::*;
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair},
};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
};
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn signed(manifest: &Manifest, key: &Ed25519KeyPair) -> Vec<u8> {
    let raw = serde_json::to_string(manifest).unwrap();
    let envelope=serde_json::to_vec(&serde_json::json!({"key_id":"test","manifest":raw,"signature":hex(key.sign(raw.as_bytes()).as_ref())})).unwrap();
    let mut out = b"WPUPDT01".to_vec();
    out.extend((envelope.len() as u32).to_le_bytes());
    out.extend(envelope);
    out
}
struct Fixture {
    _temp: tempfile::TempDir,
    install: PathBuf,
    data: PathBuf,
    package: PathBuf,
    trust: String,
    manifest: Manifest,
    key: Ed25519KeyPair,
}

#[test]
fn recovery_entry_is_outside_install_and_never_overwrites_unknown_files() {
    let f = Fixture::new();
    fs::write(
        f.install.join("workpilot-update.exe"),
        b"current trusted helper",
    )
    .unwrap();
    let p = f.prepared();
    let entry = recovery_entry(&p).unwrap();
    assert_eq!(entry.executable.parent(), p.install.parent());
    assert!(!entry.executable.starts_with(&p.install));
    fs::write(&entry.executable, b"unknown user file").unwrap();
    assert!(create_recovery_entry(&p).is_err());
    assert_eq!(fs::read(&entry.executable).unwrap(), b"unknown user file");
    fs::remove_file(&entry.executable).unwrap();
    fs::write(&entry.instructions, b"unknown user instructions").unwrap();
    assert!(create_recovery_entry(&p).is_err());
    assert!(!entry.executable.exists());
    assert_eq!(
        fs::read(&entry.instructions).unwrap(),
        b"unknown user instructions"
    );
    fs::remove_file(&entry.instructions).unwrap();
    create_recovery_entry(&p).unwrap();
    validate_recovery_entry(&p).unwrap();
    assert!(
        fs::read_to_string(&entry.instructions)
            .unwrap()
            .contains("双击")
    );
    fs::write(&entry.executable, b"tampered").unwrap();
    assert!(validate_recovery_entry(&p).is_err());
    f.original();
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let install = temp.path().join("原程序 安装");
        let data = temp.path().join("用户资料 数据");
        fs::create_dir(&install).unwrap();
        fs::create_dir(&data).unwrap();
        fs::write(install.join("original.txt"), b"original").unwrap();
        fs::write(data.join("user-asset.bin"), [0, 1, 255]).unwrap();
        let db = rusqlite::Connection::open(data.join("workpilot.sqlite3")).unwrap();
        db.execute_batch("CREATE TABLE audit(value TEXT); INSERT INTO audit VALUES('untouched'); PRAGMA user_version=11;").unwrap();
        drop(db);
        let key = Ed25519KeyPair::from_pkcs8(
            Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
                .unwrap()
                .as_ref(),
        )
        .unwrap();
        let trust =
            serde_json::json!({"key_id":"test","public_key":hex(key.public_key().as_ref())})
                .to_string();
        let content = b"signed new binary";
        let manifest = Manifest {
            format: 1,
            version: "2.0.0".into(),
            platform: "windows-x86_64".into(),
            notes: "test release".into(),
            database_min: 11,
            database_target: 12,
            application: vec!["desktop".into()],
            tools: vec![],
            files: [
                "workpilot-desktop.exe",
                "workpilot-sidecar.exe",
                "workpilot-update.exe",
            ]
            .into_iter()
            .map(|path| Entry {
                path: path.into(),
                bytes: content.len() as u64,
                sha256: format!("{:x}", Sha256::digest(content)),
            })
            .collect(),
        };
        let package = temp.path().join("signed.wpupdate");
        let mut bytes = signed(&manifest, &key);
        for _ in &manifest.files {
            bytes.extend(content)
        }
        fs::write(&package, bytes).unwrap();
        Self {
            _temp: temp,
            install,
            data,
            package,
            trust,
            manifest,
            key,
        }
    }
    fn prepared(&self) -> Prepared {
        let (preview, _) = format::inspect_with_trust(
            &mut fs::File::open(&self.package).unwrap(),
            "1.0.0",
            &self.trust,
        )
        .unwrap();
        install::prepare_trusted(
            &self.install,
            &self.data,
            self.package.to_str().unwrap(),
            "1.0.0",
            &preview.fingerprint,
            &self.trust,
        )
        .unwrap()
    }
    fn verify(&self, p: &Prepared) -> Result<()> {
        install::verify_stage_trusted(p, &self.trust)
    }
    fn migrate(&self, _p: &Prepared, data: &Path) -> Result<()> {
        let db = rusqlite::Connection::open(data.join("workpilot.sqlite3")).unwrap();
        db.execute_batch("UPDATE audit SET value='migrated'; PRAGMA user_version=12;")
            .unwrap();
        Ok(())
    }
    fn original(&self) {
        assert_eq!(
            fs::read(self.install.join("original.txt")).unwrap(),
            b"original"
        );
        let db = rusqlite::Connection::open(self.data.join("workpilot.sqlite3")).unwrap();
        assert_eq!(
            db.query_row::<String, _, _>("SELECT value FROM audit", [], |r| r.get(0))
                .unwrap(),
            "untouched"
        );
        assert_eq!(
            db.query_row::<u32, _, _>("PRAGMA user_version", [], |r| r.get(0))
                .unwrap(),
            11
        );
        assert_eq!(
            fs::read(self.data.join("user-asset.bin")).unwrap(),
            [0, 1, 255]
        );
    }
}
#[test]
fn signature_is_real_and_untrusted_or_modified_metadata_is_refused() {
    let f = Fixture::new();
    let signed = signed(&f.manifest, &f.key);
    assert!(format::inspect_with_trust(&mut Cursor::new(&signed), "1.0.0", &f.trust).is_ok());
    assert!(format::inspect_with_trust(&mut Cursor::new(&signed), "1.0.0", TRUST).is_err());
    let mut bad = signed.clone();
    let at = bad.windows(12).position(|b| b == b"test release").unwrap();
    bad[at] = b'X';
    assert!(format::inspect_with_trust(&mut Cursor::new(bad), "1.0.0", &f.trust).is_err());
    assert!(format::inspect_with_trust(&mut Cursor::new(signed), "2.0.0", &f.trust).is_err());
    f.original();
}
#[test]
fn signed_dangerous_paths_duplicates_or_wrong_platform_are_still_refused() {
    let f = Fixture::new();
    for path in [
        "../outside",
        "C:/outside",
        "CON.txt",
        "folder/../bad",
        "folder/a.",
        "folder\\file",
        "workpilot-desktop.exe/child",
    ] {
        let mut m = f.manifest.clone();
        m.files.push(Entry {
            path: path.into(),
            bytes: 0,
            sha256: format!("{:x}", Sha256::digest([])),
        });
        assert!(
            format::inspect_with_trust(&mut Cursor::new(signed(&m, &f.key)), "1.0.0", &f.trust)
                .is_err(),
            "{path}"
        );
    }
    let mut m = f.manifest.clone();
    m.files.push(m.files[0].clone());
    assert!(m.validate("1.0.0").is_err());
    m = f.manifest.clone();
    m.platform = "linux-x86_64".into();
    assert!(m.validate("1.0.0").is_err());
    f.original();
}
#[test]
fn truncated_bad_payload_and_untrusted_tail_leave_current_install_and_data_untouched() {
    for change in 0..3 {
        let f = Fixture::new();
        let mut bytes = fs::read(&f.package).unwrap();
        match change {
            0 => {
                bytes.pop();
            }
            1 => {
                *bytes.last_mut().unwrap() ^= 1;
            }
            _ => bytes.push(1),
        }
        fs::write(&f.package, bytes).unwrap();
        let (preview, _) =
            format::inspect_with_trust(&mut fs::File::open(&f.package).unwrap(), "1.0.0", &f.trust)
                .unwrap();
        assert!(
            install::prepare_trusted(
                &f.install,
                &f.data,
                f.package.to_str().unwrap(),
                "1.0.0",
                &preview.fingerprint,
                &f.trust
            )
            .is_err()
        );
        f.original();
    }
}
#[test]
fn verified_staging_cannot_be_changed_before_install() {
    let f = Fixture::new();
    let mut p = f.prepared();
    assert!(f.verify(&p).is_ok());
    let extra = p.job.join("next/unlisted.txt");
    fs::write(&extra, b"unsigned addition").unwrap();
    assert!(f.verify(&p).is_err());
    fs::remove_file(extra).unwrap();
    p.manifest.notes = "different metadata".into();
    assert!(f.verify(&p).is_err());
    p.manifest = f.manifest.clone();
    fs::write(p.job.join("next/workpilot-sidecar.exe"), b"modified").unwrap();
    assert!(f.verify(&p).is_err());
    f.original();
}
#[test]
fn successful_update_keeps_whole_old_install_and_database_before_switching_both() {
    let f = Fixture::new();
    fs::write(f.install.join("uninstall.exe"), b"local uninstaller").unwrap();
    let mut p = f.prepared();
    install::transaction::steps(&mut p, |p| f.verify(p), |p, d| f.migrate(p, d), |_| Ok(()))
        .unwrap();
    assert_eq!(p.phase, "committed");
    assert!(f.install.join("workpilot-desktop.exe").is_file());
    assert_eq!(
        fs::read(f.install.join("uninstall.exe")).unwrap(),
        b"local uninstaller"
    );
    assert_eq!(
        fs::read(p.job.join("previous/original.txt")).unwrap(),
        b"original"
    );
    let db = rusqlite::Connection::open(p.data_job.join("previous/workpilot.sqlite3")).unwrap();
    assert_eq!(
        db.query_row::<u32, _, _>("PRAGMA user_version", [], |r| r.get(0))
            .unwrap(),
        11
    );
    let db = rusqlite::Connection::open(f.data.join("workpilot.sqlite3")).unwrap();
    assert_eq!(
        db.query_row::<u32, _, _>("PRAGMA user_version", [], |r| r.get(0))
            .unwrap(),
        12
    );
    assert_eq!(
        recover_for_install(&p.install).unwrap().unwrap().state,
        "committed"
    );
}
#[test]
fn migration_failure_keeps_original_database_usable_and_does_not_install() {
    let f = Fixture::new();
    let mut p = f.prepared();
    let migrated = std::cell::Cell::new(false);
    assert!(
        install::transaction::steps(
            &mut p,
            |p| f.verify(p),
            |p, d| {
                f.migrate(p, d)?;
                migrated.set(true);
                Err("deliberate migration failure".into())
            },
            |_| Ok(())
        )
        .is_err()
    );
    assert!(migrated.get());
    let recovered = recover(&p.job.join("prepared.json")).unwrap();
    assert!(recovered.previous_install.is_none());
    assert!(recovered.previous_data.is_none());
    assert!(
        recovered
            .recovery_locations
            .iter()
            .any(|x| x.kind == "staged_data")
    );
    f.original();
}
#[test]
fn interruption_at_each_switch_boundary_recovers_matching_old_program_and_data() {
    for fail in [
        "backing_up",
        "ready_to_switch",
        "application_saved",
        "application_switched",
        "data_saved",
        "data_switched",
    ] {
        let f = Fixture::new();
        let mut p = f.prepared();
        let reached = std::cell::Cell::new(false);
        assert!(
            install::transaction::steps(
                &mut p,
                |p| f.verify(p),
                |p, d| f.migrate(p, d),
                |phase| if phase == fail {
                    reached.set(true);
                    Err("interrupted".into())
                } else {
                    Ok(())
                }
            )
            .is_err()
        );
        assert!(reached.get(), "must reach simulated interruption: {fail}");
        let result =
            recover(&p.job.join("prepared.json")).unwrap_or_else(|e| panic!("{fail}: {e}"));
        assert_eq!(result.state, "rolled_back");
        f.original();
        assert_eq!(
            recover_for_install(&p.install).unwrap().unwrap().state,
            "rolled_back"
        );
    }
}
#[test]
fn stable_upgrade_lock_excludes_engines_and_survives_data_directory_replacement() {
    let f = Fixture::new();
    let shared = data_update_lock(&f.data, false).unwrap();
    assert!(data_update_lock(&f.data, true).is_err());
    drop(shared);
    let exclusive = data_update_lock(&f.data, true).unwrap();
    assert!(data_update_lock(&f.data, false).is_err());
    fs::rename(&f.data, f.data.with_extension("old")).unwrap();
    fs::create_dir(&f.data).unwrap();
    assert!(data_update_lock(&f.data, false).is_err());
    drop(exclusive);
    assert!(data_update_lock(&f.data, false).is_ok());
}
#[test]
fn invalid_source_or_lost_network_cannot_mutate_local_install() {
    let f = Fixture::new();
    for source in [
        "relative.wpupdate",
        "http://127.0.0.1/update",
        "https://user:password@example.com/update",
    ] {
        assert!(inspect_source(source, "1.0.0").is_err());
    }
    assert!(inspect_source("https://127.0.0.1:1/update", "1.0.0").is_err());
    f.original();
}
#[test]
fn recovery_cleanup_requires_exact_confirmation_and_offline_lock_and_keeps_exports_and_unknown_children()
 {
    let f = Fixture::new();
    let mut p = f.prepared();
    install::transaction::steps(&mut p, |p| f.verify(p), |p, d| f.migrate(p, d), |_| Ok(()))
        .unwrap();
    fs::write(
        p.data_job.join("previous/keep-export.wptask"),
        b"user export",
    )
    .unwrap();
    fs::create_dir(p.job.join("unrecognized")).unwrap();
    fs::write(p.job.join("unrecognized/keep.txt"), b"unknown").unwrap();
    fs::write(
        p.data_job.join("previous/keep-export.wpmigrate"),
        b"unified export",
    )
    .unwrap();
    let magics = [
        b"WPFULL01",
        b"WPHIST01",
        b"WPTASK01",
        b"WPMEDIA1",
        b"WPEXT001",
        b"WPSET001",
        b"WPFILE01",
        b"WPUPDT01",
    ];
    for (index, magic) in magics.iter().enumerate() {
        fs::write(
            p.data_job
                .join(format!("previous/wrong-extension-{index}.arbitrary")),
            magic,
        )
        .unwrap();
    }
    let current = files::hash_file(&f.data.join("workpilot.sqlite3")).unwrap();
    let preview = cleanup::preview_trusted(&f.install, &f.data, &f.trust).unwrap();
    assert!(preview.files > 0);
    assert!(
        cleanup::delete_trusted(&f.install, &f.data, &preview.fingerprint, "yes", &f.trust)
            .is_err()
    );
    let lock = data_update_lock(&f.data, false).unwrap();
    assert!(
        cleanup::delete_trusted(
            &f.install,
            &f.data,
            &preview.fingerprint,
            "DELETE",
            &f.trust
        )
        .is_err()
    );
    drop(lock);
    cleanup::delete_trusted(
        &f.install,
        &f.data,
        &preview.fingerprint,
        "DELETE",
        &f.trust,
    )
    .unwrap();
    assert_eq!(
        current,
        files::hash_file(&f.data.join("workpilot.sqlite3")).unwrap()
    );
    assert!(f.install.join("workpilot-sidecar.exe").is_file());
    assert!(!p.job.join("previous/original.txt").exists());
    assert_eq!(
        fs::read(p.data_job.join("previous/keep-export.wptask")).unwrap(),
        b"user export"
    );
    assert_eq!(
        fs::read(p.job.join("unrecognized/keep.txt")).unwrap(),
        b"unknown"
    );
    assert!(p.job.join("prepared.json").is_file());
    assert_eq!(
        fs::read(p.data_job.join("previous/keep-export.wpmigrate")).unwrap(),
        b"unified export"
    );
    for (index, magic) in magics.iter().enumerate() {
        assert_eq!(
            fs::read(
                p.data_job
                    .join(format!("previous/wrong-extension-{index}.arbitrary"))
            )
            .unwrap(),
            **magic
        );
    }
}
#[test]
fn recovery_cleanup_refuses_pending_and_changed_backups() {
    let f = Fixture::new();
    let mut p = f.prepared();
    let pending = cleanup::preview_trusted(&f.install, &f.data, &f.trust).unwrap();
    assert_eq!(pending.files, 0);
    assert_eq!(pending.skipped.len(), 1);
    assert!(
        cleanup::delete_trusted(
            &f.install,
            &f.data,
            &pending.fingerprint,
            "DELETE",
            &f.trust
        )
        .is_err()
    );
    assert!(p.job.join("next/workpilot-sidecar.exe").is_file());
    install::transaction::steps(&mut p, |p| f.verify(p), |p, d| f.migrate(p, d), |_| Ok(()))
        .unwrap();
    let before = cleanup::preview_trusted(&f.install, &f.data, &f.trust).unwrap();
    fs::write(
        p.job.join("previous/original.txt"),
        b"changed after preview",
    )
    .unwrap();
    assert!(
        cleanup::delete_trusted(&f.install, &f.data, &before.fingerprint, "DELETE", &f.trust)
            .is_err()
    );
    assert!(p.data_job.join("previous/workpilot.sqlite3").is_file());
}
