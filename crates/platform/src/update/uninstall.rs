use super::{Result, files, format, install, io};
use std::{collections::BTreeSet, fs, path::Path};
/// Removes only unchanged signed update files. NSIS removes its own initial file list afterwards.
pub fn remove_updated_files(install: &Path) -> Result<usize> {
    let install = files::directory(install)?;
    let executable = io(std::env::current_exe(), "无法核对卸载助手")?;
    if files::directory(executable.parent().ok_or("卸载助手无目录。")?)? != install {
        return Err("卸载助手只能处理自己所在的安装目录。".into());
    }
    let pointer = install::pointer(&install)?;
    if !pointer.exists() {
        return Ok(0);
    }
    let p: install::Prepared = files::read_json(&pointer)?;
    if p.install != install {
        return Err("卸载登记与当前安装位置不符。".into());
    }
    if p.phase == "rolled_back" {
        return Ok(0);
    }
    if p.phase != "committed" {
        return Err("上次更新尚未提交，请先打开 WorkPilot 完成恢复。".into());
    }
    let (_, manifest) = format::verify(&p.proof, &p.preview.current_version, super::TRUST)?;
    let mut selected = Vec::new();
    let mut directories = BTreeSet::new();
    for file in manifest.files {
        if file.path.eq_ignore_ascii_case("workpilot-update.exe")
            || file.path.eq_ignore_ascii_case("uninstall.exe")
        {
            continue;
        }
        let path = install.join(&file.path);
        if !path.exists() {
            continue;
        }
        if files::hash_file(&path)? != (file.bytes, file.sha256) {
            continue;
        }
        for parent in path.ancestors().skip(1).take_while(|p| *p != install) {
            directories.insert(parent.to_path_buf());
        }
        selected.push(path);
    }
    for path in &selected {
        io(fs::remove_file(path), "无法移除属于已签名更新的文件")?;
    }
    for directory in directories.into_iter().rev() {
        let _ = fs::remove_dir(directory);
    }
    Ok(selected.len())
}
