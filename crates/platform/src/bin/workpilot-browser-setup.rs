use workpilot_contracts::{BrowserSetupAction, SetupBrowser};
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let browser = match args.get(1).map(String::as_str) {
        Some("chrome") => Some(SetupBrowser::Chrome),
        Some("edge") => Some(SetupBrowser::Edge),
        _ => None,
    };
    let action = match (args.first().map(String::as_str), browser, args.len()) {
        (Some("inspect"), None, 1) => BrowserSetupAction::Inspect,
        (Some("register"), Some(browser), 2) => BrowserSetupAction::Register { browser },
        (Some("unregister"), Some(browser), 2) => BrowserSetupAction::Unregister { browser },
        _ => {
            eprintln!("Use inspect, register chrome|edge, or unregister chrome|edge");
            std::process::exit(2);
        }
    };
    match workpilot_platform::browser_setup::perform(&action) {
        Ok(report) => println!("{}", serde_json::to_string(&report).unwrap()),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}
