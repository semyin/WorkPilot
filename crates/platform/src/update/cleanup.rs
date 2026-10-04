//! Explicit offline deletion of verified update recovery copies, never current app/data.
use super::{Result, files, format, install, io};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};
#[derive(Clone, Debug, Serialize)]
pub struct BackupCleanupItem {
    pub path: String,
    pub files: u64,
    pub bytes: u64,
    pub retained_exports: u64,
}
#[derive(Clone, Debug, Serialize)]
pub struct BackupCleanupPreview {
    pub fingerprint: String,
    pub files: u64,
    pub bytes: u64,
    pub items: Vec<BackupCleanupItem>,
    pub skipped: Vec<String>,
}
#[derive(Serialize)]
struct File {
    path: PathBuf,
    bytes: u64,
    sha256: String,
}
struct Plan {
    report: BackupCleanupPreview,
    files: Vec<File>,
    directories: Vec<PathBuf>,
}
fn archive(path: &Path) -> Result<bool> {
    if path.extension().is_some_and(|e| {
        matches!(
            e.to_string_lossy().to_ascii_lowercase().as_str(),
            "wphistory"
                | "wpsettings"
                | "wpextensions"
                | "wpfiles"
                | "wpmedia"
                | "wptask"
                | "wpbundle"
                | "wpupdate"
                | "wpmigration"
                | "wpmigrate"
                | "wpbackup"
                | "zip"
                | "7z"
                | "tar"
                | "gz"
                | "bz2"
                | "xz"
        )
    }) {
        return Ok(true);
    }
    let mut input = io(fs::File::open(path), "无法核对是否属于用户导出包")?;
    let mut magic = [0; 8];
    match input.read_exact(&mut magic) {
        Ok(()) => Ok([
            b"WPFULL01",
            b"WPHIST01",
            b"WPTASK01",
            b"WPMEDIA1",
            b"WPEXT001",
            b"WPSET001",
            b"WPFILE01",
            b"WPUPDT01",
        ]
        .contains(&&magic)),
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => Ok(false),
        Err(_) => Err("无法确认恢复副本中的导出包，清理已停止。".into()),
    }
}
fn inventory(
    root: &Path,
    selected: &mut Vec<File>,
    dirs: &mut Vec<PathBuf>,
) -> Result<BackupCleanupItem> {
    files::directory(root)?;
    let mut item = BackupCleanupItem {
        path: root.display().to_string(),
        files: 0,
        bytes: 0,
        retained_exports: 0,
    };
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        dirs.push(dir.clone());
        for entry in io(fs::read_dir(dir), "无法预览更新恢复副本")? {
            let path = io(entry, "无法读取恢复副本条目")?.path();
            let meta = files::no_link(&path)?;
            if meta.is_dir() {
                pending.push(path);
            } else if meta.is_file() {
                if archive(&path)? {
                    item.retained_exports += 1;
                    continue;
                }
                let (bytes, sha256) = files::hash_file(&path)?;
                item.files += 1;
                item.bytes += bytes;
                selected.push(File {
                    path,
                    bytes,
                    sha256,
                });
                if selected.len() > 250000 || item.bytes > 64 * 1024 * 1024 * 1024 {
                    return Err("恢复副本清理范围过大，请分开处理。".into());
                }
            } else {
                return Err("恢复副本含特殊文件，不能安全清理。".into());
            }
        }
    }
    Ok(item)
}
fn plan(install: &Path, data: &Path, trust: &str) -> Result<Plan> {
    let install = files::directory(install)?;
    let data = files::directory(data)?;
    let parent = install.parent().ok_or("安装目录没有父目录。")?;
    let mut selected = Vec::new();
    let mut directories = Vec::new();
    let mut items = Vec::new();
    let mut skipped = Vec::new();
    for entry in io(fs::read_dir(parent), "无法检查更新恢复目录")? {
        let entry = io(entry, "无法检查恢复记录")?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_prefix(".workpilot-update-") else {
            continue;
        };
        if uuid::Uuid::parse_str(id).is_err() {
            continue;
        }
        let job = entry.path();
        files::directory(&job)?;
        if !job.join("prepared.json").is_file() {
            skipped.push(format!("{name}：没有完整升级记录，保留。"));
            continue;
        }
        let p: install::Prepared = files::read_json(&job.join("prepared.json"))?;
        if p.job != job {
            return Err("恢复记录与所在目录不一致，不能清理。".into());
        }
        if p.install != install || p.data != data {
            continue;
        }
        install::check(&p)?;
        let _ = format::verify(&p.proof, &p.preview.current_version, trust)?;
        if !matches!(p.phase.as_str(), "committed" | "rolled_back") {
            skipped.push(format!("{name}：更新尚未完成，不能删除。"));
            continue;
        }
        let allowed = [
            p.job.join("previous"),
            p.job.join("application-failed"),
            p.job.join("next"),
            p.data_job.join("previous"),
            p.data_job.join("failed"),
            p.data_job.join("next"),
        ];
        for path in allowed {
            if path.exists() {
                if path == install
                    || path == data
                    || install.starts_with(&path)
                    || data.starts_with(&path)
                {
                    return Err("清理范围与当前安装或数据重叠。".into());
                }
                let item = inventory(&path, &mut selected, &mut directories)?;
                if item.files > 0 || item.retained_exports > 0 {
                    items.push(item);
                }
            }
        }
    }
    selected.sort_by(|a, b| a.path.cmp(&b.path));
    items.sort_by(|a, b| a.path.cmp(&b.path));
    skipped.sort();
    let files = selected.len() as u64;
    let bytes = selected.iter().map(|f| f.bytes).sum();
    let fingerprint = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&(&install, &data, &selected, &skipped))
                .map_err(|_| "无法核对清理范围。")?
        )
    );
    Ok(Plan {
        report: BackupCleanupPreview {
            fingerprint,
            files,
            bytes,
            items,
            skipped,
        },
        files: selected,
        directories,
    })
}
pub fn preview_backups(install: &Path, data: &Path) -> Result<BackupCleanupPreview> {
    preview_trusted(install, data, super::TRUST)
}
pub(super) fn preview_trusted(
    install: &Path,
    data: &Path,
    trust: &str,
) -> Result<BackupCleanupPreview> {
    let _lock = install::transaction::installation_lock(&files::directory(install)?)?;
    plan(install, data, trust).map(|p| p.report)
}
pub fn delete_backups(
    install: &Path,
    data: &Path,
    fingerprint: &str,
    confirmation: &str,
) -> Result<BackupCleanupPreview> {
    delete_trusted(install, data, fingerprint, confirmation, super::TRUST)
}
pub(super) fn delete_trusted(
    install: &Path,
    data: &Path,
    fingerprint: &str,
    confirmation: &str,
    trust: &str,
) -> Result<BackupCleanupPreview> {
    if confirmation != "DELETE" {
        return Err("永久删除恢复副本需要输入 DELETE 确认。".into());
    }
    let install = files::directory(install)?;
    let data = files::directory(data)?;
    let _install = install::transaction::installation_lock(&install)?;
    let _update = super::data_update_lock(&data, true)
        .map_err(|_| "数据仍在使用，请先停止任务并退出执行器。")?;
    let _engine = install::lock_engine(&data)?;
    let p = plan(&install, &data, trust)?;
    if p.report.fingerprint != fingerprint {
        return Err("恢复副本在预览后发生变化，请重新预览；本次未删除。".into());
    }
    if p.report.files == 0 {
        return Err("没有可删除的已完成更新恢复副本。".into());
    }
    // The entire inventory is reverified before any irreversible removal. Current data,
    // credentials, exported archives and unrecognized job children are never selected.
    for file in &p.files {
        io(
            fs::remove_file(&file.path),
            "无法删除已确认的恢复副本；其余副本仍保留，可重新预览后重试",
        )?;
    }
    let mut dirs = p.directories;
    dirs.sort_by_key(|p| std::cmp::Reverse(p.components().count()));
    dirs.dedup();
    for dir in dirs {
        let _ = fs::remove_dir(dir);
    }
    Ok(p.report)
}
