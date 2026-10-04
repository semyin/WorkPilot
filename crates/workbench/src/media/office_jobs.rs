//! Short, private staging paths for the Windows Office runtime. The source and
//! encrypted vault stay in place. A host-only lease protects other live engines.
use crate::vault::Result;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

const MAGIC: &str = "WorkPilot Office job 1\n";
const MAX_JOB_PATH: usize = 120;

pub(super) struct Job {
    directory: PathBuf,
    lease_path: PathBuf,
    lease: Option<File>,
}

fn regular(path: &Path, directory: bool) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    !metadata.file_type().is_symlink()
        && if directory {
            metadata.is_dir()
        } else {
            metadata.is_file()
        }
}

fn lease(path: &Path, create: bool) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(create);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Atomic exclusive open: a scanner cannot open a newly created lease
        // between creation and locking. The worker has no access to its parent.
        options.share_mode(0);
    }
    let file = options.open(path)?;
    file.try_lock().map_err(std::io::Error::from)?;
    Ok(file)
}

fn recover(root: &Path) -> Result<()> {
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let Some(token) = name.to_str().and_then(|v| v.strip_suffix(".lease")) else {
            continue;
        };
        if token.len() != 20 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        if !regular(&entry.path(), false) {
            continue;
        }
        let Ok(mut held) = lease(&entry.path(), false) else {
            // Another conversion may belong to another live WorkPilot engine.
            continue;
        };
        let mut marker = String::new();
        if (&mut held).take(128).read_to_string(&mut marker).is_err()
            || marker != format!("{MAGIC}{token}\n")
        {
            continue;
        }
        let job = root.join(token);
        match fs::symlink_metadata(&job) {
            Ok(_) if regular(&job, true) => {
                fs::remove_dir_all(&job)
                    .map_err(|_| "Office 临时预览清理失败 / Office staging cleanup failed")?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            _ => continue, // Never traverse a redirected or unexpected entry.
        }
        drop(held);
        let _ = fs::remove_file(entry.path());
    }
    Ok(())
}

fn path_units(path: &Path) -> usize {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        path.as_os_str().encode_wide().count()
    }
    #[cfg(not(windows))]
    {
        path.as_os_str().len()
    }
}

impl Job {
    pub(super) fn create(data: &Path) -> Result<Self> {
        Self::in_temp(data, &std::env::temp_dir())
    }

    fn in_temp(data: &Path, temporary: &Path) -> Result<Self> {
        let data = data.canonicalize().map_err(|e| e.to_string())?;
        let owner = format!("{:x}", Sha256::digest(data.as_os_str().as_encoded_bytes()));
        let root = temporary.join(format!("wp-office-{}", &owner[..24]));
        let token = uuid::Uuid::new_v4().simple().to_string()[..20].to_owned();
        let directory = root.join(&token);
        if !temporary.is_absolute() || path_units(&directory) > MAX_JOB_PATH {
            return Err("Office 预览需要较短的系统临时目录 / Office preview requires a shorter system temporary directory".into());
        }
        match fs::create_dir(&root) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.to_string()),
        }
        if !regular(&root, true) {
            return Err("Office 临时目录不能是链接 / Office staging cannot be a link".into());
        }
        recover(&root)?;
        let lease_path = root.join(format!("{token}.lease"));
        let mut held = lease(&lease_path, true).map_err(|e| e.to_string())?;
        held.write_all(format!("{MAGIC}{token}\n").as_bytes())
            .and_then(|_| held.sync_all())
            .map_err(|e| e.to_string())?;
        // Do not let Drop remove a pre-existing directory on a name collision.
        if let Err(error) = fs::create_dir(&directory) {
            drop(held);
            let _ = fs::remove_file(&lease_path);
            return Err(error.to_string());
        }
        Ok(Self {
            directory,
            lease_path,
            lease: Some(held),
        })
    }

    pub(super) fn path(&self) -> &Path {
        &self.directory
    }

    pub(super) fn close(mut self) -> Result<()> {
        self.clean()
    }

    fn clean(&mut self) -> Result<()> {
        if self.lease.is_none() {
            return Ok(());
        }
        if self.directory.exists() {
            if !regular(&self.directory, true) {
                return Err("Office staging directory was redirected".into());
            }
            fs::remove_dir_all(&self.directory)
                .map_err(|_| "Office 临时预览清理失败 / Office staging cleanup failed")?;
        }
        self.lease.take();
        match fs::remove_file(&self.lease_path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("Office staging lease cleanup failed".into()),
        }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        let _ = self.clean();
    }
}

#[cfg(test)]
#[path = "office_jobs_tests.rs"]
mod tests;
