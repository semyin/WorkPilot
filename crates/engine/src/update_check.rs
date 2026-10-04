//! Offline upgrade probe. Deliberately does not construct runtime, model clients or schedules.
use std::path::Path;
pub fn run(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let _store = workpilot_storage::Store::open_exclusive(path)?;
    println!(
        "{}",
        serde_json::json!({"state":"compatible","schema":workpilot_contracts::SCHEMA_VERSION,
        "version":env!("CARGO_PKG_VERSION"),"tasks_started":0})
    );
    Ok(())
}
