use super::*;
use std::path::PathBuf;

struct Fixture {
    directory: tempfile::TempDir,
    prefix: String,
}
impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let f = Self {
            directory,
            prefix: format!(r"Software\WorkPilot\SetupTests\{}", uuid::Uuid::new_v4()),
        };
        let base = f.root().join("browser-companion/extension");
        fs::create_dir_all(&base).unwrap();
        fs::write(
            f.root().join("browser-companion/companion.exe"),
            b"test-only placeholder",
        )
        .unwrap();
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../extensions/companion");
        for entry in fs::read_dir(source).unwrap() {
            let entry = entry.unwrap();
            fs::copy(entry.path(), base.join(entry.file_name())).unwrap();
        }
        f
    }
    fn root(&self) -> PathBuf {
        self.directory.path().to_path_buf()
    }
    fn action(&self, action: BrowserSetupAction) -> io::Result<BrowserSetupReport> {
        perform_at(&self.root(), &action, &self.prefix)
    }
    fn slot(&self, browser: SetupBrowser) -> Slot {
        slots(&self.prefix, vendor(browser)).remove(0)
    }
    fn expected(&self) -> String {
        self.root()
            .join("browser-companion")
            .join(MANIFEST)
            .to_string_lossy()
            .into_owned()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // Only this fixture's generated namespace; never browser/global registry keys.
        assert!(self.prefix.starts_with(r"Software\WorkPilot\SetupTests\"));
        assert!(uuid::Uuid::parse_str(self.prefix.rsplit('\\').next().unwrap()).is_ok());
        unsafe {
            RegDeleteTreeW(HKEY_CURRENT_USER, wide(&self.prefix).as_ptr());
        }
    }
}

#[test]
fn legacy_packaged_manifest_with_native_windows_paths_is_recognized() {
    let f = Fixture::new();
    let manifest = serde_json::json!({
        "name": "com.workpilot.browser_companion",
        "description": "WorkPilot task browser connection",
        "path": f.root().join("browser-companion").join("companion.exe"),
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{}/", EXTENSION_ID.trim())]
    });
    fs::write(
        f.root().join("browser-companion").join(MANIFEST),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    f.slot(SetupBrowser::Chrome)
        .register(&f.expected())
        .unwrap();
    let report = f.action(BrowserSetupAction::Inspect).unwrap();
    assert_eq!(report.browsers[0].state, "ready");
    assert_eq!(
        report.extension_directory.unwrap(),
        f.root()
            .join("browser-companion")
            .join("extension")
            .to_string_lossy()
    );
}

#[test]
fn current_user_registration_is_idempotent_and_separate_per_browser() {
    let f = Fixture::new();
    assert!(
        f.action(BrowserSetupAction::Inspect)
            .unwrap()
            .browsers
            .iter()
            .all(|b| b.state == "missing")
    );
    for browser in [SetupBrowser::Chrome, SetupBrowser::Edge] {
        for _ in 0..2 {
            f.action(BrowserSetupAction::Register { browser }).unwrap();
        }
        for slot in slots(&f.prefix, vendor(browser))
            .into_iter()
            .filter(|s| s.hive == HKEY_CURRENT_USER)
        {
            assert!(owns(&slot.read().unwrap(), &f.expected()));
        }
    }
    let r = f
        .action(BrowserSetupAction::Unregister {
            browser: SetupBrowser::Chrome,
        })
        .unwrap();
    assert_eq!(r.browsers[0].state, "missing");
    assert_eq!(r.browsers[1].state, "ready");
    assert!(manifest_ready(&f.root()));
}

#[test]
fn foreign_registration_after_inspection_is_preserved_even_when_unregistering() {
    let f = Fixture::new();
    assert!(f.action(BrowserSetupAction::Inspect).unwrap().browsers[0].can_register);
    f.slot(SetupBrowser::Chrome)
        .register(r"C:\Other copy\bridge.json")
        .unwrap();
    assert!(
        f.action(BrowserSetupAction::Register {
            browser: SetupBrowser::Chrome
        })
        .is_err()
    );
    let r = f
        .action(BrowserSetupAction::Unregister {
            browser: SetupBrowser::Chrome,
        })
        .unwrap();
    assert_eq!(r.browsers[0].state, "conflict");
    assert_eq!(
        f.slot(SetupBrowser::Chrome).read().unwrap(),
        Value::Text(r"C:\Other copy\bridge.json".into())
    );
    assert!(!f.root().join("browser-companion").join(MANIFEST).exists());
}

#[test]
fn invalid_default_and_extra_values_are_not_deleted_or_overwritten() {
    let f = Fixture::new();
    let browser = SetupBrowser::Chrome;
    f.action(BrowserSetupAction::Register { browser }).unwrap();
    let key = f.slot(browser).open(KEY_ALL_ACCESS).unwrap().unwrap();
    let data = wide("keep me");
    assert_eq!(
        unsafe {
            RegSetValueExW(
                key.0,
                wide("unrelated").as_ptr(),
                0,
                REG_SZ,
                data.as_ptr().cast(),
                (data.len() * 2) as u32,
            )
        },
        0
    );
    f.action(BrowserSetupAction::Unregister { browser })
        .unwrap();
    assert!(f.slot(browser).open(KEY_READ).unwrap().is_some());
    let mut size = 0;
    assert_eq!(
        unsafe {
            RegQueryValueExW(
                key.0,
                wide("unrelated").as_ptr(),
                ptr::null(),
                ptr::null_mut(),
                ptr::null_mut(),
                &mut size,
            )
        },
        0
    );
    assert!(size > 0);
    let invalid: u32 = 123;
    assert_eq!(
        unsafe {
            RegSetValueExW(
                key.0,
                ptr::null(),
                0,
                REG_DWORD,
                (&invalid as *const u32).cast(),
                4,
            )
        },
        0
    );
    assert!(f.action(BrowserSetupAction::Register { browser }).is_err());
    f.action(BrowserSetupAction::Unregister { browser })
        .unwrap();
    assert_eq!(f.slot(browser).read().unwrap(), Value::Invalid);
}

#[test]
fn missing_or_changed_assets_and_changed_manifest_fail_before_registration() {
    let f = Fixture::new();
    let action = BrowserSetupAction::Register {
        browser: SetupBrowser::Chrome,
    };
    let popup = f.root().join("browser-companion/extension/popup.js");
    let original = fs::read(&popup).unwrap();
    fs::write(&popup, b"changed").unwrap();
    assert!(f.action(action.clone()).is_err());
    assert_eq!(f.slot(SetupBrowser::Chrome).read().unwrap(), Value::Missing);
    fs::write(&popup, original).unwrap();
    let path = f.root().join("browser-companion").join(MANIFEST);
    fs::write(&path, br#"{"name":"some.other.app"}"#).unwrap();
    assert!(f.action(action.clone()).is_err());
    assert_eq!(fs::read(&path).unwrap(), br#"{"name":"some.other.app"}"#);
    fs::remove_file(&path).unwrap();
    f.action(action).unwrap();
    fs::remove_file(f.root().join("browser-companion/companion.exe")).unwrap();
    let report = f
        .action(BrowserSetupAction::Unregister {
            browser: SetupBrowser::Chrome,
        })
        .unwrap();
    assert_eq!(report.browsers[0].state, "unavailable");
    assert!(!report.browsers[0].can_unregister);
}

#[test]
fn edge_fallback_is_reported_but_explicit_edge_setup_does_not_modify_chrome() {
    let f = Fixture::new();
    let foreign = r"C:\Another WorkPilot\bridge.json";
    f.slot(SetupBrowser::Chrome).register(foreign).unwrap();
    let r = f.action(BrowserSetupAction::Inspect).unwrap();
    assert!(r.browsers[1].fallback_detected && r.browsers[1].can_register);
    let r = f
        .action(BrowserSetupAction::Register {
            browser: SetupBrowser::Edge,
        })
        .unwrap();
    assert_eq!(r.browsers[1].state, "ready");
    assert_eq!(
        f.slot(SetupBrowser::Chrome).read().unwrap(),
        Value::Text(foreign.into())
    );
    let r = f
        .action(BrowserSetupAction::Unregister {
            browser: SetupBrowser::Edge,
        })
        .unwrap();
    assert!(r.browsers[1].fallback_detected);
}
