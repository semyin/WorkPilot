//! Processes start suspended and enter their own kill-on-close job before running.
use std::{
    io,
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
};
#[cfg(windows)]
mod git_compat;
#[cfg(windows)]
mod windows;
#[derive(Clone)]
pub struct ProcessSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub sandboxed: bool,
    pub timeout_ms: u64,
    pub output_limit: usize,
    pub ledger_dir: PathBuf,
}
#[derive(Debug, serde::Serialize)]
pub struct ProcessResult {
    pub pid: u32,
    pub exit_code: u32,
    pub stdout: String,
    pub stderr: String,
    pub stopped: Option<String>,
    pub containment: String,
    pub elapsed_ms: u64,
    pub cleanup_errors: Vec<String>,
}
pub enum ProcessProgress {
    Started(u32),
    OwnedProcesses(Vec<u32>),
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
}
pub type ProcessObserver = Arc<dyn Fn(ProcessProgress) + Send + Sync>;
/// Trusted host setup for bounded bidirectional tools; never supplied directly by a model.
pub struct ProcessInput {
    pub messages: std::sync::mpsc::Receiver<Vec<u8>>,
    pub read_roots: Vec<PathBuf>,
    pub environment: Vec<(String, zeroize::Zeroizing<String>)>,
}
pub fn run_interactive(
    spec: ProcessSpec,
    stop: Arc<AtomicBool>,
    observer: Option<ProcessObserver>,
    input: ProcessInput,
) -> io::Result<ProcessResult> {
    validate(&spec)?;
    if input.read_roots.len() > 8
        || input.read_roots.iter().any(|p| !p.is_absolute())
        || input.environment.len() > 16
        || input.environment.iter().any(|(k, v)| {
            k.is_empty()
                || k.len() > 64
                || !k
                    .bytes()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
                || v.len() > 4096
                || v.contains('\0')
                || [
                    "PATH",
                    "HOME",
                    "USERPROFILE",
                    "SYSTEMROOT",
                    "WINDIR",
                    "COMSPEC",
                    "TEMP",
                    "TMP",
                    "APPDATA",
                    "LOCALAPPDATA",
                    "NODE_OPTIONS",
                    "NODE_PATH",
                    "PYTHONPATH",
                    "PYTHONHOME",
                    "LD_PRELOAD",
                    "LD_LIBRARY_PATH",
                    "WORKPILOT_GIT_DEVICE_MAP",
                ]
                .contains(&k.as_str())
        })
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid interactive tool boundary",
        ));
    }
    #[cfg(windows)]
    {
        windows::run(spec, stop, observer, Some(input))
    }
    #[cfg(not(windows))]
    {
        let _ = (spec, stop, observer, input);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "interactive process boundary is not verified on this platform",
        ))
    }
}
pub fn run(spec: ProcessSpec, stop: Arc<AtomicBool>) -> io::Result<ProcessResult> {
    run_observed(spec, stop, None)
}
pub fn run_observed(
    spec: ProcessSpec,
    stop: Arc<AtomicBool>,
    observer: Option<ProcessObserver>,
) -> io::Result<ProcessResult> {
    validate(&spec)?;
    #[cfg(windows)]
    {
        windows::run(spec, stop, observer, None)
    }
    #[cfg(not(windows))]
    {
        let _ = (spec, stop, observer);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "process boundary is not verified on this platform",
        ))
    }
}
fn validate(spec: &ProcessSpec) -> io::Result<()> {
    if !spec.program.is_absolute()
        || !spec.cwd.is_absolute()
        || spec.args.iter().any(|a| a.contains('\0'))
        || spec.timeout_ms == 0
        || spec.timeout_ms > 86_400_000
        || spec.output_limit == 0
        || spec.output_limit > 8 * 1024 * 1024
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid process boundary",
        ));
    }
    Ok(())
}
pub fn recover(ledger_dir: &std::path::Path) -> io::Result<Vec<String>> {
    #[cfg(windows)]
    {
        windows::recover(ledger_dir)
    }
    #[cfg(not(windows))]
    {
        let _ = ledger_dir;
        Ok(vec![])
    }
}
#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;
    fn spec(root: &std::path::Path, args: Vec<String>, sandboxed: bool) -> ProcessSpec {
        let cwd = root.join("project");
        std::fs::create_dir_all(&cwd).unwrap();
        ProcessSpec {
            program: PathBuf::from(std::env::var("SystemRoot").unwrap()).join("System32/cmd.exe"),
            args,
            cwd,
            sandboxed,
            timeout_ms: 10000,
            output_limit: 1024 * 1024,
            ledger_dir: root.join("ledger"),
        }
    }
    #[test]
    fn appcontainer_writes_authorized_project_but_cannot_read_private_sibling() {
        let temp = tempfile::tempdir().unwrap();
        let outside = temp.path().join("private.txt");
        std::fs::write(&outside, "private-value").unwrap();
        let spec = spec(
            temp.path(),
            vec![
                "/d".into(),
                "/c".into(),
                "echo authorized>inside.txt & type ..\\private.txt".into(),
            ],
            true,
        );
        let result = run(spec, Arc::new(AtomicBool::new(false))).unwrap();
        assert!(
            temp.path().join("project/inside.txt").exists(),
            "{result:?}"
        );
        assert!(!result.stdout.contains("private-value"), "{result:?}");
        assert_ne!(result.exit_code, 0, "{result:?}");
        assert!(result.cleanup_errors.is_empty(), "{result:?}");
        assert!(recover(&temp.path().join("ledger")).unwrap().is_empty());
    }
    #[test]
    fn process_cancellation_output_limit_and_nonzero_exit_are_truthful() {
        let temp = tempfile::tempdir().unwrap();
        let failed = run(
            spec(
                temp.path(),
                vec!["/d".into(), "/c".into(), "exit /b 7".into()],
                false,
            ),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        assert_eq!(failed.exit_code, 7, "{failed:?}");
        let stop = Arc::new(AtomicBool::new(false));
        let signal = stop.clone();
        let request = spec(
            temp.path(),
            vec![
                "/d".into(),
                "/c".into(),
                "for /l %i in (1,0,2) do @echo running".into(),
            ],
            false,
        );
        let worker = std::thread::spawn(move || run(request, signal).unwrap());
        std::thread::sleep(std::time::Duration::from_millis(100));
        stop.store(true, Ordering::SeqCst);
        let result = worker.join().unwrap();
        assert!(result.stopped.is_some());
        assert!(result.elapsed_ms < 2000, "{result:?}");
    }
    #[test]
    fn cancellation_finishes_while_an_unrelated_managed_process_stays_alive() {
        use std::{process::Command, sync::Mutex, time::Duration};
        let temp = tempfile::tempdir().unwrap();
        let unrelated = Arc::new(Mutex::new(None::<crate::process::ManagedEngine>));
        let observed = unrelated.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let signal = stop.clone();
        let observer = Arc::new(move |progress| {
            if let ProcessProgress::Started(_) = progress {
                let program = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
                    .join("System32/WindowsPowerShell/v1.0/powershell.exe");
                let mut command = Command::new(program);
                command.args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "Start-Sleep -Seconds 30",
                ]);
                *observed.lock().unwrap() =
                    Some(crate::process::ManagedEngine::spawn(&mut command).unwrap());
                signal.store(true, Ordering::SeqCst);
            }
        });
        let request = spec(
            temp.path(),
            vec!["/d".into(), "/c".into(), "echo done".into()],
            false,
        );
        let (send, recv) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            send.send(run_observed(request, stop, Some(observer)))
                .unwrap();
        });
        // Always clean up our unrelated process, including on a regression.
        let result = recv.recv_timeout(Duration::from_secs(2));
        let mut unrelated = unrelated.lock().unwrap();
        let child = unrelated
            .as_mut()
            .expect("observer launched the separate process");
        let still_running = child.child.try_wait().unwrap().is_none();
        child.terminate().unwrap();
        worker.join().unwrap();
        assert!(
            still_running,
            "cancelling one tool must not stop the unrelated process"
        );
        let result = result
            .expect("tool output pipes must close without waiting for unrelated children")
            .unwrap();
        assert_eq!(result.stopped.as_deref(), Some("cancelled"));
        assert!(result.elapsed_ms < 2000, "{result:?}");
    }
}
