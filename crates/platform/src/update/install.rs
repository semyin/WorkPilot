use super::{Manifest, Preview, Result, data_update_lock, files, io};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
pub(super) mod transaction;
pub use transaction::{InstallResult, apply, recover, recover_for_install};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Prepared {
    pub job: PathBuf,
    pub install: PathBuf,
    pub data: PathBuf,
    pub data_job: PathBuf,
    pub preview: Preview,
    pub manifest: Manifest,
    pub local_files: Vec<super::Entry>,
    pub previous_registered_version: Option<String>,
    pub proof: super::format::Envelope,
    pub phase: String,
    pub error: Option<String>,
}
pub(crate) fn pointer(install: &Path) -> Result<PathBuf> {
    let name = install.file_name().ok_or("安装目录无名称。")?;
    let key = format!("{:x}", Sha256::digest(name.to_string_lossy().as_bytes()));
    Ok(install
        .parent()
        .ok_or("安装目录无父目录。")?
        .join(format!(".workpilot-update-{}.json", &key[..24])))
}
pub fn prepare(
    install: &Path,
    data: &Path,
    source: &str,
    current: &str,
    expected: &str,
) -> Result<Prepared> {
    prepare_trusted(install, data, source, current, expected, super::TRUST)
}
pub(crate) fn prepare_trusted(
    install: &Path,
    data: &Path,
    source: &str,
    current: &str,
    expected: &str,
    trust: &str,
) -> Result<Prepared> {
    let install = files::directory(install)?;
    let data = files::directory(data)?;
    if data.starts_with(&install) || install.starts_with(&data) {
        return Err("升级需要程序目录与数据目录互相独立；当前目录未修改。".into());
    }
    project_locations(&install, &data)?;
    if pointer(&install)?.exists() {
        recover_for_install(&install)?;
    }
    let mut input = super::source::open(source)?;
    let proof = super::format::read_envelope(&mut input)?;
    let (preview, manifest) = super::format::verify(&proof, current, trust)?;
    if preview.fingerprint != expected {
        return Err("更新源在预览后变化，请重新检查。".into());
    }
    let id = uuid::Uuid::new_v4();
    let job = install
        .parent()
        .ok_or("安装目录无父目录。")?
        .join(format!(".workpilot-update-{id}"));
    let data_job = data
        .parent()
        .ok_or("数据目录无父目录。")?
        .join(format!(".workpilot-update-data-{id}"));
    io(fs::create_dir(&job), "无法准备更新目录")?;
    let next = job.join("next");
    io(fs::create_dir(&next), "无法暂存新版程序")?;
    let result = (|| {
        for file in &manifest.files {
            let path = next.join(&file.path);
            io(
                fs::create_dir_all(path.parent().unwrap()),
                "无法创建更新子目录",
            )?;
            let mut output = io(
                OpenOptions::new().create_new(true).write(true).open(path),
                "无法暂存更新文件",
            )?;
            let mut hash = Sha256::new();
            let mut left = file.bytes;
            let mut buffer = [0; 65536];
            while left > 0 {
                let count = left.min(buffer.len() as u64) as usize;
                io(
                    input.read_exact(&mut buffer[..count]),
                    "更新下载中断或文件被截断",
                )?;
                io(output.write_all(&buffer[..count]), "无法保存更新文件")?;
                hash.update(&buffer[..count]);
                left -= count as u64;
            }
            io(output.sync_all(), "无法完整保存更新文件")?;
            if format!("{:x}", hash.finalize()) != file.sha256 {
                return Err("更新文件摘要不匹配；没有修改当前安装。".into());
            }
        }
        let mut end = [0];
        if io(input.read(&mut end), "无法核对更新包尾部")? != 0 {
            return Err("更新包含有未签名的附加内容。".into());
        }
        Ok(())
    })();
    if let Err(error) = result {
        files::write_json(
            &job.join("failure.json"),
            &serde_json::json!({"state":"prepare_failed","error":error}),
        )?;
        return Err(error);
    }
    let mut local_files = Vec::new();
    for path in super::registration::LOCAL_FILES {
        if manifest
            .files
            .iter()
            .any(|f| f.path.eq_ignore_ascii_case(path))
        {
            return Err("程序更新包不能替换本机卸载入口或已生成的浏览器连接记录。".into());
        }
        let original = install.join(path);
        if original.exists() {
            let (bytes, sha256) = files::hash_file(&original)?;
            if bytes > 32 * 1024 * 1024 {
                return Err("本机安装登记文件异常，更新未安装。".into());
            }
            let destination = next.join(path);
            io(
                fs::create_dir_all(destination.parent().unwrap()),
                "无法保留安装登记目录",
            )?;
            io(
                fs::copy(&original, &destination),
                "无法保留当前卸载入口或浏览器连接记录",
            )?;
            local_files.push(super::Entry {
                path: (*path).into(),
                bytes,
                sha256,
            });
        }
    }
    let previous_registered_version = super::registration::owned_version(&install)?;
    let prepared = Prepared {
        job,
        install,
        data,
        data_job,
        preview,
        manifest,
        local_files,
        previous_registered_version,
        proof,
        phase: "prepared".into(),
        error: None,
    };
    files::write_json(&prepared.job.join("prepared.json"), &prepared)?;
    Ok(prepared)
}
pub(crate) fn check(prepared: &Prepared) -> Result<()> {
    files::directory(&prepared.job)?;
    if prepared.job.parent() != prepared.install.parent()
        || !prepared
            .job
            .file_name()
            .is_some_and(|n| n.to_string_lossy().starts_with(".workpilot-update-"))
        || prepared.data.starts_with(&prepared.install)
        || prepared.install.starts_with(&prepared.data)
    {
        return Err("升级工作目录与安装位置不匹配。".into());
    }
    let name = prepared
        .job
        .file_name()
        .ok_or("升级工作目录无名称。")?
        .to_string_lossy();
    let suffix = name
        .strip_prefix(".workpilot-update-")
        .ok_or("升级工作目录不正确。")?;
    uuid::Uuid::parse_str(suffix).map_err(|_| "升级工作目录编号不正确。")?;
    if prepared.data_job
        != prepared
            .data
            .parent()
            .ok_or("数据目录无父目录。")?
            .join(format!(".workpilot-update-data-{suffix}"))
    {
        return Err("升级数据副本位置不正确。".into());
    }
    Ok(())
}
pub(crate) fn verify_stage(p: &Prepared) -> Result<()> {
    verify_stage_trusted(p, super::TRUST)
}
pub(crate) fn verify_stage_trusted(p: &Prepared, trust: &str) -> Result<()> {
    let (preview, manifest) = super::format::verify(&p.proof, &p.preview.current_version, trust)?;
    if preview.fingerprint != p.preview.fingerprint
        || serde_json::to_value(manifest).ok() != serde_json::to_value(&p.manifest).ok()
    {
        return Err("暂存更新清单与已验证签名不符。".into());
    }
    let next = p.job.join("next");
    files::directory(&next)?;
    if p.local_files.len() > super::registration::LOCAL_FILES.len()
        || p.local_files
            .iter()
            .any(|f| !super::registration::LOCAL_FILES.contains(&f.path.as_str()))
    {
        return Err("本机保留登记范围不正确。".into());
    }
    for file in p.manifest.files.iter().chain(&p.local_files) {
        if !super::format::path_ok(&file.path)
            || files::hash_file(&next.join(&file.path))? != (file.bytes, file.sha256.clone())
        {
            return Err("准备好的更新发生变化，请重新准备。".into());
        }
    }
    for local in &p.local_files {
        if files::hash_file(&p.install.join(&local.path))? != (local.bytes, local.sha256.clone()) {
            return Err("本机卸载入口或浏览器登记在准备后变化，请重新准备。".into());
        }
    }
    let allowed: std::collections::BTreeSet<_> = p
        .manifest
        .files
        .iter()
        .chain(&p.local_files)
        .map(|f| f.path.as_str())
        .collect();
    let mut stack = vec![next.clone()];
    let mut found = 0usize;
    while let Some(directory) = stack.pop() {
        for entry in io(fs::read_dir(directory), "无法完整核对暂存目录")? {
            let entry = io(entry, "无法核对暂存条目")?;
            let path = entry.path();
            let name = path
                .strip_prefix(&next)
                .map_err(|_| "暂存路径越界。")?
                .to_string_lossy()
                .replace('\\', "/");
            let meta = files::no_link(&path)?;
            if meta.is_dir() {
                if !allowed
                    .iter()
                    .any(|item| item.starts_with(&(name.clone() + "/")))
                {
                    return Err("暂存目录包含未签名的额外目录。".into());
                }
                stack.push(path);
            } else if meta.is_file() && allowed.contains(name.as_str()) {
                found += 1;
            } else {
                return Err("暂存目录包含未签名的额外文件。".into());
            }
        }
    }
    if found != allowed.len() {
        return Err("暂存目录与签名清单不完整对应。".into());
    }
    Ok(())
}
pub(crate) fn lock_engine(data: &Path) -> Result<File> {
    let lock = io(
        OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .read(true)
            .open(data.join("engine.lock")),
        "无法锁定原数据",
    )?;
    lock.try_lock()
        .map_err(|_| "另一 WorkPilot 实例仍在使用数据，请关闭它后重试。")?;
    Ok(lock)
}
pub(crate) fn project_locations(install: &Path, data: &Path) -> Result<()> {
    let db = rusqlite::Connection::open_with_flags(
        data.join("workpilot.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|_| "无法核对项目位置。")?;
    let exists: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects')",
            [],
            |r| r.get(0),
        )
        .map_err(|_| "无法核对项目目录。")?;
    if !exists {
        return Ok(());
    }
    let mut query = db
        .prepare("SELECT root_path FROM projects")
        .map_err(|_| "无法核对项目目录。")?;
    let rows = query
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|_| "无法核对项目目录。")?;
    for path in rows {
        let path = PathBuf::from(path.map_err(|_| "无法读取项目位置。")?);
        if let Ok(real) = path.canonicalize()
            && (real.starts_with(install) || real.starts_with(data))
        {
            return Err("有项目保存在程序或应用数据目录内部。请先迁出该项目，再更新；本次不会移动项目文件。".into());
        }
    }
    Ok(())
}
