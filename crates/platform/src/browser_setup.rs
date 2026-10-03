//! User-initiated native-host setup. This does not install an extension or authorize tabs.
use std::{fs, io, path::Path};
use workpilot_contracts::{BrowserSetupAction, BrowserSetupReport};

pub const HOST: &str = "com.workpilot.browser_companion";
pub const EXTENSION_ID: &str = include_str!("../../../extensions/companion/extension-id.txt");
#[cfg(windows)]
const MANIFEST: &str = "com.workpilot.browser_companion.json";

#[cfg(windows)]
mod windows;

pub fn perform(action: &BrowserSetupAction) -> io::Result<BrowserSetupReport> {
    #[cfg(windows)]
    {
        windows::perform_at(&crate::runtimes::app_root()?, action, "Software")
    }
    #[cfg(not(windows))]
    {
        use workpilot_contracts::{BrowserRegistration, SetupBrowser};
        if !matches!(action, BrowserSetupAction::Inspect) {
            return Err(io::Error::other(
                "此系统的浏览器安装接入尚未实现 / Browser setup on this platform is not implemented",
            ));
        }
        Ok(BrowserSetupReport {
            supported: false,
            assets_ready: false,
            extension_directory: None,
            extension_id: EXTENSION_ID.trim().into(),
            browsers: [SetupBrowser::Chrome, SetupBrowser::Edge]
                .into_iter()
                .map(|browser| BrowserRegistration {
                    browser,
                    state: "unsupported".into(),
                    can_register: false,
                    can_unregister: false,
                    other_location: None,
                    fallback_detected: false,
                })
                .collect(),
        })
    }
}

/// Reject links in the app-owned path, including directory junctions on Windows.
fn plain_path(path: &Path, directory: bool) -> io::Result<()> {
    if !path.is_absolute() {
        return Err(io::Error::other("Expected absolute installation path"));
    }
    for ancestor in path.ancestors() {
        let meta = fs::symlink_metadata(ancestor)?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                return Err(io::Error::other(
                    "Linked installation paths are not supported",
                ));
            }
        }
        if meta.is_symlink() {
            return Err(io::Error::other(
                "Linked installation paths are not supported",
            ));
        }
    }
    let meta = fs::metadata(path)?;
    if (directory && !meta.is_dir()) || (!directory && !meta.is_file()) {
        return Err(io::Error::other("Unexpected installation entry"));
    }
    Ok(())
}

fn small_file(path: &Path) -> io::Result<Vec<u8>> {
    use std::io::Read;
    plain_path(path, false)?;
    let mut bytes = vec![];
    fs::File::open(path)?.take(262145).read_to_end(&mut bytes)?;
    if bytes.len() > 262144 {
        return Err(io::Error::other("Companion metadata exceeds limit"));
    }
    Ok(bytes)
}

fn assets_ready(root: &Path) -> bool {
    let base = root.join("browser-companion");
    let extension = base.join("extension");
    let result = (|| -> io::Result<()> {
        plain_path(&base.join("companion.exe"), false)?;
        // Validate the complete small extension against this build, not just a claimed ID.
        for (name, expected) in [
            (
                "manifest.json",
                include_bytes!("../../../extensions/companion/manifest.json").as_slice(),
            ),
            (
                "extension-id.txt",
                include_bytes!("../../../extensions/companion/extension-id.txt").as_slice(),
            ),
            (
                "background.js",
                include_bytes!("../../../extensions/companion/background.js").as_slice(),
            ),
            (
                "cdp-actions.js",
                include_bytes!("../../../extensions/companion/cdp-actions.js").as_slice(),
            ),
            (
                "popup.html",
                include_bytes!("../../../extensions/companion/popup.html").as_slice(),
            ),
            (
                "popup.js",
                include_bytes!("../../../extensions/companion/popup.js").as_slice(),
            ),
            (
                "popup.css",
                include_bytes!("../../../extensions/companion/popup.css").as_slice(),
            ),
        ] {
            if small_file(&extension.join(name))? != expected {
                return Err(io::Error::other(
                    "Companion files differ from this application build",
                ));
            }
        }
        Ok(())
    })();
    result.is_ok()
}

pub fn extension_directory() -> io::Result<std::path::PathBuf> {
    let root = crate::runtimes::app_root()?;
    if !assets_ready(&root) {
        return Err(io::Error::other(
            "浏览器连接组件不完整，请重新安装 / Reinstall the incomplete browser companion",
        ));
    }
    Ok(root.join("browser-companion").join("extension"))
}

#[cfg(windows)]
fn expected_manifest(root: &Path) -> serde_json::Value {
    serde_json::json!({
        "name": HOST,
        "description": "WorkPilot task browser connection",
        "path": root.join("browser-companion").join("companion.exe").to_string_lossy(),
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{}/", EXTENSION_ID.trim())]
    })
}

#[cfg(windows)]
fn manifest_ready(root: &Path) -> bool {
    small_file(&root.join("browser-companion").join(MANIFEST))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .is_some_and(|v| v == expected_manifest(root))
}

#[cfg(windows)]
fn ensure_manifest(root: &Path) -> io::Result<()> {
    use std::io::Write;
    let path = root.join("browser-companion").join(MANIFEST);
    if path.try_exists()? {
        if !manifest_ready(root) {
            return Err(io::Error::other(
                "连接文件与当前安装不符，未覆盖；请重新安装 / Existing companion manifest differs; it was not overwritten. Reinstall this copy",
            ));
        }
        return Ok(());
    }
    plain_path(path.parent().unwrap(), true)?;
    let bytes = serde_json::to_vec_pretty(&expected_manifest(root))?;
    // create_new refuses a replacement/link created after the check above.
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(&bytes)?;
    file.sync_all()
}
