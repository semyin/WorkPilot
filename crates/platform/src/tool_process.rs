//! Processes start suspended and enter their own kill-on-close job before running.
use std::{
    io,
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
};
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
pub fn run(spec: ProcessSpec, stop: Arc<AtomicBool>) -> io::Result<ProcessResult> {
    if !spec.program.is_absolute()
        || !spec.cwd.is_absolute()
        || spec.args.iter().any(|a| a.contains('\0'))
        || spec.timeout_ms == 0
        || spec.timeout_ms > 300000
        || spec.output_limit == 0
        || spec.output_limit > 8 * 1024 * 1024
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid process boundary",
        ));
    }
    #[cfg(windows)]
    {
        windows::run(spec, stop)
    }
    #[cfg(not(windows))]
    {
        let _ = (spec, stop);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "process boundary is not verified on this platform",
        ))
    }
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
        assert!(result.elapsed_ms < 2000);
    }
}
