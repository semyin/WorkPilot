#![cfg(windows)]
use std::{
    net::TcpListener,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use workpilot_platform::tool_process::{self, ProcessSpec};
fn spec(root: &std::path::Path, args: &[&str]) -> ProcessSpec {
    let cwd = root.join("project");
    std::fs::create_dir_all(&cwd).unwrap();
    ProcessSpec {
        program: PathBuf::from(env!("CARGO_BIN_EXE_workpilot-tool-fixture")),
        args: args.iter().map(|s| s.to_string()).collect(),
        cwd,
        sandboxed: true,
        timeout_ms: 10000,
        output_limit: 65536,
        ledger_dir: root.join("ledger"),
    }
}
fn gone(pid: u32) -> bool {
    use windows_sys::Win32::{Foundation::CloseHandle, System::Threading::*};
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return true;
        }
        let mut code = 0;
        let ok = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        ok == 0 || code != 259
    }
}
#[test]
fn appcontainer_denies_live_loopback_and_does_not_inherit_host_environment() {
    let temp = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let result = tool_process::run(
        spec(temp.path(), &["network", &address]),
        Arc::new(AtomicBool::new(false)),
    )
    .unwrap();
    assert_eq!(result.exit_code, 0, "{result:?}");
    assert!(result.stdout.contains("network_denied:"), "{result:?}");
    assert!(
        result.stdout.contains("username_present=false"),
        "{result:?}"
    );
    assert!(listener.accept().is_err());
    assert!(result.cleanup_errors.is_empty(), "{result:?}");
    let mut full = spec(temp.path(), &["network", &address]);
    full.sandboxed = false;
    let result = tool_process::run(full, Arc::new(AtomicBool::new(false))).unwrap();
    assert!(result.stdout.contains("network_connected"), "{result:?}");
    assert!(listener.accept().is_ok());
}
#[test]
fn cancelled_sandbox_kills_its_real_three_level_process_tree() {
    let temp = tempfile::tempdir().unwrap();
    let request = spec(temp.path(), &["tree", "0"]);
    let stop = Arc::new(AtomicBool::new(false));
    let signal = stop.clone();
    let worker = std::thread::spawn(move || tool_process::run(request, signal).unwrap());
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    while !temp.path().join("project/pid-2.txt").exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(30));
    }
    stop.store(true, Ordering::SeqCst);
    let result = worker.join().unwrap();
    let pids: Vec<u32> = result
        .stdout
        .lines()
        .filter_map(|s| s.strip_prefix("pid=")?.parse().ok())
        .collect();
    assert_eq!(pids.len(), 3, "{result:?}");
    assert_eq!(result.stopped.as_deref(), Some("cancelled"));
    assert!(pids.into_iter().all(gone), "{result:?}");
    assert!(result.cleanup_errors.is_empty(), "{result:?}");
}
#[test]
fn actual_timeout_and_output_limits_are_observable() {
    let temp = tempfile::tempdir().unwrap();
    let mut request = spec(temp.path(), &["hold"]);
    request.timeout_ms = 250;
    let result = tool_process::run(request, Arc::new(AtomicBool::new(false))).unwrap();
    assert_eq!(result.stopped.as_deref(), Some("timeout"));
    assert!(gone(result.pid));
    let mut request = spec(temp.path(), &["flood"]);
    request.output_limit = 1024;
    let result = tool_process::run(request, Arc::new(AtomicBool::new(false))).unwrap();
    assert_eq!(result.stopped.as_deref(), Some("output_limit"));
    assert!(result.stdout.len() <= 1024);
    assert!(gone(result.pid));
}

#[test]
fn abrupt_owner_death_kills_descendants_and_recovers_only_its_sandbox_ledger() {
    use std::os::windows::process::CommandExt;
    let temp = tempfile::tempdir().unwrap();
    std::fs::create_dir(temp.path().join("project")).unwrap();
    let mut owner = std::process::Command::new(env!("CARGO_BIN_EXE_workpilot-tool-fixture"));
    owner
        .arg("sandbox-host")
        .arg(temp.path())
        .creation_flags(0x0800_0000)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let mut owner = owner.spawn().unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    while !temp.path().join("project/pid-2.txt").exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(30));
    }
    owner.kill().unwrap();
    owner.wait().unwrap();
    let pids: Vec<u32> = (0..3)
        .map(|i| {
            std::fs::read_to_string(temp.path().join(format!("project/pid-{i}.txt")))
                .unwrap()
                .parse()
                .unwrap()
        })
        .collect();
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while !pids.iter().all(|&pid| gone(pid)) && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(pids.into_iter().all(gone));
    assert!(
        std::fs::read_dir(temp.path().join("ledger"))
            .unwrap()
            .count()
            > 0
    );
    assert!(
        tool_process::recover(&temp.path().join("ledger"))
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        std::fs::read_dir(temp.path().join("ledger"))
            .unwrap()
            .count(),
        0
    );
}
