//! Synthetic process tree used only by P00 lifecycle tests. Never bundled.
use std::{
    io::{self, BufRead, BufReader, Write},
    process::{Command, Stdio},
    time::Duration,
};
fn main() {
    let depth = std::env::args()
        .nth(1)
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);
    if depth == 0 {
        let mut go = String::new();
        io::stdin().read_line(&mut go).unwrap();
        if go.trim() != "go" {
            return;
        }
    }
    let mut pids = vec![std::process::id()];
    let _child = if depth < 2 {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .arg((depth + 1).to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let mut child = command.spawn().unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        pids.extend(serde_json::from_str::<Vec<u32>>(&line).unwrap());
        Some(child)
    } else {
        None
    };
    println!("{}", serde_json::to_string(&pids).unwrap());
    io::stdout().flush().unwrap();
    loop {
        std::thread::sleep(Duration::from_secs(60));
    }
}
