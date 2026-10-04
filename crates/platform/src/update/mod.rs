//! User-triggered, signed private updates. No model tool or background polling.
mod cleanup;
mod files;
mod format;
mod install;
mod recovery_entry;
#[cfg(test)]
mod recovery_process_test;
mod registration;
mod source;
#[cfg(test)]
mod tests;
mod uninstall;

pub use cleanup::{BackupCleanupPreview, delete_backups, preview_backups};
pub use format::{Entry, Manifest, Preview, inspect};
pub use install::{InstallResult, Prepared, apply, prepare, recover, recover_for_install};
pub use recovery_entry::{
    RecoveryEntry, create_recovery_entry, display_recovery_path, prepare_recovery_entry,
    recover_interactive, recovery_entry, validate_recovery_entry,
};
pub use source::inspect_source;
use std::{fs::File, path::Path};
pub use uninstall::remove_updated_files;

pub type Result<T> = std::result::Result<T, String>;
pub const MAX_PACKAGE: u64 = 16 * 1024 * 1024 * 1024;
pub(crate) const TRUST: &str = include_str!("../../../../resources/update/trust.json");

/// Stable across a data-directory replacement; every normal Store holds shared access.
pub fn data_update_lock(directory: &Path, exclusive: bool) -> std::io::Result<File> {
    use sha2::{Digest, Sha256};
    let parent = directory
        .parent()
        .ok_or_else(|| std::io::Error::other("data parent missing"))?;
    let name = directory
        .file_name()
        .ok_or_else(|| std::io::Error::other("data name missing"))?;
    let digest = format!("{:x}", Sha256::digest(name.to_string_lossy().as_bytes()));
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(parent.join(format!(".workpilot-update-{}.lock", &digest[..24])))?;
    if exclusive {
        file.try_lock()?;
    } else {
        file.try_lock_shared()?;
    }
    Ok(file)
}

pub(crate) fn io<T>(result: std::io::Result<T>, context: &str) -> Result<T> {
    result.map_err(|e| {
        let reason = if matches!(e.raw_os_error(), Some(32 | 33)) {
            "文件仍被其它程序占用"
        } else {
            match e.kind() {
                std::io::ErrorKind::PermissionDenied => "没有所需权限",
                std::io::ErrorKind::NotFound => "所需文件不存在",
                std::io::ErrorKind::AlreadyExists => "目标位置已被占用",
                std::io::ErrorKind::UnexpectedEof => "文件内容不完整",
                _ => "系统文件操作失败",
            }
        };
        format!("{context}（{reason}）；原安装和备份保持保留。")
    })
}
