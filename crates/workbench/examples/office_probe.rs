//! Developer-only check of the bundled renderer under the production process boundary.
use std::{
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
};
use workpilot_platform::tool_process::{self, ProcessInput, ProcessSpec};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let runtime = PathBuf::from(args.first().ok_or("missing runtime wrapper")?).canonicalize()?;
    let job = PathBuf::from(args.get(1).ok_or("missing fixture directory")?).canonicalize()?;
    let format = args.get(2).map(String::as_str).unwrap_or("docx");
    if !matches!(format, "docx" | "xlsx" | "pptx")
        || !job.join(format!("input.{format}")).is_file()
        || job.join("preview.pdf").exists()
    {
        return Err("use a fresh fixture directory with one supported input".into());
    }
    let (tx, rx) = std::sync::mpsc::channel();
    drop(tx);
    let cancel = args.get(3).is_some_and(|s| s == "--cancel");
    let stop = Arc::new(AtomicBool::new(false));
    let observer_stop = stop.clone();
    let result = tool_process::run_interactive(
        ProcessSpec {
            program: runtime.join("office/program/workpilot-office.exe"),
            args: vec![],
            cwd: job.clone(),
            sandboxed: true,
            timeout_ms: 45000,
            output_limit: 128 * 1024,
            ledger_dir: job.join("ledger"),
        },
        stop,
        Some(Arc::new(move |event| match event {
            tool_process::ProcessProgress::Started(pid) => {
                eprintln!("started={pid}");
                if cancel {
                    let stop = observer_stop.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(500));
                        stop.store(true, std::sync::atomic::Ordering::SeqCst);
                    });
                }
            }
            tool_process::ProcessProgress::Stdout(bytes)
            | tool_process::ProcessProgress::Stderr(bytes) => {
                use std::io::Write;
                let _ = std::io::stderr().write_all(&bytes);
            }
            tool_process::ProcessProgress::OwnedProcesses(_) => {}
        })),
        ProcessInput {
            messages: rx,
            read_roots: vec![runtime],
            environment: vec![
                ("SAL_DISABLESKIA".into(), "1".to_string().into()),
                ("SAL_DISABLE_OPENCL".into(), "1".to_string().into()),
            ],
        },
    )?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    if !result.cleanup_errors.is_empty() || result.containment != "windows_appcontainer_no_network"
    {
        return Err("Office process isolation/cleanup failed".into());
    }
    if cancel {
        if result.stopped.is_none() || job.join("preview.pdf").exists() {
            return Err("Office cancellation failed".into());
        }
    } else if result.exit_code != 0
        || result.stopped.is_some()
        || !job.join("preview.pdf").is_file()
    {
        return Err("Office preview did not produce PDF".into());
    }
    Ok(())
}
