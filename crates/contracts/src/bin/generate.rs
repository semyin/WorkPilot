fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/desktop/src/generated/contracts.ts");
    std::fs::create_dir_all(path.parent().unwrap())?;
    std::fs::write(path, workpilot_contracts::typescript())?;
    Ok(())
}
