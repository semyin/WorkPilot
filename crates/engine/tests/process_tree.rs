#[cfg(windows)]
fn alive(pid: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };
    // SAFETY: querying only process IDs returned by our synthetic fixture.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return false;
        }
        let mut code = 0;
        let ok = GetExitCodeProcess(process, &mut code);
        CloseHandle(process);
        ok != 0 && code == 259
    }
}

#[cfg(windows)]
#[test]
fn dropping_job_ends_parent_child_and_grandchild_within_two_seconds() {
    use std::{
        io::{BufRead, BufReader, Write},
        process::Command,
        time::{Duration, Instant},
    };
    let mut command = Command::new(env!("CARGO_BIN_EXE_workpilot-process-fixture"));
    let mut tree = workpilot_platform::process::ManagedEngine::spawn(&mut command).unwrap();
    let input = tree.child.stdin.as_mut().unwrap();
    writeln!(input, "go").unwrap();
    input.flush().unwrap();
    let output = tree.child.stdout.take().unwrap();
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        BufReader::new(output).read_line(&mut line).unwrap();
        let _ = sender.send(serde_json::from_str::<Vec<u32>>(&line).unwrap());
    });
    let pids = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(pids.len(), 3);
    assert!(pids.iter().all(|pid| alive(*pid)));
    let started = Instant::now();
    drop(tree);
    while pids.iter().any(|pid| alive(*pid)) && started.elapsed() < Duration::from_secs(2) {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        pids.iter().all(|pid| !alive(*pid)),
        "owned process tree survived cancellation"
    );
    println!(
        "three-process cancellation: {:.2} ms",
        started.elapsed().as_secs_f64() * 1000.0
    );
}
