//! Developer-only check of the office converter inside the existing process boundary.
use std::{
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
};
use workpilot_platform::tool_process::{self, ProcessInput, ProcessSpec};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let office = PathBuf::from(args.first().ok_or("missing office folder")?).canonicalize()?;
    let job = PathBuf::from(args.get(1).ok_or("missing fixture folder")?).canonicalize()?;
    let input = job.join("input.docx");
    if !input.is_file() {
        return Err("missing fixture input".into());
    }
    let profile =
        url::Url::from_directory_path(job.join("profile")).map_err(|_| "invalid profile")?;
    let (tx, rx) = std::sync::mpsc::channel();
    drop(tx);
    let result = tool_process::run_interactive(
        ProcessSpec {
            program: office.join(
                args.get(2)
                    .map(String::as_str)
                    .unwrap_or("program/soffice.com"),
            ),
            args: vec![
                format!("-env:UserInstallation={profile}"),
                "--headless".into(),
                "--nologo".into(),
                "--norestore".into(),
                "--convert-to".into(),
                "pdf".into(),
                "--outdir".into(),
                job.to_string_lossy().into_owned(),
                input.to_string_lossy().into_owned(),
            ],
            cwd: job.clone(),
            sandboxed: true,
            timeout_ms: 45000,
            output_limit: 1024 * 1024,
            ledger_dir: job.join("ledger"),
        },
        Arc::new(AtomicBool::new(false)),
        None,
        ProcessInput {
            messages: rx,
            read_roots: vec![office],
            environment: vec![],
        },
    )?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    if result.exit_code != 0 || result.stopped.is_some() || !job.join("input.pdf").is_file() {
        return Err("isolated office preview did not produce a PDF".into());
    }
    Ok(())
}
