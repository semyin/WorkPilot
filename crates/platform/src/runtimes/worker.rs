//! File opens can stall inside OS filters. Own the scanner separately so that
//! cancellation and time limits do not depend on a blocked I/O thread returning.
use super::*;
use crate::process::ManagedEngine;
use serde::{Deserialize, Serialize};
use std::{
    io::{BufRead, BufReader, Read, Write},
    process::Command,
    sync::mpsc::{self, RecvTimeoutError},
    thread,
    time::{Duration, Instant},
};

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Message {
    Progress {
        #[serde(default)]
        path: Option<String>,
    },
    Complete {
        report: InstallationReport,
    },
    Failed,
}
#[derive(Clone, Copy)]
struct Limits {
    idle: Duration,
    total: Duration,
    line: usize,
}
const LIMITS: Limits = Limits {
    idle: Duration::from_secs(30),
    total: Duration::from_secs(100),
    line: 2 * 1024 * 1024,
};
fn stopped() -> io::Error {
    io::Error::new(
        io::ErrorKind::Interrupted,
        "环境检查已取消 / Installation check cancelled",
    )
}
fn timed_out(path: Option<&str>) -> io::Error {
    io::Error::new(
        io::ErrorKind::TimedOut,
        format!(
            "环境文件读取长时间未完成，已停止本次检查；尚未确认文件完整，可稍后重试 / Runtime inspection timed out and was stopped; integrity is unconfirmed{}",
            path.map(|path| format!("; last component file: {path}"))
                .unwrap_or_default()
        ),
    )
}
fn failed() -> io::Error {
    io::Error::other(
        "无法完成环境检查，请检查随包清单和读取权限 / Installation check failed; check the inventory and read access",
    )
}
fn command(program: &Path) -> Command {
    let mut command = Command::new(program);
    // No user configuration, model keys or task environment is needed here.
    command.env_clear();
    for name in ["SystemRoot", "WINDIR", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command
}
pub(super) fn inspect(verify: bool, stop: Arc<AtomicBool>) -> Result<InstallationReport> {
    if stop.load(Ordering::Relaxed) {
        return Err(stopped());
    }
    let base = app_root()?;
    if !base.join(MANIFEST).is_file() {
        return inspect_with_progress(&base, verify, stop, |_, _| Ok(()));
    }
    let name = if cfg!(windows) {
        "workpilot-runtime-check.exe"
    } else {
        "workpilot-runtime-check"
    };
    let program = checked_file(&base, name).map_err(|_| {
        io::Error::other("随包环境检查程序缺失或路径异常，请修复安装 / Runtime checker is missing or invalid; repair installation")
    })?;
    let mut command = command(&program);
    command
        .current_dir(&base)
        .arg(if verify { "verify" } else { "quick" });
    let mut owned = ManagedEngine::spawn(&mut command)?;
    supervise(&mut owned, stop, LIMITS)
}

fn supervise(
    owned: &mut ManagedEngine,
    stop: Arc<AtomicBool>,
    limits: Limits,
) -> Result<InstallationReport> {
    drop(owned.child.stdin.take());
    let stdout = owned.child.stdout.take().ok_or_else(failed)?;
    // Both the queue and each line are bounded, including malformed output.
    let (sender, receiver) = mpsc::sync_channel(8);
    let reader = thread::spawn(move || {
        let mut input = BufReader::new(stdout);
        loop {
            let mut line = Vec::new();
            let read = input
                .by_ref()
                .take((limits.line + 1) as u64)
                .read_until(b'\n', &mut line);
            let message = match read {
                Ok(0) => break,
                Ok(_) if line.len() <= limits.line && line.ends_with(b"\n") => {
                    serde_json::from_slice::<Message>(&line).map_err(|_| failed())
                }
                _ => Err(failed()),
            };
            let bad = message.is_err();
            if sender.send(message).is_err() || bad {
                break;
            }
        }
    });
    let start = Instant::now();
    let mut progress = start;
    let mut last_path = None;
    let result = (|| loop {
        if stop.load(Ordering::Relaxed) {
            return Err(stopped());
        }
        if start.elapsed() >= limits.total || progress.elapsed() >= limits.idle {
            return Err(timed_out(last_path.as_deref()));
        }
        match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(Ok(Message::Progress { path })) => {
                if path
                    .as_ref()
                    .is_some_and(|value| value.len() > 4096 || !valid_relative(value))
                {
                    return Err(failed());
                }
                progress = Instant::now();
                last_path = path;
            }
            Ok(Ok(Message::Complete { report })) => return Ok(report),
            Ok(Ok(Message::Failed)) | Ok(Err(_)) | Err(RecvTimeoutError::Disconnected) => {
                return Err(failed());
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
    })();
    // Drop the receiver first so a full queue cannot prevent reader shutdown.
    drop(receiver);
    let terminated = owned.terminate();
    let _ = reader.join();
    terminated?;
    result
}

/// Entry point for the fixed, app-owned executable. No caller-supplied path and
/// no test/fault-injection modes are accepted by the distributed worker.
pub fn worker_main() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let verify = match args.as_slice() {
        [mode] if mode == "verify" => true,
        [mode] if mode == "quick" => false,
        _ => return Err(io::Error::other("Use quick or verify")),
    };
    let mut output = io::stdout().lock();
    let mut last = None;
    let report = inspect_with_progress(
        &app_root()?,
        verify,
        Arc::new(AtomicBool::new(false)),
        |path, before_open| {
            if before_open
                || last.is_none_or(|at: Instant| at.elapsed() >= Duration::from_millis(250))
            {
                serde_json::to_writer(
                    &mut output,
                    &Message::Progress {
                        path: path.map(str::to_owned),
                    },
                )?;
                output.write_all(b"\n")?;
                output.flush()?;
                last = Some(Instant::now());
            }
            Ok(())
        },
    );
    let message = match report {
        Ok(report) => Message::Complete { report },
        Err(_) => Message::Failed,
    };
    serde_json::to_writer(&mut output, &message)?;
    output.write_all(b"\n")?;
    output.flush()
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    fn fixture(script: &str) -> ManagedEngine {
        let path = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let mut cmd = command(&path);
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
        ManagedEngine::spawn(&mut cmd).unwrap()
    }
    fn limits() -> Limits {
        Limits {
            idle: Duration::from_secs(2),
            total: Duration::from_secs(5),
            line: 4096,
        }
    }
    #[test]
    fn cancellation_stops_an_unresponsive_owned_process() {
        let mut child = fixture("Start-Sleep -Seconds 30");
        let stop = Arc::new(AtomicBool::new(false));
        let signal = stop.clone();
        let cancel = thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            signal.store(true, Ordering::Relaxed);
        });
        let start = Instant::now();
        assert_eq!(
            supervise(&mut child, stop, limits()).unwrap_err().kind(),
            io::ErrorKind::Interrupted
        );
        cancel.join().unwrap();
        assert!(start.elapsed() < Duration::from_secs(3));
        assert!(child.child.try_wait().unwrap().is_some());
    }
    #[test]
    fn idle_and_total_limits_stop_owned_processes_and_next_check_can_finish() {
        for (script, bound) in [
            ("Start-Sleep -Seconds 30", limits()),
            (
                "while ($true) { Write-Output '{\"kind\":\"progress\"}'; Start-Sleep -Milliseconds 100 }",
                Limits {
                    total: Duration::from_secs(3),
                    ..limits()
                },
            ),
        ] {
            let mut child = fixture(script);
            let start = Instant::now();
            assert_eq!(
                supervise(&mut child, Arc::new(AtomicBool::new(false)), bound)
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::TimedOut
            );
            assert!(start.elapsed() < Duration::from_secs(5));
            assert!(child.child.try_wait().unwrap().is_some());
        }
        let dir = tempfile::tempdir().unwrap();
        let mut expected =
            super::super::inspect_at(dir.path(), false, Arc::new(AtomicBool::new(false))).unwrap();
        expected.notices.clear();
        let message = serde_json::to_string(&Message::Complete { report: expected }).unwrap();
        let mut child = fixture(&format!(
            "Write-Output '{}'; Start-Sleep -Seconds 30",
            message.replace('\'', "''")
        ));
        let report = supervise(&mut child, Arc::new(AtomicBool::new(false)), limits()).unwrap();
        assert!(!report.manifest_present);
        assert!(child.child.try_wait().unwrap().is_some());
    }
    #[test]
    fn malformed_oversized_and_incomplete_outputs_never_become_successful_reports() {
        for script in [
            "Write-Output 'invalid'; Start-Sleep -Seconds 30",
            "Write-Output ('x' * 8192); Start-Sleep -Seconds 30",
            "Write-Output '{\"kind\":\"progress\"}'",
            "Write-Output '{\"kind\":\"progress\",\"path\":\"../private-file\"}'; Start-Sleep -Seconds 30",
        ] {
            let mut child = fixture(script);
            assert!(supervise(&mut child, Arc::new(AtomicBool::new(false)), limits()).is_err());
            assert!(child.child.try_wait().unwrap().is_some());
        }
    }
    #[test]
    fn stalled_reads_keep_only_the_last_relative_installation_path() {
        let mut child = fixture(
            "Write-Output '{\"kind\":\"progress\",\"path\":\"office-runtime/component.bin\"}'; Start-Sleep -Seconds 30",
        );
        let error = supervise(&mut child, Arc::new(AtomicBool::new(false)), limits()).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(error.to_string().contains("office-runtime/component.bin"));
        assert!(child.child.try_wait().unwrap().is_some());
    }
}
