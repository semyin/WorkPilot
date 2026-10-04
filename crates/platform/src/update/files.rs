use super::{Result, io};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub(crate) fn no_link(path: &Path) -> Result<fs::Metadata> {
    let meta = io(fs::symlink_metadata(path), "无法核对更新路径")?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err("更新路径不能是链接或重解析目录。".into());
        }
    }
    if meta.file_type().is_symlink() {
        return Err("更新路径不能是符号链接。".into());
    }
    Ok(meta)
}
pub(crate) fn directory(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() || !no_link(path)?.is_dir() {
        return Err("更新需要完整的本机目录。".into());
    }
    let real = io(path.canonicalize(), "无法定位更新目录")?;
    for ancestor in path.ancestors() {
        if ancestor.exists() {
            no_link(ancestor)?;
        }
    }
    Ok(real)
}
pub(crate) fn regular(path: &Path) -> Result<()> {
    if !no_link(path)?.is_file() {
        return Err("更新输入必须是普通文件。".into());
    }
    if let Some(parent) = path.parent() {
        directory(parent)?;
    }
    Ok(())
}
pub(crate) fn hash_file(path: &Path) -> Result<(u64, String)> {
    regular(path)?;
    let mut input = io(File::open(path), "无法读取更新文件")?;
    let mut hash = Sha256::new();
    let mut count = 0;
    let mut buffer = [0; 65536];
    loop {
        let n = io(input.read(&mut buffer), "无法读取更新内容")?;
        if n == 0 {
            break;
        }
        count += n as u64;
        hash.update(&buffer[..n]);
    }
    Ok((count, format!("{:x}", hash.finalize())))
}
pub(crate) fn write_json(path: &Path, value: &impl serde::Serialize) -> Result<()> {
    let next = path.with_extension(format!("{}-tmp", uuid::Uuid::new_v4()));
    let mut out = io(
        OpenOptions::new().create_new(true).write(true).open(&next),
        "无法写入升级记录",
    )?;
    serde_json::to_writer(&mut out, value).map_err(|_| "无法保存升级记录。")?;
    io(out.flush(), "无法保存升级记录")?;
    io(out.sync_all(), "无法保存升级记录")?;
    drop(out);
    // Windows rename cannot replace an existing target; ReplaceFile preserves the last record atomically.
    #[cfg(windows)]
    if path.exists() {
        use std::os::windows::ffi::OsStrExt;
        let target: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let temp: Vec<u16> = next.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            if windows_sys::Win32::Storage::FileSystem::ReplaceFileW(
                target.as_ptr(),
                temp.as_ptr(),
                std::ptr::null(),
                0,
                std::ptr::null(),
                std::ptr::null(),
            ) == 0
            {
                return Err("无法原子保存升级记录；请保留本机备份。".into());
            }
        }
        return Ok(());
    }
    io(fs::rename(next, path), "无法保存升级记录")
}
pub(crate) fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    regular(path)?;
    if no_link(path)?.len() > 16 * 1024 * 1024 {
        return Err("更新记录过大。".into());
    }
    serde_json::from_slice(&io(fs::read(path), "无法读取升级记录")?)
        .map_err(|_| "升级记录格式错误。".into())
}
pub(crate) fn copy_tree(source: &Path, target: &Path) -> Result<(u64, u64)> {
    directory(source)?;
    io(fs::create_dir(target), "无法建立升级数据副本")?;
    let mut files = 0;
    let mut bytes = 0;
    let mut stack = vec![(source.to_path_buf(), target.to_path_buf())];
    while let Some((src, dst)) = stack.pop() {
        for entry in io(fs::read_dir(src), "无法读取升级备份目录")? {
            let entry = io(entry, "无法读取备份条目")?;
            let from = entry.path();
            // This is a process coordination file, not stored user data. The updater
            // deliberately owns its byte-range lock while copying the database.
            if from == source.join("engine.lock") {
                continue;
            }
            let to = dst.join(entry.file_name());
            let meta = no_link(&from)?;
            if meta.is_dir() {
                io(fs::create_dir(&to), "无法建立备份子目录")?;
                stack.push((from, to));
            } else if meta.is_file() {
                files += 1;
                bytes += meta.len();
                if files > 250000 || bytes > 64 * 1024 * 1024 * 1024 {
                    return Err("本机数据超出本版升级备份容量（25 万文件 / 64 GiB）。".into());
                }
                let before = hash_file(&from)?;
                let mut input = io(File::open(&from), "无法读取升级数据")?;
                let mut output = io(
                    OpenOptions::new().create_new(true).write(true).open(&to),
                    "无法建立升级数据副本",
                )?;
                io(
                    std::io::copy(&mut input, &mut output),
                    "无法完整复制升级数据",
                )?;
                io(output.sync_all(), "无法落盘升级副本")?;
                drop(output);
                io(
                    fs::set_permissions(&to, meta.permissions()),
                    "无法保留数据文件属性",
                )?;
                if before != hash_file(&to)? || before != hash_file(&from)? {
                    return Err("数据在备份期间变化，升级已停止。".into());
                }
            } else {
                return Err("数据包含本版不支持的特殊文件；升级已停止。".into());
            }
        }
    }
    Ok((files, bytes))
}
