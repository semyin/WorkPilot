use super::*;
#[test]
fn reset_confirmation_and_project_location_are_enforced() {
    let dir = tempfile::tempdir().unwrap();
    let request = MaintenanceApply {
        selection: MaintenanceSelection::Reset,
        fingerprint: "none".into(),
        confirmation: "DELETE".into(),
        backup_path: None,
        backup_password: None,
    };
    assert!(apply(dir.path(), request).is_err());
    assert!(!dir.path().join("workpilot.sqlite3").exists());
    let data = dir.path().join("data");
    fs::create_dir_all(&data).unwrap();
    let project = data.join("project");
    fs::create_dir_all(&project).unwrap();
    fs::write(project.join("keep.txt"), "user file").unwrap();
    let mut store = Store::open_exclusive(&data).unwrap();
    store
        .save_project(&Project {
            id: "inside".into(),
            name: "Inside app data".into(),
            root_path: project.to_string_lossy().into_owned(),
            default_profile_id: None,
            permission: PermissionMode::RequestApproval,
            created_at_ms: 1,
        })
        .unwrap();
    let plan = store
        .maintenance_plan(&MaintenanceSelection::Reset)
        .unwrap();
    drop(store);
    let r = apply(
        &data,
        MaintenanceApply {
            selection: MaintenanceSelection::Reset,
            fingerprint: plan.fingerprint,
            confirmation: "RESET".into(),
            backup_path: None,
            backup_password: None,
        },
    );
    assert!(r.unwrap_err().contains("Move projects outside"));
    assert_eq!(
        fs::read_to_string(project.join("keep.txt")).unwrap(),
        "user file"
    );
    assert_eq!(
        Store::open_exclusive(&data)
            .unwrap()
            .maintenance_project_paths()
            .unwrap()
            .len(),
        1
    );
}
