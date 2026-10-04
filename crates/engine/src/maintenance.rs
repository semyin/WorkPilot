use std::io::{Read, Write};
pub fn run(path: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    let mut input = zeroize::Zeroizing::new(String::new());
    std::io::stdin()
        .take(64 * 1024 + 1)
        .read_to_string(&mut input)?;
    if input.len() > 64 * 1024 {
        return Err("maintenance request exceeds limit".into());
    }
    let request = serde_json::from_str::<workpilot_contracts::MaintenanceApply>(&input)
        .map_err(|_| "invalid maintenance request")?;
    let result = workpilot_workbench::maintenance::apply(path, request);
    let output = match result {
        Ok(value) => serde_json::json!({"ok":true,"result":value}),
        Err(error) => serde_json::json!({"ok":false,"error":error}),
    };
    let mut out = std::io::stdout().lock();
    serde_json::to_writer(&mut out, &output)?;
    out.flush()?;
    Ok(())
}
/// Called only by an explicitly selected uninstall cleanup option.
pub fn reset(path: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    use workpilot_contracts::{MaintenanceApply, MaintenanceSelection};
    let store = workpilot_storage::Store::open_exclusive(path)?;
    let fingerprint = store
        .maintenance_plan(&MaintenanceSelection::Reset)?
        .fingerprint;
    drop(store);
    let result = workpilot_workbench::maintenance::apply(
        path,
        MaintenanceApply {
            selection: MaintenanceSelection::Reset,
            fingerprint,
            confirmation: "RESET".into(),
            backup_path: None,
            backup_password: None,
        },
    );
    match result {
        Ok(value) => {
            serde_json::to_writer(std::io::stdout().lock(), &value)?;
            Ok(())
        }
        Err(e) => Err(e.into()),
    }
}
pub fn reset_default() -> Result<(), Box<dyn std::error::Error>> {
    use workpilot_platform::paths::{Channel, data_dir};
    let default = if cfg!(debug_assertions) || env!("CARGO_PKG_VERSION").contains('-') {
        "development"
    } else {
        "release"
    };
    let channel = match std::env::var("WORKPILOT_CHANNEL")
        .unwrap_or_else(|_| default.into())
        .as_str()
    {
        "development" => Channel::Development,
        "release" => Channel::Release,
        "test" => Channel::Test,
        _ => return Err("invalid channel".into()),
    };
    let root = std::env::var_os("WORKPILOT_DATA_DIR").map(std::path::PathBuf::from);
    reset(&data_dir(channel, root.as_deref())?)
}
