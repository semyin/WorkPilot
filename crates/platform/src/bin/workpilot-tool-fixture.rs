//! Test-only executable. Never included in desktop bundles.
use std::{
    io::Write,
    net::{SocketAddr, TcpStream},
    process::{Command, Stdio},
    time::Duration,
};
fn main() {
    let args: Vec<_> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("sandbox-host") => {
            let root = std::path::PathBuf::from(&args[2]);
            let spec = workpilot_platform::tool_process::ProcessSpec {
                program: std::env::current_exe().unwrap(),
                args: vec!["tree".into(), "0".into()],
                cwd: root.join("project"),
                sandboxed: true,
                timeout_ms: 30000,
                output_limit: 65536,
                ledger_dir: root.join("ledger"),
            };
            workpilot_platform::tool_process::run(
                spec,
                std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            )
            .unwrap();
        }
        Some("network") => {
            let address: SocketAddr = args[2].parse().unwrap();
            match TcpStream::connect_timeout(&address, Duration::from_secs(2)) {
                Ok(_) => println!("network_connected"),
                Err(e) => println!("network_denied:{}", e.raw_os_error().unwrap_or_default()),
            }
            println!(
                "username_present={}",
                std::env::var_os("USERNAME").is_some()
            );
        }
        Some("tree") => {
            let depth: u32 = args[2].parse().unwrap();
            std::fs::write(format!("pid-{depth}.txt"), std::process::id().to_string()).unwrap();
            println!("pid={}", std::process::id());
            std::io::stdout().flush().unwrap();
            let _child = if depth < 2 {
                let mut command = Command::new(std::env::current_exe().unwrap());
                command
                    .args(["tree", &(depth + 1).to_string()])
                    .stdin(Stdio::null());
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    command.creation_flags(0x0800_0000);
                }
                Some(command.spawn().unwrap())
            } else {
                None
            };
            loop {
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        Some("flood") => {
            for _ in 0..100000 {
                println!("synthetic_output_abcdefghijklmnopqrstuvwxyz");
            }
        }
        Some("hold") => std::thread::sleep(Duration::from_secs(30)),
        _ => panic!("unknown synthetic fixture"),
    }
}
