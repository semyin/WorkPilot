//! Owned installation scanner; no database, task or model access.
fn main() {
    if workpilot_platform::runtimes::worker_main().is_err() {
        std::process::exit(1);
    }
}
