use crate::{Result, digest};
use std::{
    collections::{BTreeMap, HashSet},
    io::{Cursor, Read, Write},
    path::{Component, Path},
};
use workpilot_contracts::*;
pub type Contents = BTreeMap<String, Vec<u8>>;
pub const MAX_FILES: usize = 512;
pub const MAX_FILE: usize = 8 * 1024 * 1024;
pub const MAX_PACKAGE: usize = 32 * 1024 * 1024;
pub fn slug(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && !s.starts_with('-')
        && !s.ends_with('-')
        && !s.contains("--")
        && s.bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}
pub fn relative(s: &str) -> Result<()> {
    if s.is_empty()
        || s.len() > 1024
        || s.contains(['\\', ':', '\0'])
        || s.starts_with('/')
        || s.ends_with('/')
        || Path::new(s)
            .components()
            .any(|p| !matches!(p, Component::Normal(_)))
    {
        return Err("扩展文件必须使用包内相对路径，不能包含链接、绝对路径或上级目录。".into());
    }
    for p in s.split('/') {
        if p.is_empty() || p == "." || p == ".." {
            return Err("扩展路径不能包含空片段或点路径。".into());
        }
        let lower = p.to_ascii_lowercase();
        let stem = lower.split('.').next().unwrap_or("");
        if p.ends_with([' ', '.'])
            || p.chars().any(|c| c.is_control() || "<>\"|?*".contains(c))
            || [
                "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7",
                "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8",
                "lpt9",
            ]
            .contains(&stem)
        {
            return Err("文件名不能在目标系统中安全使用。".into());
        }
        if matches!(
            lower.as_str(),
            ".git" | ".ssh" | ".secrets" | "credentials.json" | "cookies.sqlite"
        ) || lower == ".env"
            || lower.starts_with(".env.")
            || [".pem", ".key", ".pfx", ".p12"]
                .iter()
                .any(|v| lower.ends_with(v))
        {
            return Err("扩展包不能夹带凭据文件；请使用单独的认证设置。".into());
        }
    }
    Ok(())
}
fn insert(files: &mut Contents, name: String, bytes: Vec<u8>) -> Result<()> {
    relative(&name)?;
    if files.len() >= MAX_FILES
        || bytes.len() > MAX_FILE
        || files.values().map(Vec::len).sum::<usize>() + bytes.len() > MAX_PACKAGE
    {
        return Err("扩展包超过 512 文件、单文件 8 MiB 或总计 32 MiB 上限。".into());
    }
    if files.keys().any(|p| p.eq_ignore_ascii_case(&name)) {
        return Err("扩展包包含重复或大小写冲突文件名。".into());
    }
    if let Ok(text) = std::str::from_utf8(&bytes)
        && (text.contains("-----BEGIN PRIVATE KEY-----")
            || text.contains("-----BEGIN RSA PRIVATE KEY-----")
            || text.contains("-----BEGIN OPENSSH PRIVATE KEY-----")
            || text.contains("-----BEGIN EC PRIVATE KEY-----"))
    {
        return Err("扩展内容含私钥，不能导入。".into());
    }
    files.insert(name, bytes);
    Ok(())
}
fn is_link(meta: &std::fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}
pub fn directory(root: &Path) -> Result<Contents> {
    fn walk(
        root: &Path,
        dir: &Path,
        files: &mut Contents,
        depth: usize,
        entries: &mut usize,
    ) -> Result<()> {
        if depth > 12 {
            return Err("扩展目录嵌套过深。".into());
        }
        for entry in std::fs::read_dir(dir).map_err(|_| "无法读取扩展目录。")? {
            *entries += 1;
            if *entries > MAX_FILES * 2 {
                return Err("扩展目录条目过多。".into());
            }
            let entry = entry.map_err(|_| "无法读取扩展文件。")?;
            let path = entry.path();
            let meta = std::fs::symlink_metadata(&path).map_err(|_| "扩展文件已变化。")?;
            if is_link(&meta) {
                return Err("扩展包不接受符号链接或目录联接。".into());
            }
            let name = path
                .strip_prefix(root)
                .map_err(|_| "扩展路径越界。")?
                .to_str()
                .ok_or("文件名不是 UTF-8。")?
                .replace('\\', "/");
            relative(&name)?;
            if meta.is_dir() {
                walk(root, &path, files, depth + 1, entries)?;
            } else if meta.is_file() {
                if meta.len() > MAX_FILE as u64 {
                    return Err("扩展单文件超过 8 MiB。".into());
                }
                let mut bytes = vec![];
                std::fs::File::open(path)
                    .map_err(|_| "无法读取扩展文件。")?
                    .take((MAX_FILE + 1) as u64)
                    .read_to_end(&mut bytes)
                    .map_err(|_| "扩展读取失败。")?;
                insert(files, name, bytes)?;
            } else {
                return Err("扩展只允许普通文件。".into());
            }
        }
        Ok(())
    }
    if is_link(&std::fs::symlink_metadata(root).map_err(|_| "找不到扩展目录。")?) {
        return Err("扩展根目录不能是链接。".into());
    }
    let root = root.canonicalize().map_err(|_| "找不到扩展目录。")?;
    let mut files = Contents::new();
    walk(&root, &root, &mut files, 0, &mut 0)?;
    Ok(files)
}
pub fn unpack(bytes: &[u8]) -> Result<Contents> {
    if bytes.len() > MAX_PACKAGE {
        return Err("压缩包超过 32 MiB。".into());
    }
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "扩展包不是有效 ZIP。")?;
    if zip.len() > MAX_FILES * 2 {
        return Err("压缩包条目过多。".into());
    }
    let mut files = Contents::new();
    for i in 0..zip.len() {
        let mut file = zip
            .by_index(i)
            .map_err(|_| "压缩包损坏或使用不支持的加密。")?;
        if file.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000) {
            return Err("压缩包中存在符号链接。".into());
        }
        let name = file.name().to_owned();
        if file.is_dir() {
            relative(name.trim_end_matches('/'))?;
            continue;
        }
        if file.size() > MAX_FILE as u64 {
            return Err("压缩包展开后单文件超限。".into());
        }
        let mut bytes = vec![];
        file.by_ref()
            .take((MAX_FILE + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| "压缩包读取失败。")?;
        insert(&mut files, name, bytes)?;
    }
    // A single wrapper folder is common in a downloaded source archive.
    if !files.contains_key("workpilot-plugin.json") && !files.contains_key("SKILL.md") {
        let prefix = files
            .keys()
            .next()
            .and_then(|p| p.split_once('/'))
            .map(|(p, _)| format!("{p}/"));
        if let Some(prefix) = prefix.filter(|p| files.keys().all(|f| f.starts_with(p))) {
            files = files
                .into_iter()
                .map(|(p, b)| (p[prefix.len()..].to_owned(), b))
                .collect();
        }
    }
    Ok(files)
}
pub fn zip(files: &Contents) -> Result<Vec<u8>> {
    let mut zip = zip::ZipWriter::new(Cursor::new(vec![]));
    for (path, bytes) in files {
        zip.start_file(
            path,
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )
        .map_err(|_| "无法创建扩展包。")?;
        zip.write_all(bytes).map_err(|_| "无法写入扩展包。")?;
    }
    Ok(zip.finish().map_err(|_| "无法完成扩展包。")?.into_inner())
}
fn metadata(path: &str, text: &str) -> Result<SkillMetadata> {
    if text.len() > 256 * 1024 {
        return Err("SKILL.md 超过 256 KiB。".into());
    }
    let normalized = text.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let body = normalized
        .strip_prefix("---\n")
        .ok_or("SKILL.md 缺少 YAML 说明头。")?;
    let (header, _) = body
        .split_once("\n---")
        .ok_or("SKILL.md 说明头没有结束标记。")?;
    if header.len() > 16384 {
        return Err("技能说明头过大。".into());
    }
    let v: serde_json::Value =
        serde_yaml_ng::from_str(header).map_err(|_| "技能 YAML 说明头格式错误。")?;
    let name = v["name"].as_str().ok_or("技能缺少 name。")?;
    let description = v["description"].as_str().ok_or("技能缺少 description。")?;
    if !slug(name) || description.trim().is_empty() || description.chars().count() > 1024 {
        return Err("技能名称须为短横线分隔的小写名称，说明须为 1—1024 字符。".into());
    }
    if path != "SKILL.md"
        && Path::new(path)
            .parent()
            .and_then(Path::file_name)
            .and_then(|p| p.to_str())
            != Some(name)
    {
        return Err("技能名称与所在文件夹不一致。".into());
    }
    Ok(SkillMetadata {
        name: name.into(),
        description: description.into(),
        path: path.into(),
        license: v["license"].as_str().map(str::to_owned),
        compatibility: v["compatibility"].as_str().map(str::to_owned),
        allowed_tools: v["allowed-tools"].as_str().map(str::to_owned),
    })
}
pub fn validate(mut files: Contents) -> Result<(PluginVersion, Contents)> {
    let mut checked = Contents::new();
    for (path, bytes) in files {
        insert(&mut checked, path, bytes)?;
    }
    files = checked;
    if files.is_empty() {
        return Err("扩展包为空。".into());
    }
    let mut skills = vec![];
    let manifest: PluginManifest = if let Some(raw) = files.get("workpilot-plugin.json") {
        if raw.len() > 128 * 1024 {
            return Err("扩展清单过大。".into());
        }
        serde_json::from_slice(raw)
            .map_err(|_| "workpilot-plugin.json 格式不符合 WorkPilot 扩展清单。")?
    } else if let Some(raw) = files.get("SKILL.md") {
        let skill = metadata(
            "SKILL.md",
            std::str::from_utf8(raw).map_err(|_| "技能说明不是 UTF-8。")?,
        )?;
        PluginManifest {
            format: 1,
            id: skill.name.clone(),
            name: skill.name,
            version: "1.0.0".into(),
            description: skill.description,
            skills: vec![".".into()],
            servers: vec![],
            dependencies: vec![],
        }
    } else {
        return Err("请选择含 SKILL.md 或 workpilot-plugin.json 的目录/ZIP 包。".into());
    };
    if manifest.format != 1
        || !slug(&manifest.id)
        || manifest.name.trim().is_empty()
        || manifest.name.len() > 200
        || manifest.description.len() > 4096
        || semver::Version::parse(&manifest.version).is_err()
        || manifest.skills.len() > 64
        || manifest.servers.len() > 16
        || manifest.dependencies.len() > 32
    {
        return Err("扩展清单名称、版本、格式或条目数量无效。".into());
    }
    let mut skill_names = HashSet::new();
    for path in &manifest.skills {
        let path = if path == "." {
            "SKILL.md".to_owned()
        } else {
            relative(path)?;
            format!("{path}/SKILL.md")
        };
        let bytes = files
            .get(&path)
            .ok_or_else(|| format!("技能缺少说明文件：{path}"))?;
        let skill = metadata(
            &path,
            std::str::from_utf8(bytes).map_err(|_| "技能说明不是 UTF-8。")?,
        )?;
        if !skill_names.insert(skill.name.clone()) {
            return Err("扩展包有重名技能。".into());
        }
        skills.push(skill);
    }
    let mut ids = HashSet::new();
    let mut permissions =
        vec!["读取已启用技能的说明与包内资源 / Read enabled skill resources".into()];
    for server in &manifest.servers {
        if !slug(&server.id)
            || !ids.insert(&server.id)
            || server.name.is_empty()
            || server.name.len() > 200
        {
            return Err("MCP 服务名称或编号无效/重复。".into());
        }
        match &server.transport {
            McpTransport::Stdio {
                runtime,
                entry,
                args,
                secret_env,
            } => {
                relative(entry)?;
                if !files.contains_key(entry) {
                    return Err(format!("缺少本地服务入口：{entry}"));
                }
                if args.len() > 32
                    || args.iter().any(|v| v.len() > 8192 || v.contains('\0'))
                    || secret_env.len() > 16
                    || secret_env.iter().any(|v| !environment_name(v))
                {
                    return Err("本地服务参数或凭据环境变量无效。".into());
                }
                permissions.push(format!("运行本地 MCP 进程：{}，{:?}；审批模式限制到项目，完全访问使用账户权限 / Local process",server.name,runtime));
            }
            McpTransport::Http { url, .. } => {
                crate::mcp::endpoint(url)?;
                permissions.push(format!("连接远程工具服务 / Network: {url}"));
            }
        }
    }
    for dependency in &manifest.dependencies {
        if !slug(&dependency.id) || semver::VersionReq::parse(&dependency.version).is_err() {
            return Err("依赖名称或版本范围无效。".into());
        }
    }
    if files
        .keys()
        .any(|p| p.contains("/scripts/") || p.starts_with("scripts/"))
    {
        permissions.push(
            "运行技能脚本时需要任务执行模式与相应审批 / Skill scripts require execution approval"
                .into(),
        );
    }
    let mut warnings = vec![];
    if skills.iter().any(|s| s.allowed_tools.is_some()) {
        warnings.push("allowed-tools 仅作技能说明，不授予平台权限。".into());
    }
    warnings.push("安装不运行脚本、不自动下载依赖；MCP 描述与网页一样不能提升任务权限。".into());
    files.insert(
        "workpilot-plugin.json".into(),
        serde_json::to_vec_pretty(&manifest).map_err(|_| "清单编码失败。")?,
    );
    let index: Vec<PluginFile> = files
        .iter()
        .map(|(p, b)| PluginFile {
            path: p.clone(),
            bytes: b.len() as u64,
            sha256: digest(b),
        })
        .collect();
    let hash = digest(&serde_json::to_vec(&index).map_err(|_| "无法计算扩展摘要。")?);
    Ok((
        PluginVersion {
            digest: hash,
            manifest,
            skills,
            files: index,
            permissions,
            warnings,
            created_at_ms: workpilot_storage::now_ms(),
        },
        files,
    ))
}
pub fn environment_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
        && ![
            "PATH",
            "HOME",
            "USERPROFILE",
            "SYSTEMROOT",
            "WINDIR",
            "COMSPEC",
            "TEMP",
            "TMP",
            "APPDATA",
            "LOCALAPPDATA",
            "NODE_OPTIONS",
            "NODE_PATH",
            "PYTHONPATH",
            "PYTHONHOME",
            "LD_PRELOAD",
            "LD_LIBRARY_PATH",
        ]
        .contains(&name)
}
pub fn read_verified(root: &Path, version: &PluginVersion, path: &str) -> Result<Vec<u8>> {
    if is_link(&std::fs::symlink_metadata(root).map_err(|_| "扩展安装目录缺失。")?) {
        return Err("扩展目录已被替换为链接。".into());
    }
    relative(path)?;
    let file = version
        .files
        .iter()
        .find(|v| v.path == path)
        .ok_or("文件不在已确认的扩展包中。")?;
    let mut current = root.to_path_buf();
    for part in Path::new(path).components() {
        current.push(part);
        let meta = std::fs::symlink_metadata(&current).map_err(|_| "扩展文件缺失。")?;
        if is_link(&meta) {
            return Err("扩展路径已被替换为链接。".into());
        }
    }
    let mut bytes = vec![];
    std::fs::File::open(current)
        .map_err(|_| "无法读取扩展文件。")?
        .take((MAX_FILE + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "扩展读取失败。")?;
    if bytes.len() as u64 != file.bytes || digest(&bytes) != file.sha256 {
        return Err("扩展文件已变化，请重新预览并确认安装。".into());
    }
    Ok(bytes)
}
pub fn write_new(root: &Path, files: &Contents) -> Result<()> {
    std::fs::create_dir(root).map_err(|_| "无法创建扩展暂存目录。")?;
    for (path, bytes) in files {
        relative(path)?;
        let dest = root.join(path);
        std::fs::create_dir_all(dest.parent().ok_or("无效包路径。")?)
            .map_err(|_| "无法创建包内目录。")?;
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(dest)
            .map_err(|_| "无法保存扩展文件。")?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "扩展落盘失败。")?;
    }
    Ok(())
}
