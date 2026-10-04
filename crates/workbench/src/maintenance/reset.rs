use super::*;
use workpilot_platform::credentials::{CredentialStore, SystemCredentials};
// Only application-owned directories are removed. Unknown files and every project stay untouched.
const OWNED: &[&str] = &[
    "objects",
    "versions",
    "extensions",
    "media",
    "browser",
    "browser-profiles",
    "tool-sandboxes",
    "backups",
    "diagnostics",
    "desktop-notifications",
];
pub(super) fn plain_tree(path: &Path, data: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !path.starts_with(data)
        || path == data
        || meta.file_type().is_symlink()
        || path.canonicalize().map_err(|e| e.to_string())? != path
    {
        return Err(
            "清理范围存在链接或位置变化，未跟随该位置 / Linked or changed cleanup path".into(),
        );
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err("清理范围含重解析点 / Reparse points are not followed".into());
        }
    }
    if meta.is_dir() {
        for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
            plain_tree(&entry.map_err(|e| e.to_string())?.path(), data)?;
        }
    }
    Ok(())
}
pub(super) fn preflight(store: &Store, data: &Path) -> Result<()> {
    for root in store
        .maintenance_project_paths()
        .map_err(|e| e.to_string())?
    {
        let root = std::path::PathBuf::from(root);
        let root = root.canonicalize().unwrap_or(root);
        if root.starts_with(data) {
            return Err("项目位于应用数据目录内，请先移出项目再清空 / Move projects outside app data before reset".into());
        }
    }
    for name in OWNED {
        let p = data.join(name);
        if p.exists() {
            plain_tree(&p, data)?;
        }
    }
    Ok(())
}
pub(super) fn finish(store: &mut Store, data: &Path) -> Result<Value> {
    preflight(store, data)?;
    let pending = store
        .maintenance_cleanup_pending()
        .map_err(|e| e.to_string())?;
    let refs = pending["credentials"]
        .as_array()
        .ok_or("Missing reset cleanup journal")?;
    let mut failures = vec![];
    for name in OWNED {
        let path = data.join(name);
        if path.exists() {
            plain_tree(&path, data)?;
            // Absolute, canonical, whitelisted app-owned target; no project path is accepted here.
            if let Err(e) = fs::remove_dir_all(&path) {
                failures.push(format!("{name}: {e}"));
            }
        }
    }
    for entry in fs::read_dir(data).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("probe-")
            && name.ends_with(".jsonl")
            && entry.file_type().map_err(|e| e.to_string())?.is_file()
        {
            plain_tree(&entry.path(), data)?;
            if let Err(e) = fs::remove_file(entry.path()) {
                failures.push(format!("diagnostic: {e}"));
            }
        }
    }
    for entry in refs {
        let namespace = entry["namespace"]
            .as_str()
            .ok_or("Invalid credential journal")?;
        let id = entry["id"].as_str().ok_or("Invalid credential journal")?;
        let credential = SystemCredentials::new(namespace).map_err(|e| e.to_string())?;
        if credential.delete(&CredentialRef { id: id.into() }).is_err() {
            failures
                .push("系统凭据暂时无法清理，已保留重试记录 / Credential cleanup pending".into());
        }
    }
    if !failures.is_empty() {
        return Err(format!(
            "记录已清空；部分文件或凭据待重试。再次点击确认或重启会继续已授权的清理 / Reset cleanup pending: {}",
            failures.join("; ")
        ));
    }
    store
        .maintenance_finish_reset()
        .map_err(|e| e.to_string())?;
    Ok(
        json!({"state":"reset","credential_references_processed":refs.len(),"project_files_preserved":true,"restart_required":true}),
    )
}
