//! Application-local tools and bounded, read-only installation diagnostics.
use serde::Deserialize;
#[cfg(test)]
use sha2::{Digest, Sha256};
use std::{
    fs, io,
    path::{Component, Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use workpilot_contracts::{InstallationReport, RuntimeHealth, SCHEMA_VERSION};
type Result<T> = io::Result<T>;
const MANIFEST: &str = "runtime-catalog.json";
mod scanner;
mod worker;
pub use worker::worker_main;
pub fn app_root() -> Result<PathBuf> {
    std::env::current_exe()?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| io::Error::other("Application directory unavailable"))
}
fn relative_executable(name: &str) -> Option<&'static str> {
    if !cfg!(windows) {
        return match name {
            "node" => Some("browser-runtime/node"),
            "python" | "python3" => Some("python-runtime/bin/python3"),
            "git" => Some("git-runtime/bin/git"),
            _ => None,
        };
    }
    match name.to_ascii_lowercase().trim_end_matches(".exe") {
        "node" => Some("browser-runtime/node.exe"),
        "python" | "python3" => Some("python-runtime/python.exe"),
        "git" => Some("git-runtime/cmd/git.exe"),
        _ => None,
    }
}
fn canonical(p: &Path) -> Result<PathBuf> {
    if !p.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "Program is missing",
        ));
    }
    let p = p.canonicalize()?;
    #[cfg(windows)]
    {
        let s = p.to_string_lossy();
        if s.starts_with(r"\\?\UNC\") {
            return Err(io::Error::other("Network executables are not supported"));
        }
        Ok(PathBuf::from(s.strip_prefix(r"\\?\").unwrap_or(&s)))
    }
    #[cfg(not(windows))]
    {
        Ok(p)
    }
}
fn bundled_at(base: &Path, name: &str) -> Result<Option<PathBuf>> {
    let Some(relative) = relative_executable(name) else {
        return Ok(None);
    };
    let p = base.join(relative);
    if p.is_file() {
        let actual = canonical(&p)?;
        let parent = base.canonicalize()?;
        if !actual.canonicalize()?.starts_with(&parent) {
            return Err(io::Error::other("Bundled program leaves installation"));
        }
        return Ok(Some(actual));
    }
    if base.join(MANIFEST).is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("随包工具 {name} 缺失，请修复安装 / Bundled tool missing; repair installation"),
        ));
    }
    Ok(None)
}
pub fn resolve_program(name: &str) -> Result<PathBuf> {
    if name.is_empty() || name.contains('\0') {
        return Err(io::Error::other("Invalid executable"));
    }
    let input = Path::new(name);
    if input.is_absolute() {
        return canonical(input);
    }
    if name.contains(['/', '\\']) {
        return Err(io::Error::other(
            "Use an absolute executable path or a simple program name",
        ));
    }
    if let Some(p) = bundled_at(&app_root()?, name)? {
        return Ok(p);
    }
    let file = if cfg!(windows) && !name.to_ascii_lowercase().ends_with(".exe") {
        format!("{name}.exe")
    } else {
        name.into()
    };
    let extra = std::env::var_os("SystemRoot")
        .map(|s| PathBuf::from(s).join("System32/WindowsPowerShell/v1.0"));
    for folder in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).chain(extra)
    {
        let p = folder.join(&file);
        if p.is_file() {
            return canonical(&p);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        format!("找不到 {name} / Program is unavailable"),
    ))
}
/// Only an app-owned runtime receives read access for its DLLs and standard library.
pub fn owned_read_root(program: &Path) -> Result<Option<PathBuf>> {
    let base = app_root()?;
    for (name, folder) in [("python", "python-runtime"), ("git", "git-runtime")] {
        let expected = base.join(relative_executable(name).unwrap_or("__not_available__"));
        let compatible_git = base.join("git-runtime/sandbox/bin/git.exe");
        let selected = expected.is_file() && canonical(&expected)? == canonical(program)?;
        let selected_compat = cfg!(windows)
            && name == "git"
            && compatible_git.is_file()
            && canonical(&compatible_git)? == canonical(program)?;
        if selected || selected_compat {
            let root = base.join(folder).canonicalize()?;
            if root.starts_with(base.canonicalize()?) {
                return Ok(Some(root));
            }
            return Err(io::Error::other("Runtime directory leaves installation"));
        }
    }
    Ok(None)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileEntry {
    path: String,
    bytes: u64,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Package {
    id: String,
    version: String,
    source: String,
    license: String,
    files: Vec<FileEntry>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Catalog {
    schema_version: u32,
    target: String,
    components: Vec<Package>,
    #[serde(default)]
    notices: Vec<String>,
}
fn valid_relative(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 1024
        && !s.contains(['\\', ':', '\0'])
        && s.split('/').all(|v| !v.is_empty() && v != "." && v != "..")
        && Path::new(s)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
}
fn checked_file(base: &Path, p: &str) -> Result<PathBuf> {
    if !valid_relative(p) {
        return Err(io::Error::other("Invalid inventory path"));
    }
    let mut path = base.to_path_buf();
    for part in p.split('/') {
        path.push(part);
        let m = fs::symlink_metadata(&path)?;
        if m.file_type().is_symlink() {
            return Err(io::Error::other("Linked runtime file"));
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if m.file_attributes() & 0x400 != 0 {
                return Err(io::Error::other("Runtime reparse point"));
            }
        }
    }
    if !path.is_file() {
        return Err(io::Error::other("Runtime is not a regular file"));
    }
    Ok(path)
}
pub fn inspect(verify: bool, stop: Arc<AtomicBool>) -> Result<InstallationReport> {
    worker::inspect(verify, stop)
}
#[cfg(test)]
fn inspect_at(base: &Path, verify: bool, stop: Arc<AtomicBool>) -> Result<InstallationReport> {
    inspect_with_progress(base, verify, stop, |_, _| Ok(()))
}
fn inspect_with_progress(
    base: &Path,
    verify: bool,
    stop: Arc<AtomicBool>,
    mut progress: impl FnMut(Option<&str>, bool) -> Result<()>,
) -> Result<InstallationReport> {
    progress(None, true)?;
    let mut report = InstallationReport {
        report_version: 1,
        app_version: env!("CARGO_PKG_VERSION").into(),
        schema_version: SCHEMA_VERSION,
        platform: std::env::consts::OS.into(),
        architecture: std::env::consts::ARCH.into(),
        checked_at_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        manifest_present: false,
        verified_hashes: false,
        components: vec![],
        notices: vec![],
    };
    let catalog = base.join(MANIFEST);
    if !catalog.is_file() {
        report.notices.push("没有分发清单，可能是开发模式；不能据此确认随包环境完整 / No package inventory; completeness is unknown".into());
        return Ok(report);
    }
    report.manifest_present = true;
    if fs::metadata(&catalog)?.len() > 16 * 1024 * 1024 {
        return Err(io::Error::other("Runtime inventory exceeds limit"));
    }
    let catalog: Catalog = serde_json::from_slice(&fs::read(catalog)?)
        .map_err(|_| io::Error::other("运行环境清单格式损坏 / Invalid runtime inventory"))?;
    if catalog.schema_version != 1
        || catalog.target != "windows-x86_64"
        || catalog.components.len() > 24
        || catalog.notices.len() > 8
        || catalog.notices.iter().any(|s| s.len() > 2048)
    {
        return Err(io::Error::other("Unsupported runtime inventory"));
    }
    let count: usize = catalog.components.iter().map(|p| p.files.len()).sum();
    if count > 100000 {
        return Err(io::Error::other("Runtime inventory exceeds file limit"));
    }
    let mut seen = std::collections::HashSet::new();
    report.notices = catalog.notices;
    let mut ids = std::collections::HashSet::new();
    for package in catalog.components {
        if package.id.len() > 64
            || package.version.len() > 128
            || package.source.len() > 1024
            || package.license.len() > 512
            || package.files.is_empty()
            || !ids.insert(package.id.clone())
        {
            return Err(io::Error::other("Invalid runtime component"));
        }
        let mut h = RuntimeHealth {
            id: package.id,
            version: package.version,
            source: package.source,
            license: package.license,
            state: if verify { "verified" } else { "present" }.into(),
            files: package.files.len() as u32,
            checked_files: 0,
            bytes: 0,
            issues: vec![],
        };
        for file in &package.files {
            if stop.load(Ordering::Relaxed) {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "Installation check cancelled",
                ));
            }
            if !valid_relative(&file.path)
                || file.bytes > 2 * 1024 * 1024 * 1024
                || file.sha256.len() != 64
                || !file.sha256.bytes().all(|b| b.is_ascii_hexdigit())
                || !seen.insert(file.path.to_ascii_lowercase())
            {
                return Err(io::Error::other("Invalid runtime file declaration"));
            }
            h.bytes = h
                .bytes
                .checked_add(file.bytes)
                .ok_or_else(|| io::Error::other("Runtime size overflow"))?;
        }
        let states = scanner::inspect_files(base, &package.files, verify, &stop, &mut progress)?;
        for (file, state) in package.files.iter().zip(states) {
            match state {
                Ok(()) => h.checked_files += 1,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => return Err(e),
                Err(e) => {
                    h.state = "incomplete".into();
                    if h.issues.len() < 24 {
                        h.issues.push(format!(
                            "{}: {}",
                            file.path,
                            match e.kind() {
                                io::ErrorKind::NotFound => "缺失 / missing",
                                io::ErrorKind::PermissionDenied => "无法读取 / unreadable",
                                _ => "内容或路径不符 / mismatch",
                            }
                        ));
                    }
                }
            }
        }
        report.components.push(h);
    }
    report.verified_hashes = verify;
    report.notices.push("检查依据本机随包清单，不代替更新签名验证；报告不包含项目正文、用户路径或凭据 / Local inventory checks do not verify update signatures; project content, user paths and credentials are excluded".into());
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample(dir: &Path) {
        fs::write(dir.join("worker.bin"), b"hello").unwrap();
        fs::write(dir.join(MANIFEST),serde_json::to_vec(&serde_json::json!({"schema_version":1,"target":"windows-x86_64","components":[{"id":"sample","version":"1","source":"https://example.invalid/source","license":"fixture","files":[{"path":"worker.bin","bytes":5,"sha256":format!("{:x}",Sha256::digest(b"hello"))}]}]})).unwrap()).unwrap();
    }
    #[test]
    fn integrity_checks_detect_same_size_damage_missing_files_and_preserve_data() {
        let d = tempfile::tempdir().unwrap();
        sample(d.path());
        let check = || inspect_at(d.path(), true, Arc::new(AtomicBool::new(false))).unwrap();
        assert_eq!(check().components[0].state, "verified");
        fs::write(d.path().join("worker.bin"), b"other").unwrap();
        assert_eq!(check().components[0].state, "incomplete");
        fs::remove_file(d.path().join("worker.bin")).unwrap();
        assert!(check().components[0].issues[0].contains("missing"));
        assert!(
            !serde_json::to_string(&check())
                .unwrap()
                .contains(d.path().to_str().unwrap())
        );
    }
    #[test]
    fn missing_malformed_traversal_and_cancelled_inventory_are_truthful() {
        let d = tempfile::tempdir().unwrap();
        assert!(
            !inspect_at(d.path(), false, Arc::new(AtomicBool::new(false)))
                .unwrap()
                .manifest_present
        );
        sample(d.path());
        assert!(inspect_at(d.path(), true, Arc::new(AtomicBool::new(true))).is_err());
        let text = fs::read_to_string(d.path().join(MANIFEST)).unwrap();
        fs::write(
            d.path().join(MANIFEST),
            text.replace("worker.bin", "../worker.bin"),
        )
        .unwrap();
        assert!(inspect_at(d.path(), true, Arc::new(AtomicBool::new(false))).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn packaged_resolution_never_falls_back_when_its_tool_is_missing() {
        let d = tempfile::tempdir().unwrap();
        assert!(bundled_at(d.path(), "python").unwrap().is_none());
        sample(d.path());
        assert!(bundled_at(d.path(), "python").is_err());
        fs::create_dir(d.path().join("python-runtime")).unwrap();
        fs::write(d.path().join("python-runtime/python.exe"), b"fixture").unwrap();
        assert!(
            bundled_at(d.path(), "python3.exe")
                .unwrap()
                .unwrap()
                .ends_with("python.exe")
        );
    }
}
