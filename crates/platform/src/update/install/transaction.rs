use super::*;
use std::{
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InstallResult {
    pub state: String,
    pub version: String,
    pub previous_install: Option<PathBuf>,
    pub previous_data: Option<PathBuf>,
    pub recovery_locations: Vec<RecoveryLocation>,
    pub message: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RecoveryLocation {
    pub kind: String,
    pub path: PathBuf,
}
fn checkpoint(p: &mut Prepared, phase: &str) -> Result<()> {
    p.phase = phase.into();
    files::write_json(&p.job.join("prepared.json"), p)?;
    files::write_json(&pointer(&p.install)?, p)
}
fn process_lock(p: &Prepared) -> Result<File> {
    let file = io(
        OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .read(true)
            .open(p.job.join("operation.lock")),
        "无法锁定升级操作",
    )?;
    file.try_lock()
        .map_err(|_| "升级正在处理中，请等待当前升级结束。")?;
    Ok(file)
}
pub(crate) fn installation_lock(install: &Path) -> Result<File> {
    let path = pointer(install)?.with_extension("lock");
    let file = io(
        OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path),
        "无法锁定当前安装",
    )?;
    file.try_lock()
        .map_err(|_| "此安装位置正在更新或恢复，请稍后重试。")?;
    Ok(file)
}
fn schema(data: &Path) -> Result<u32> {
    files::regular(&data.join("workpilot.sqlite3"))?;
    let db = rusqlite::Connection::open_with_flags(
        data.join("workpilot.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|_| "无法读取数据版本。")?;
    let quick: String = db
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(|_| "数据库完整性检查失败。")?;
    let references: u64 = db
        .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })
        .map_err(|_| "数据库引用检查失败。")?;
    if quick != "ok" || references != 0 {
        return Err("数据库不完整，升级已停止。".into());
    }
    db.query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|_| "无法读取数据版本。".into())
}
pub(crate) fn migrate(p: &Prepared, data: &Path) -> Result<()> {
    let executable = p.job.join("next/workpilot-sidecar.exe");
    let mut command = Command::new(executable);
    command
        .arg("--check-update-data")
        .arg(data)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut engine = crate::process::ManagedEngine::spawn(&mut command)
        .map_err(|_| "无法启动新版的数据兼容检查。")?;
    // ManagedEngine owns all descendants. The special mode never constructs task runners.
    engine.child.stdin.take();
    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        if let Some(status) = io(engine.child.try_wait(), "无法读取数据迁移结果")? {
            if !status.success() {
                return Err("新版数据迁移失败；原程序及原数据保持可恢复。".into());
            }
            break;
        }
        if Instant::now() >= deadline {
            return Err("新版数据迁移超时；原程序及原数据保持可恢复。".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let mut output = String::new();
    if let Some(pipe) = engine.child.stdout.take() {
        io(
            pipe.take(8193).read_to_string(&mut output),
            "无法读取新版兼容报告",
        )?;
    }
    let report: serde_json::Value =
        serde_json::from_str(&output).map_err(|_| "新版未提供有效的数据兼容报告。")?;
    if output.len() > 8192
        || report["version"] != p.manifest.version
        || report["tasks_started"] != 0
    {
        return Err("新版程序版本或离线迁移检查结果与签名清单不一致。".into());
    }
    if schema(data)? != p.manifest.database_target {
        return Err("新版实际数据版本与签名清单不一致。".into());
    }
    Ok(())
}
pub fn apply(path: &Path) -> Result<InstallResult> {
    let mut p: Prepared = files::read_json(path)?;
    check(&p)?;
    if path != p.job.join("prepared.json") {
        return Err("升级记录位置不正确。".into());
    }
    if p.phase != "prepared" {
        return Err("此更新记录已使用，请先查看上次结果；不能重放安装。".into());
    }
    let _installation = installation_lock(&p.install)?;
    let _operation = process_lock(&p)?;
    let _lock = data_update_lock(&p.data, true)
        .map_err(|_| "程序数据仍在使用；本次未更新，请关闭其它实例。")?;
    let mut engine_lock = Some(super::lock_engine(&p.data)?);
    let result = steps(&mut p, verify_stage, migrate, |phase| {
        if phase == "ready_to_switch" {
            // Windows cannot rename a directory containing this locked file.
            // The stable exclusive update lock remains held throughout both renames.
            engine_lock.take();
        }
        Ok(())
    });
    if let Err(error) = result {
        p.error = Some(error.clone());
        // Rolling back restores both installation and data, never a mismatched pair.
        rollback(&mut p)?;
        return Err(error);
    }
    Ok(result_info(&p))
}
fn result_info(p: &Prepared) -> InstallResult {
    let candidates = [
        ("previous_program", p.job.join("previous")),
        ("discarded_program", p.job.join("application-failed")),
        ("staged_program", p.job.join("next")),
        ("previous_data", p.data_job.join("previous")),
        ("discarded_data", p.data_job.join("failed")),
        ("staged_data", p.data_job.join("next")),
    ];
    let recovery_locations = candidates
        .into_iter()
        .filter(|(_, path)| path.is_dir())
        .map(|(kind, path)| RecoveryLocation {
            kind: kind.into(),
            path,
        })
        .collect();
    InstallResult {
        state: p.phase.clone(),
        version: p.preview.version.clone(),
        previous_install: p
            .job
            .join("previous")
            .is_dir()
            .then(|| p.job.join("previous")),
        previous_data: p
            .data_job
            .join("previous")
            .is_dir()
            .then(|| p.data_job.join("previous")),
        recovery_locations,
        message: if p.phase == "committed" {
            "更新已完成。旧程序与原数据副本已保留；请手动重新打开 WorkPilot，中断任务不会自动继续。"
        } else {
            "上次更新没有完成，已恢复原程序与原数据。备份继续保留。"
        }
        .into(),
    }
}
pub(crate) fn steps(
    p: &mut Prepared,
    check_package: impl Fn(&Prepared) -> Result<()>,
    check_data: impl Fn(&Prepared, &Path) -> Result<()>,
    mut hook: impl FnMut(&str) -> Result<()>,
) -> Result<()> {
    if p.phase != "prepared" {
        return Err("此更新准备记录已使用，请重新准备。".into());
    }
    check_package(p)?;
    files::directory(&p.install)?;
    files::directory(&p.data)?;
    super::project_locations(&p.install, &p.data)?;
    let version = schema(&p.data)?;
    if version < p.manifest.database_min || version > p.manifest.database_target {
        return Err("现有数据版本不在签名更新支持范围内。".into());
    }
    checkpoint(p, "backing_up")?;
    hook(&p.phase)?;
    io(fs::create_dir(&p.data_job), "无法建立独立数据备份目录")?;
    let data_next = p.data_job.join("next");
    files::copy_tree(&p.data, &data_next)?;
    checkpoint(p, "checking_data")?;
    check_data(p, &data_next)?;
    checkpoint(p, "ready_to_switch")?;
    hook(&p.phase)?;
    // Persist the intent before each rename. Recovery also checks actual paths if power is lost between them.
    io(
        fs::rename(&p.install, p.job.join("previous")),
        "无法保留旧程序；请检查权限或仍在运行的实例",
    )?;
    checkpoint(p, "application_saved")?;
    hook(&p.phase)?;
    io(
        fs::rename(p.job.join("next"), &p.install),
        "无法启用新版程序",
    )?;
    checkpoint(p, "application_switched")?;
    hook(&p.phase)?;
    io(
        fs::rename(&p.data, p.data_job.join("previous")),
        "无法保留原数据",
    )?;
    checkpoint(p, "data_saved")?;
    hook(&p.phase)?;
    io(fs::rename(&data_next, &p.data), "无法启用迁移后的数据")?;
    checkpoint(p, "data_switched")?;
    hook(&p.phase)?;
    if let Some(old) = &p.previous_registered_version {
        super::super::registration::replace_version(&p.install, old, &p.preview.version)?;
    }
    checkpoint(p, "committed")?;
    Ok(())
}
fn rollback(p: &mut Prepared) -> Result<()> {
    check(p)?;
    for (old, current, failed) in [
        (
            p.data_job.join("previous"),
            p.data.clone(),
            p.data_job.join("failed"),
        ),
        (
            p.job.join("previous"),
            p.install.clone(),
            p.job.join("application-failed"),
        ),
    ] {
        if old.exists() {
            files::directory(&old)?;
            if current.exists() {
                files::directory(&current)?;
                io(
                    fs::rename(&current, &failed),
                    "恢复前无法保留未完成的新版本",
                )?;
            }
            io(
                fs::rename(&old, &current),
                "无法自动恢复，请使用升级目录中的恢复助手",
            )?;
        }
    }
    if let Some(old) = &p.previous_registered_version
        && let Err(error) =
            super::super::registration::replace_version(&p.install, &p.preview.version, old)
    {
        p.error = Some(format!("原程序和数据已恢复，但版本登记需要检查：{error}"));
    }
    checkpoint(p, "rolled_back")
}
pub fn recover(path: &Path) -> Result<InstallResult> {
    let mut p: Prepared = files::read_json(path)?;
    check(&p)?;
    let _installation = installation_lock(&p.install)?;
    let _operation = process_lock(&p)?;
    if p.phase != "committed" && p.phase != "rolled_back" {
        let _lock =
            data_update_lock(&p.data, true).map_err(|_| "上次更新仍在使用数据，暂时无法恢复。")?;
        if p.data.exists() {
            drop(super::lock_engine(&p.data)?);
        }
        rollback(&mut p)?;
    }
    Ok(result_info(&p))
}
pub fn recover_for_install(install: &Path) -> Result<Option<InstallResult>> {
    let path = pointer(install)?;
    if !path.exists() {
        return Ok(None);
    }
    let p: Prepared = files::read_json(&path)?;
    if p.install != install {
        return Err("上次升级记录与当前安装目录不一致。".into());
    }
    recover(&path).map(Some)
}
