use super::{Prepared, Result, files, format, install, io};
use serde::Serialize;
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

const PREFIX: &str = "WorkPilot-Recover-";

pub fn display_recovery_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned()
    }
}

pub fn prepare_recovery_entry(record: &Path) -> Result<RecoveryEntry> {
    let p: Prepared = files::read_json(record)?;
    if p.job.join("prepared.json") != record {
        return Err("恢复记录位置与更新目录不一致。".into());
    }
    install::verify_stage(&p)?;
    create_recovery_entry(&p)
}

#[derive(Clone, Debug, Serialize)]
pub struct RecoveryEntry {
    pub executable: PathBuf,
    pub instructions: PathBuf,
}

pub fn recovery_entry(p: &Prepared) -> Result<RecoveryEntry> {
    install::check(p)?;
    let id = p
        .job
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.strip_prefix(".workpilot-update-"))
        .ok_or("无法定位更新恢复编号。")?;
    let parent = p.install.parent().ok_or("无法定位更新恢复位置。")?;
    Ok(RecoveryEntry {
        executable: parent.join(format!("{PREFIX}{id}.exe")),
        instructions: parent.join(format!("{PREFIX}{id}.txt")),
    })
}

/// Create a visible, double-clickable recovery entry outside the directory being replaced.
/// Every output uses create_new: even an unexpected same-name file is never overwritten.
pub fn create_recovery_entry(p: &Prepared) -> Result<RecoveryEntry> {
    let entry = recovery_entry(p)?;
    if p.phase != "prepared" {
        return Err("只能在准备更新时创建恢复入口。".into());
    }
    let helper = p.install.join("workpilot-update.exe");
    files::regular(&helper)?;
    let mut output = io(
        OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&entry.executable),
        "恢复入口已存在或无法建立；未覆盖已有文件",
    )?;
    let created = (|| {
        let mut source = io(File::open(&helper), "无法读取当前恢复工具")?;
        io(std::io::copy(&mut source, &mut output), "无法复制恢复工具")?;
        io(output.flush(), "无法保存恢复工具")?;
        io(output.sync_all(), "无法保存恢复工具")?;
        let mut instructions = io(
            OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&entry.instructions),
            "恢复说明已存在或无法建立；未覆盖已有文件",
        )?;
        let text = format!(
            "\u{feff}WorkPilot 更新恢复 / Update recovery\r\n\r\n\
             如果更新中途断电或被关闭，原快捷方式可能暂时打不开。\r\n\
             请双击同目录中的 {}，阅读显示的程序和数据位置，然后确认恢复。\r\n\
             恢复只处理本次未完成更新，会把旧程序和原数据一起放回原位置；不重建数据库，不自动执行任务。\r\n\
             成功后使用原快捷方式打开 WorkPilot。失败时保留此文件、恢复工具及下方两个更新目录，不要手动删除数据；对话框会说明原因，可关闭其它占用程序后重试。\r\n\
             已完成的更新不会被这个工具降级。恢复入口与说明默认保留，不包含模型密钥。\r\n\r\n\
             If an update was interrupted and the usual shortcut cannot start, double-click the adjacent recovery executable. Confirm the displayed locations. Recovery restores the original program and data together, without rebuilding the database or running tasks. Reopen the usual shortcut after success. Keep these recovery files and the update directories if recovery fails. Completed updates are not downgraded.\r\n\r\n\
             程序 / Program: {}\r\n资料 / Data: {}\r\n程序更新目录 / Program update: {}\r\n资料更新目录 / Data update: {}\r\n",
            entry.executable.file_name().unwrap().to_string_lossy(),
            display_recovery_path(&p.install),
            display_recovery_path(&p.data),
            display_recovery_path(&p.job),
            display_recovery_path(&p.data_job)
        );
        io(instructions.write_all(text.as_bytes()), "无法保存恢复说明")?;
        io(instructions.sync_all(), "无法保存恢复说明")?;
        Ok(())
    })();
    drop(output);
    if let Err(error) = created {
        // Only remove the executable created by this call. A pre-existing instruction file stays.
        let _ = fs::remove_file(&entry.executable);
        return Err(error);
    }
    validate_recovery_entry(p)?;
    Ok(entry)
}

pub fn validate_recovery_entry(p: &Prepared) -> Result<RecoveryEntry> {
    let entry = recovery_entry(p)?;
    if files::hash_file(&entry.executable)?
        != files::hash_file(&p.install.join("workpilot-update.exe"))?
    {
        return Err("独立恢复工具已变化，请重新准备更新。".into());
    }
    files::regular(&entry.instructions)?;
    Ok(entry)
}

fn record_for(executable: &Path) -> Result<(PathBuf, Prepared)> {
    files::regular(executable)?;
    let executable = io(executable.canonicalize(), "无法定位恢复入口")?;
    let name = executable
        .file_name()
        .and_then(|x| x.to_str())
        .ok_or("恢复入口名称无效。")?;
    let id = name
        .strip_prefix(PREFIX)
        .and_then(|x| x.strip_suffix(".exe"))
        .ok_or("请从设置中准备更新，或双击准备好的 WorkPilot-Recover 恢复工具。")?;
    let id = uuid::Uuid::parse_str(id).map_err(|_| "恢复入口编号无效。")?;
    let parent = executable.parent().ok_or("恢复入口位置无效。")?;
    let record = parent.join(format!(".workpilot-update-{id}/prepared.json"));
    let p: Prepared = files::read_json(&record)?;
    install::check(&p)?;
    if !matches!(
        p.phase.as_str(),
        "prepared"
            | "backing_up"
            | "checking_data"
            | "ready_to_switch"
            | "application_saved"
            | "application_switched"
            | "data_saved"
            | "data_switched"
            | "committed"
            | "rolled_back"
    ) {
        return Err("更新记录状态无法识别；没有修改程序或数据。".into());
    }
    if p.job.join("prepared.json") != record || recovery_entry(&p)?.executable != executable {
        return Err("恢复记录与此入口的位置不一致；没有修改程序或数据。".into());
    }
    let (preview, manifest) = format::verify(&p.proof, &p.preview.current_version, super::TRUST)?;
    if preview.fingerprint != p.preview.fingerprint
        || serde_json::to_value(&manifest).ok() != serde_json::to_value(&p.manifest).ok()
    {
        return Err("恢复记录中的签名清单不一致；没有修改程序或数据。".into());
    }
    if !matches!(p.phase.as_str(), "prepared" | "committed" | "rolled_back") {
        let active: Prepared = files::read_json(&install::pointer(&p.install)?)?;
        if active.job != p.job
            || active.install != p.install
            || active.data != p.data
            || matches!(active.phase.as_str(), "committed" | "rolled_back")
        {
            return Err(
                "此入口不是当前未完成更新的恢复入口，或该更新已完成；没有修改程序或数据。".into(),
            );
        }
    }
    Ok((record, p))
}

/// No command shell, supplied path, or external configuration is used for double-click recovery.
pub fn recover_interactive(executable: &Path) -> Result<()> {
    let result = (|| {
        let (record, p) = record_for(executable)?;
        if p.phase == "prepared" {
            notice(
                "WorkPilot 恢复状态 / Recovery status",
                "这个编号的更新尚未开始，不会修改任何程序或数据。若其它更新被中断，请使用它对应编号的恢复入口。\nThis prepared update has not started. No program or data is changed. Use the matching recovery entry for an interrupted update.",
                false,
            );
            return Ok(());
        }
        if matches!(p.phase.as_str(), "committed" | "rolled_back") {
            notice(
                "WorkPilot 恢复状态 / Recovery status",
                "此次更新已经完成或恢复，无需再次回退。请使用原快捷方式打开 WorkPilot。\nThis update is already completed or restored. Open the usual WorkPilot shortcut.",
                false,
            );
            return Ok(());
        }
        let message = format!(
            "检测到未完成的更新。是否把原程序和原数据恢复到下列位置？\n不会关闭其它 WorkPilot 实例；请先退出它们。恢复后不会自动运行任务。\n\nRestore the original program and data from this interrupted update? Close other WorkPilot instances first. Tasks will not restart automatically.\n\n程序 / Program: {}\n资料 / Data: {}",
            display_recovery_path(&p.install),
            display_recovery_path(&p.data)
        );
        if !confirm(&message) {
            return Ok(());
        }
        super::recover(&record)?;
        notice(
            "WorkPilot 恢复完成 / Recovery complete",
            "原程序与原数据已恢复。现在可使用原快捷方式打开 WorkPilot；原任务不会自动继续。\nThe original program and data are restored. Open the usual shortcut; tasks will not resume automatically.",
            false,
        );
        Ok(())
    })();
    if let Err(error) = &result {
        notice(
            "WorkPilot 恢复未完成 / Recovery failed",
            &format!(
                "恢复尚未完成，请保留恢复工具和备份目录。\nRecovery did not complete. Keep the recovery tool and backup directories.\n\n{error}"
            ),
            true,
        );
    }
    result
}

#[cfg(windows)]
fn message(title: &str, text: &str, flags: u32) -> i32 {
    let title: Vec<u16> = title.encode_utf16().chain(Some(0)).collect();
    let text: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            flags,
        )
    }
}
#[cfg(windows)]
fn confirm(text: &str) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        IDYES, MB_DEFBUTTON2, MB_ICONQUESTION, MB_YESNO,
    };
    message(
        "WorkPilot 更新恢复 / Update recovery",
        text,
        MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2,
    ) == IDYES
}
#[cfg(windows)]
fn notice(title: &str, text: &str, error: bool) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_ICONINFORMATION, MB_OK};
    message(
        title,
        text,
        MB_OK
            | if error {
                MB_ICONERROR
            } else {
                MB_ICONINFORMATION
            },
    );
}
#[cfg(not(windows))]
fn confirm(_text: &str) -> bool {
    false
}
#[cfg(not(windows))]
fn notice(_title: &str, text: &str, _error: bool) {
    eprintln!("{text}");
}
