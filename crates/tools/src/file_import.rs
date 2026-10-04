//! Create-only import. Directory handles constrain every traversal to the bound project.
use crate::{
    binary::{absent, user_path},
    files::{Result, Root, no_link, relative},
};
use workpilot_contracts::FileVersion;

impl Root {
    pub fn create_import_file(&self, path: &str, bytes: &[u8]) -> Result<FileVersion> {
        user_path(path)?;
        let relative = relative(path, false)?;
        let mut dir = self.dir.try_clone()?;
        if let Some(parent) = relative.parent() {
            for part in parent.components() {
                let name = part.as_os_str();
                match dir.symlink_metadata(name) {
                    Ok(meta) => no_link(&meta)?,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        match dir.create_dir(name) {
                            Ok(()) => {}
                            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                            Err(e) => return Err(e.into()),
                        }
                        no_link(&dir.symlink_metadata(name)?)?;
                    }
                    Err(e) => return Err(e.into()),
                }
                dir = dir.open_dir(name)?;
            }
        }
        self.replace_bytes(path, &absent(), bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nested_binary_create_only_and_invalid_paths() {
        let temp = tempfile::tempdir().unwrap();
        let root = Root::open(temp.path().to_str().unwrap(), None).unwrap();
        let path = "资料/空 格/图.bin";
        assert!(!root.binary_snapshot(path).unwrap().version.exists);
        root.create_import_file(path, &[0, 255, 1]).unwrap();
        assert!(root.create_import_file(path, &[2]).is_err());
        assert_eq!(root.binary_snapshot(path).unwrap().bytes, [0, 255, 1]);
        for path in [
            "../escape",
            ".git/file",
            "C:/escape",
            "dir/../escape",
            "NUL",
        ] {
            assert!(root.create_import_file(path, &[]).is_err());
        }
        assert!(
            root.create_import_file("资料/空 格/图.bin/child", &[])
                .is_err()
        );
    }
}
