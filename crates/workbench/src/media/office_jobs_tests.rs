use super::*;

#[test]
fn live_jobs_are_kept_stale_jobs_removed_and_other_files_preserved() {
    let data = tempfile::tempdir().unwrap();
    let temporary = tempfile::tempdir().unwrap();
    let first = Job::in_temp(data.path(), temporary.path()).unwrap();
    let path = first.path().to_owned();
    let root = path.parent().unwrap();
    fs::write(path.join("input.docx"), b"synthetic private input").unwrap();
    fs::write(root.join("unrelated.txt"), b"keep me").unwrap();
    let second = Job::in_temp(data.path(), temporary.path()).unwrap();
    assert!(path.join("input.docx").exists());
    second.close().unwrap();
    // Simulate host crash: release the OS handle while leaving its owned files.
    let Job {
        directory,
        lease_path,
        lease,
    } = &first;
    let saved_path = directory.clone();
    let saved_lease = lease_path.clone();
    assert!(lease.is_some());
    let mut first = first;
    first.lease.take();
    drop(first);
    assert!(saved_lease.is_file());
    let third = Job::in_temp(data.path(), temporary.path()).unwrap();
    assert!(!saved_path.exists());
    assert!(!saved_lease.exists());
    assert_eq!(fs::read(root.join("unrelated.txt")).unwrap(), b"keep me");
    let current = third.path().to_owned();
    third.close().unwrap();
    assert!(!current.exists());
}

#[test]
fn separate_data_roots_do_not_clean_each_others_jobs() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let temporary = tempfile::tempdir().unwrap();
    let mut first = Job::in_temp(a.path(), temporary.path()).unwrap();
    let path = first.path().to_owned();
    first.lease.take();
    let second = Job::in_temp(b.path(), temporary.path()).unwrap();
    assert!(path.exists());
    assert_ne!(path.parent(), second.path().parent());
    Job::in_temp(a.path(), temporary.path())
        .unwrap()
        .close()
        .unwrap();
    assert!(!path.exists());
}

#[test]
fn too_long_staging_path_is_rejected_before_writing_plaintext() {
    let data = tempfile::tempdir().unwrap();
    let temporary = tempfile::tempdir().unwrap();
    let long = temporary.path().join("x".repeat(100));
    fs::create_dir(&long).unwrap();
    assert!(Job::in_temp(data.path(), &long).is_err());
    assert_eq!(fs::read_dir(long).unwrap().count(), 0);
}

#[cfg(windows)]
#[test]
fn redirected_staging_entry_is_not_followed_during_recovery() {
    use std::os::windows::process::CommandExt;
    let data = tempfile::tempdir().unwrap();
    let temporary = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("keep.txt"), b"outside").unwrap();
    let mut job = Job::in_temp(data.path(), temporary.path()).unwrap();
    let directory = job.path().to_owned();
    fs::remove_dir(&directory).unwrap();
    // Directory junctions exercise reparse-point handling without requiring
    // Windows developer mode or administrator-only symlink privileges.
    let output = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command",
            "New-Item -ItemType Junction -Path $env:WP_TEST_LINK -Target $env:WP_TEST_TARGET -ErrorAction Stop | Out-Null"])
        .env("WP_TEST_LINK", &directory)
        .env("WP_TEST_TARGET", outside.path())
        .creation_flags(0x08000000)
        .output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    job.lease.take();
    let next = Job::in_temp(data.path(), temporary.path()).unwrap();
    assert!(!regular(&directory, true));
    assert_eq!(
        fs::read(outside.path().join("keep.txt")).unwrap(),
        b"outside"
    );
    next.close().unwrap();
    fs::remove_dir(directory).unwrap();
}
