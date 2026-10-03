use directories::ProjectDirs;
use std::{
    fs, io,
    path::{Path, PathBuf},
};
use thiserror::Error;

#[derive(Clone, Copy, Debug)]
pub enum Channel {
    Development,
    Test,
    Release,
}

impl Channel {
    pub fn name(self) -> &'static str {
        match self {
            Self::Development => "development",
            Self::Test => "test",
            Self::Release => "release",
        }
    }
}

pub fn data_dir(channel: Channel, override_root: Option<&Path>) -> io::Result<PathBuf> {
    let base = match override_root {
        Some(root) if root.is_absolute() => root.to_owned(),
        Some(_) => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "data root must be absolute",
            ));
        }
        None if matches!(channel, Channel::Test) => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "test channel requires an explicit temporary root",
            ));
        }
        None => ProjectDirs::from("com", "WorkPilot", "WorkPilot")
            .ok_or_else(|| io::Error::other("cannot locate application data directory"))?
            .data_local_dir()
            .to_owned(),
    };
    let path = base.join(channel.name());
    fs::create_dir_all(&path)?;
    Ok(path)
}

#[derive(Debug, Error)]
pub enum ScopeError {
    #[error("path leaves the allowed directory")]
    Outside,
    #[error(transparent)]
    Io(#[from] io::Error),
}

/// Existing-file probe only. Not a sandbox, nor a race-free general file writer.
pub fn existing_path_in(root: &Path, candidate: &Path) -> Result<PathBuf, ScopeError> {
    let root = fs::canonicalize(root)?;
    let path = fs::canonicalize(if candidate.is_absolute() {
        candidate.to_owned()
    } else {
        root.join(candidate)
    })?;
    if !path.starts_with(&root) {
        return Err(ScopeError::Outside);
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn channels_never_share_the_same_directory() {
        let temp = tempfile::tempdir().unwrap();
        let paths: Vec<_> = [Channel::Development, Channel::Test, Channel::Release]
            .iter()
            .map(|c| data_dir(*c, Some(temp.path())).unwrap())
            .collect();
        assert_ne!(paths[0], paths[1]);
        assert_ne!(paths[1], paths[2]);
        assert!(data_dir(Channel::Test, None).is_err());
        assert!(data_dir(Channel::Test, Some(Path::new("."))).is_err());
    }
    #[test]
    fn checks_real_paths_and_rejects_parent_escape() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("allowed.txt"), "inside").unwrap();
        fs::write(temp.path().join("outside.txt"), "outside").unwrap();
        assert!(existing_path_in(&root, Path::new("allowed.txt")).is_ok());
        assert!(matches!(
            existing_path_in(&root, Path::new("../outside.txt")),
            Err(ScopeError::Outside)
        ));
    }
    #[cfg(windows)]
    #[test]
    fn rejects_windows_directory_junction_escape() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        let outside = temp.path().join("outside");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("file.txt"), "outside").unwrap();
        let result = crate::process::spawn_command(
            std::process::Command::new("cmd.exe")
                .args(["/c", "mklink", "/J"])
                .arg(root.join("link"))
                .arg(&outside)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped()),
        )
        .unwrap()
        .wait_with_output()
        .unwrap();
        assert!(
            result.status.success(),
            "junction fixture could not be created"
        );
        assert!(matches!(
            existing_path_in(&root, Path::new("link/file.txt")),
            Err(ScopeError::Outside)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_links_to_outside() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        fs::create_dir(&root).unwrap();
        fs::write(temp.path().join("outside.txt"), "outside").unwrap();
        std::os::unix::fs::symlink(temp.path().join("outside.txt"), root.join("link")).unwrap();
        assert!(matches!(
            existing_path_in(&root, Path::new("link")),
            Err(ScopeError::Outside)
        ));
    }
}
