//! Bounded binary snapshots and complete-file replacement through directory handles.
use crate::files::{Error, Result, Root, no_link, relative};
use cap_std::fs::OpenOptions;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    path::Path,
};
use workpilot_contracts::FileVersion;
pub const MAX_VERSION_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_TREE_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_TREE_FILES: usize = 4096;
pub const EXCLUDED: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    ".venv",
    ".cache",
    ".local",
    ".workpilot-data",
    ".test-results",
];
pub struct BinarySnapshot {
    pub version: FileVersion,
    pub bytes: Vec<u8>,
}
pub fn absent() -> FileVersion {
    FileVersion {
        exists: false,
        sha256: None,
        bytes: 0,
        identity: None,
    }
}
pub fn user_path(path: &str) -> Result<()> {
    let path = relative(path, false)?;
    if path
        .components()
        .any(|c| c.as_os_str().to_string_lossy().eq_ignore_ascii_case(".git"))
    {
        return Err(Error::Rejected(
            "Git internals cannot be edited as project files",
        ));
    }
    Ok(())
}
impl Root {
    pub fn binary_snapshot(&self, path: &str) -> Result<BinarySnapshot> {
        let (dir, name) = self.parent(path)?;
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.share_mode(1);
        }
        let mut file = match dir.open_with(&name, &options) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(BinarySnapshot {
                    version: absent(),
                    bytes: vec![],
                });
            }
            Err(e) => return Err(e.into()),
        };
        let meta = file.metadata()?;
        no_link(&meta)?;
        if !meta.is_file() || meta.len() > MAX_VERSION_BYTES {
            return Err(Error::Rejected(
                "version capture requires a regular file of at most 64 MiB",
            ));
        }
        let (identity, links) = workpilot_platform::files::identity(&file.try_clone()?.into_std())?;
        if links != 1 {
            return Err(Error::Rejected("linked files are not accepted"));
        }
        let mut bytes = Vec::with_capacity(meta.len() as usize);
        Read::by_ref(&mut file)
            .take(MAX_VERSION_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 != meta.len() || file.metadata()?.modified()? != meta.modified()? {
            return Err(Error::Rejected("file changed during version capture"));
        }
        Ok(BinarySnapshot {
            version: FileVersion {
                exists: true,
                sha256: Some(format!("{:x}", Sha256::digest(&bytes))),
                bytes: bytes.len() as u64,
                identity: Some(identity),
            },
            bytes,
        })
    }
    pub fn tracked_paths(&self) -> Result<Vec<String>> {
        let mut queue = vec![(String::new(), self.dir.try_clone()?)];
        let mut result = vec![];
        let mut dirs = 0;
        while let Some((parent, dir)) = queue.pop() {
            dirs += 1;
            if dirs > 1024 {
                return Err(Error::Rejected("project exceeds 1024 directories"));
            }
            for entry in dir.entries()? {
                let entry = entry?;
                let name = entry
                    .file_name()
                    .into_string()
                    .map_err(|_| Error::Rejected("file names must be UTF-8"))?;
                if EXCLUDED.iter().any(|e| e.eq_ignore_ascii_case(&name))
                    || name.starts_with(".workpilot-tmp-")
                {
                    continue;
                }
                let meta = dir.symlink_metadata(&name)?;
                no_link(&meta)?;
                let path = if parent.is_empty() {
                    name.clone()
                } else {
                    format!("{parent}/{name}")
                };
                relative(&path, false)?;
                if meta.is_dir() {
                    queue.push((path, dir.open_dir(&name)?));
                } else if meta.is_file() {
                    result.push(path);
                    if result.len() > MAX_TREE_FILES {
                        return Err(Error::Rejected("project exceeds 4096 managed files"));
                    }
                } else {
                    return Err(Error::Rejected(
                        "special files are not supported in a managed project",
                    ));
                }
            }
        }
        result.sort();
        Ok(result)
    }
    pub fn version_inventory(&self) -> Result<BTreeMap<String, FileVersion>> {
        let mut files = BTreeMap::new();
        let mut total = 0;
        for path in self.tracked_paths()? {
            let file = self.binary_snapshot(&path)?;
            total += file.version.bytes;
            if total > MAX_TREE_BYTES {
                return Err(Error::Rejected("project exceeds 256 MiB snapshot budget"));
            }
            files.insert(path, file.version);
        }
        Ok(files)
    }
    pub fn replace_bytes(
        &self,
        path: &str,
        expected: &FileVersion,
        bytes: &[u8],
    ) -> Result<FileVersion> {
        user_path(path)?;
        if bytes.len() as u64 > MAX_VERSION_BYTES {
            return Err(Error::Rejected("file exceeds 64 MiB version limit"));
        }
        let (dir, name) = self.parent(path)?;
        if &self.binary_snapshot(path)?.version != expected {
            return Err(Error::Rejected(
                "file changed; reload before saving or restoring",
            ));
        }
        let temp = format!(".workpilot-tmp-{}", uuid::Uuid::new_v4());
        let result = (|| {
            let mut opts = OpenOptions::new();
            opts.write(true).create_new(true);
            #[cfg(windows)]
            {
                use cap_std::fs::OpenOptionsExt;
                // GENERIC_WRITE | WRITE_DAC, needed to preserve the original file's ACL.
                opts.access_mode(0x4000_0000 | 0x0004_0000);
            }
            let mut file = dir.open_with(&temp, &opts)?;
            if expected.exists {
                workpilot_platform::files::copy_access(
                    &dir.open(&name)?.into_std(),
                    &file.try_clone()?.into_std(),
                )?;
            }
            file.write_all(bytes)?;
            file.sync_all()?;
            drop(file);
            // Check again after the complete replacement has reached stable storage.
            if &self.binary_snapshot(path)?.version != expected {
                return Err(Error::Rejected("file changed while preparing replacement"));
            }
            if expected.exists {
                dir.rename(&temp, &dir, &name)?;
            } else {
                dir.hard_link(&temp, &dir, &name)?;
                dir.remove_file(&temp)?;
            }
            #[cfg(unix)]
            dir.try_clone()?.into_std_file().sync_all()?;
            Ok(self.binary_snapshot(path)?.version)
        })();
        let _ = dir.remove_file(&temp);
        result
    }
    pub fn delete_version(&self, path: &str, expected: &FileVersion) -> Result<()> {
        user_path(path)?;
        if !expected.exists || &self.binary_snapshot(path)?.version != expected {
            return Err(Error::Rejected("file changed; reload before deleting"));
        }
        let (dir, name) = self.parent(path)?;
        dir.remove_file(name)?;
        Ok(())
    }
    pub fn rename_version(
        &self,
        path: &str,
        destination: &str,
        expected: &FileVersion,
    ) -> Result<()> {
        user_path(path)?;
        user_path(destination)?;
        if !expected.exists || &self.binary_snapshot(path)?.version != expected {
            return Err(Error::Rejected("file changed; reload before renaming"));
        }
        let (from, name) = self.parent(path)?;
        let (to, new_name) = self.parent(destination)?;
        // Create the destination without replacement, including on Windows.
        // A temporary second link is removed before exposing success.
        if Path::new(path) == Path::new(destination) {
            return Err(Error::Rejected("rename needs a different path"));
        }
        from.hard_link(&name, &to, &new_name)?;
        if let Err(error) = from.remove_file(&name) {
            let _ = to.remove_file(&new_name);
            return Err(error.into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn binary_versions_reject_conflicts_and_keep_complete_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let root = Root::open(dir.path().to_str().unwrap(), None).unwrap();
        let data = vec![0xff; 3 * 1024 * 1024];
        let v = root
            .replace_bytes("中文 空格.bin", &absent(), &data)
            .unwrap();
        assert_eq!(root.binary_snapshot("中文 空格.bin").unwrap().bytes, data);
        std::fs::write(dir.path().join("中文 空格.bin"), b"external").unwrap();
        assert!(root.replace_bytes("中文 空格.bin", &v, b"wrong").is_err());
        let current = root.binary_snapshot("中文 空格.bin").unwrap().version;
        root.rename_version("中文 空格.bin", "rename.bin", &current)
            .unwrap();
        assert!(
            !root
                .binary_snapshot("中文 空格.bin")
                .unwrap()
                .version
                .exists
        );
        let renamed = root.binary_snapshot("rename.bin").unwrap();
        assert_eq!(renamed.bytes, b"external");
        root.delete_version("rename.bin", &renamed.version).unwrap();
        assert!(!root.binary_snapshot("rename.bin").unwrap().version.exists);
    }
    #[test]
    fn new_file_and_rename_never_replace_existing_destination() {
        let dir = tempfile::tempdir().unwrap();
        let root = Root::open(dir.path().to_str().unwrap(), None).unwrap();
        let a = root.replace_bytes("a.txt", &absent(), b"a").unwrap();
        root.replace_bytes("b.txt", &absent(), b"b").unwrap();
        assert!(root.replace_bytes("b.txt", &absent(), b"wrong").is_err());
        assert!(root.rename_version("a.txt", "b.txt", &a).is_err());
        assert_eq!(root.binary_snapshot("a.txt").unwrap().bytes, b"a");
        assert_eq!(root.binary_snapshot("b.txt").unwrap().bytes, b"b");
        assert!(
            root.replace_bytes(".git/config", &absent(), b"bad")
                .is_err()
        );
    }
    #[cfg(unix)]
    #[test]
    fn replacement_preserves_private_executable_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("private.sh");
        std::fs::write(&path, b"before").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let root = Root::open(dir.path().to_str().unwrap(), None).unwrap();
        let before = root.binary_snapshot("private.sh").unwrap().version;
        root.replace_bytes("private.sh", &before, b"after").unwrap();
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
}
