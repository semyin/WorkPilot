//! Fixed file-to-PDF worker. The host must start it inside the platform sandbox.
//! Uses LibreOfficeKit initialization and the public UNO main-thread callback.
//! Vendor binaries are not modified. All outputs are flushed before shutdown.
#[cfg(windows)]
mod windows;
fn main() {
    #[cfg(windows)]
    let result = windows::convert();
    #[cfg(not(windows))]
    let result: Result<(), String> = Err("Office preview is not verified on this platform".into());
    let report = match result {
        Ok(()) => {
            serde_json::json!({"ok":true,"renderer":"LibreOfficeKit 26.8.0","conversion":true})
        }
        Err(ref e) => {
            serde_json::json!({"ok":false,"error":e.chars().take(1600).collect::<String>()})
        }
    };
    let written = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open("report.json")
        .and_then(|mut f| {
            use std::io::Write;
            f.write_all(report.to_string().as_bytes())?;
            f.sync_all()
        });
    let code = u32::from(result.is_err() || written.is_err());
    #[cfg(windows)]
    windows::finish(code);
    #[cfg(not(windows))]
    std::process::exit(code as i32);
}
