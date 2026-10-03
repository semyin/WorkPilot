//! Directory handles, not string-prefix checks, carry access authority.
use cap_std::fs::{Dir, File, Metadata, MetadataExt, OpenOptions};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::{self, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};
use workpilot_contracts::FileVersion;
pub const MAX_FILE_BYTES: u64 = 1024 * 1024;
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Rejected(&'static str),
    #[error("file operation failed: {0}")]
    Io(#[from] io::Error),
}
pub type Result<T> = std::result::Result<T, Error>;
pub struct Root {
    pub path: PathBuf,
    pub identity: String,
    pub(crate) dir: Dir,
}
pub struct Snapshot {
    pub version: FileVersion,
    pub text: Option<String>,
}
fn regular(meta: &Metadata) -> Result<()> {
    if !meta.is_file() {
        return Err(Error::Rejected("expected a regular file"));
    }
    #[cfg(windows)]
    if meta.file_attributes() & 0x400 != 0 {
        return Err(Error::Rejected("linked files are not accepted"));
    }
    #[cfg(unix)]
    if meta.nlink() != 1 {
        return Err(Error::Rejected("linked files are not accepted"));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(Error::Rejected("file exceeds the managed text limit"));
    }
    Ok(())
}
pub(crate) fn no_link(meta: &Metadata) -> Result<()> {
    if meta.file_type().is_symlink() {
        return Err(Error::Rejected("symbolic links are not accepted"));
    }
    #[cfg(windows)]
    if meta.file_attributes() & 0x400 != 0 {
        return Err(Error::Rejected("reparse points are not accepted"));
    }
    Ok(())
}
pub fn relative(path: &str, allow_root: bool) -> Result<PathBuf> {
    if path == "." && allow_root {
        return Ok(PathBuf::from("."));
    }
    if path.is_empty() || path.len() > 4096 || path.chars().any(|c| c.is_control() || c == ':') {
        return Err(Error::Rejected("invalid relative path"));
    }
    let normalized = path.replace('\\', "/");
    for part in normalized.split('/') {
        let device = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with([' ', '.'])
            || ["CON", "PRN", "AUX", "NUL"].contains(&device.as_str())
            || (device.len() == 4
                && (device.starts_with("COM") || device.starts_with("LPT"))
                && device.as_bytes()[3].is_ascii_digit())
        {
            return Err(Error::Rejected(
                "path leaves the supported project namespace",
            ));
        }
    }
    Ok(PathBuf::from(normalized))
}
impl Root {
    pub fn inventory(&self) -> Result<Value> {
        let versions = self.version_inventory()?;
        let files:Vec<_>=versions.iter().map(|(path,v)|json!({"path":path,"identity":v.identity,"bytes":v.bytes,"sha256":v.sha256})).collect();
        Ok(
            json!({"files":files,"bytes":versions.values().map(|v|v.bytes).sum::<u64>(),"excluded":crate::binary::EXCLUDED}),
        )
    }
    pub fn open(path: &str, expected: Option<&str>) -> Result<Self> {
        let p = Path::new(path);
        if !p.is_absolute() {
            return Err(Error::Rejected("project directory must be absolute"));
        }
        let path = std::fs::canonicalize(p)?;
        #[cfg(windows)]
        let path = {
            let display = path.to_string_lossy();
            if display.starts_with("\\\\?\\UNC\\")
                || display.starts_with("\\\\") && !display.starts_with("\\\\?\\")
            {
                return Err(Error::Rejected(
                    "network project directories are not supported yet",
                ));
            }
            PathBuf::from(display.strip_prefix("\\\\?\\").unwrap_or(&display))
        };
        let dir = Dir::open_ambient_dir(&path, cap_std::ambient_authority())?;
        let identity = workpilot_platform::files::identity(&dir.try_clone()?.into_std_file())?.0;
        if expected.is_some_and(|e| e != identity) {
            return Err(Error::Rejected("project directory identity changed"));
        }
        Ok(Self {
            path,
            identity,
            dir,
        })
    }
    pub(crate) fn parent(&self, path: &str) -> Result<(Dir, String)> {
        let p = relative(path, false)?;
        let mut dir = self.dir.try_clone()?;
        if let Some(parent) = p.parent() {
            for component in parent.components() {
                let name = component.as_os_str();
                let meta = dir.symlink_metadata(name)?;
                no_link(&meta)?;
                dir = dir.open_dir(name)?;
            }
        }
        let name = p
            .file_name()
            .ok_or(Error::Rejected("file name missing"))?
            .to_str()
            .ok_or(Error::Rejected("file name is not UTF-8"))?
            .to_owned();
        if let Ok(meta) = dir.symlink_metadata(&name) {
            no_link(&meta)?;
        }
        Ok((dir, name))
    }
    pub fn snapshot(&self, path: &str) -> Result<Snapshot> {
        let (dir, name) = self.parent(path)?;
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.share_mode(1);
        }
        match dir.open_with(&name, &options) {
            Ok(mut file) => snapshot(&mut file),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Snapshot {
                version: FileVersion {
                    exists: false,
                    sha256: None,
                    bytes: 0,
                    identity: None,
                },
                text: None,
            }),
            Err(e) => Err(e.into()),
        }
    }
    pub fn read(&self, path: &str, offset: usize, limit: usize) -> Result<Value> {
        if limit == 0 || limit > 32768 {
            return Err(Error::Rejected("read limit must be 1 to 32768 bytes"));
        }
        let s = self.snapshot(path)?;
        let text = s.text.ok_or(Error::Rejected("file not found"))?;
        if offset > text.len() || !text.is_char_boundary(offset) {
            return Err(Error::Rejected("invalid UTF-8 offset"));
        }
        let mut end = (offset + limit).min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        Ok(
            json!({"path":path,"version":s.version,"text":&text[offset..end],"next_offset":end,"has_more":end<text.len()}),
        )
    }
    pub fn list(&self, path: &str) -> Result<Value> {
        let p = relative(path, true)?;
        let dir = if p == Path::new(".") {
            self.dir.try_clone()?
        } else {
            let (parent, name) = self.parent(path)?;
            parent.open_dir(name)?
        };
        let mut entries = vec![];
        let mut truncated = false;
        for e in dir.entries()? {
            let e = e?;
            if entries.len() == 256 {
                truncated = true;
                break;
            }
            let meta = e.metadata()?;
            let linked = no_link(&meta).is_err();
            entries.push(json!({"name":e.file_name().to_string_lossy(),"directory":meta.is_dir(),"linked":linked,"bytes":meta.len()}));
        }
        entries.sort_by_key(|e| e["name"].as_str().unwrap_or("").to_owned());
        Ok(json!({"path":path,"entries":entries,"truncated":truncated}))
    }
    pub fn search(&self, path: &str, needle: &str) -> Result<Value> {
        if needle.is_empty() || needle.len() > 256 {
            return Err(Error::Rejected("invalid search text"));
        }
        relative(path, true)?;
        let mut queue = vec![path.to_owned()];
        let mut matches = vec![];
        let mut scanned = 0;
        let mut skipped = 0;
        let mut truncated = false;
        while let Some(directory) = queue.pop() {
            let listing = self.list(&directory)?;
            if listing["truncated"] == true {
                truncated = true;
            }
            for e in listing["entries"].as_array().unwrap() {
                if e["linked"] == true {
                    skipped += 1;
                    continue;
                }
                let name = e["name"].as_str().unwrap();
                let child = if directory == "." {
                    name.to_owned()
                } else {
                    format!("{directory}/{name}")
                };
                if e["directory"] == true {
                    if queue.len() < 128 {
                        queue.push(child)
                    } else {
                        truncated = true;
                    }
                    continue;
                }
                if scanned >= 256 || matches.len() >= 100 {
                    truncated = true;
                    break;
                }
                scanned += 1;
                let Ok(s) = self.snapshot(&child) else {
                    skipped += 1;
                    continue;
                };
                for (index, line) in s.text.unwrap_or_default().lines().enumerate() {
                    if line.contains(needle) {
                        matches.push(json!({"path":child,"line":index+1,"text":line.chars().take(300).collect::<String>()}));
                        if matches.len() >= 100 {
                            truncated = true;
                            break;
                        }
                    }
                }
            }
            if scanned >= 256 || matches.len() >= 100 {
                break;
            }
        }
        Ok(
            json!({"matches":matches,"files_scanned":scanned,"skipped":skipped,"truncated":truncated}),
        )
    }
    /// Complete replacement after a fresh comparison; the caller journals before bytes.
    pub fn write(&self, path: &str, expected: &FileVersion, text: &str) -> Result<FileVersion> {
        if text.len() > MAX_FILE_BYTES as usize {
            return Err(Error::Rejected("write exceeds the managed text limit"));
        }
        self.replace_bytes(path, expected, text.as_bytes())
    }
}

fn snapshot(file: &mut File) -> Result<Snapshot> {
    let meta = file.metadata()?;
    regular(&meta)?;
    let (identity, links) = workpilot_platform::files::identity(&file.try_clone()?.into_std())?;
    if links != 1 {
        return Err(Error::Rejected("linked files are not accepted"));
    }
    file.seek(SeekFrom::Start(0))?;
    let mut bytes = vec![];
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(Error::Rejected("file grew beyond the managed text limit"));
    }
    let version = FileVersion {
        exists: true,
        sha256: Some(format!("{:x}", Sha256::digest(&bytes))),
        bytes: bytes.len() as u64,
        identity: Some(identity),
    };
    let text =
        String::from_utf8(bytes).map_err(|_| Error::Rejected("this tool reads UTF-8 text only"))?;
    Ok(Snapshot {
        version,
        text: Some(text),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn managed_write_binds_identity_content_and_creation_state() {
        let temp = tempfile::tempdir().unwrap();
        let root = Root::open(temp.path().to_str().unwrap(), None).unwrap();
        let missing = root.snapshot("new.txt").unwrap();
        let written = root
            .write("new.txt", &missing.version, "你好 WorkPilot")
            .unwrap();
        assert!(written.exists);
        assert_eq!(
            root.read("new.txt", 0, 32).unwrap()["text"],
            "你好 WorkPilot"
        );
        assert!(
            root.write("new.txt", &missing.version, "unexpected")
                .is_err()
        );
        std::fs::write(temp.path().join("new.txt"), "external edit").unwrap();
        assert!(root.write("new.txt", &written, "overwrite").is_err());
        assert_eq!(
            std::fs::read_to_string(temp.path().join("new.txt")).unwrap(),
            "external edit"
        );
    }
    #[test]
    fn parent_escape_devices_links_and_cross_root_rebind_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        std::fs::create_dir(&project).unwrap();
        std::fs::write(temp.path().join("secret.txt"), "outside").unwrap();
        let root = Root::open(project.to_str().unwrap(), None).unwrap();
        for path in [
            "../secret.txt",
            "C:/secret.txt",
            "/secret.txt",
            "file:stream",
            "CON",
            "name.",
            "a/../secret.txt",
        ] {
            assert!(root.snapshot(path).is_err(), "{path}");
        }
        std::fs::hard_link(temp.path().join("secret.txt"), project.join("hard.txt")).unwrap();
        assert!(root.snapshot("hard.txt").is_err());
        #[cfg(windows)]
        {
            let output = std::process::Command::new("cmd.exe")
                .args(["/c", "mklink", "/J"])
                .arg(project.join("link"))
                .arg(temp.path())
                .output()
                .unwrap();
            assert!(output.status.success());
            assert!(root.snapshot("link/secret.txt").is_err());
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(temp.path(), project.join("link")).unwrap();
            assert!(root.snapshot("link/secret.txt").is_err());
        }
        assert!(Root::open(temp.path().to_str().unwrap(), Some(&root.identity)).is_err());
    }
    #[test]
    fn search_reports_limits_and_read_slices_respect_utf8() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("sub")).unwrap();
        std::fs::write(temp.path().join("sub/notes.txt"), "你好\nneedle\nneedle").unwrap();
        let root = Root::open(temp.path().to_str().unwrap(), None).unwrap();
        let result = root.search(".", "needle").unwrap();
        assert_eq!(result["matches"].as_array().unwrap().len(), 2);
        assert!(root.read("sub/notes.txt", 1, 10).is_err());
        assert_eq!(root.read("sub/notes.txt", 0, 4).unwrap()["text"], "你");
    }
    #[cfg(windows)]
    #[test]
    fn existing_open_writer_blocks_managed_overwrite() {
        use std::os::windows::fs::OpenOptionsExt;
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("file.txt");
        std::fs::write(&path, "original").unwrap();
        let root = Root::open(temp.path().to_str().unwrap(), None).unwrap();
        let before = root.snapshot("file.txt").unwrap();
        let _external = std::fs::OpenOptions::new()
            .write(true)
            .share_mode(1 | 2)
            .open(&path)
            .unwrap();
        assert!(
            root.write("file.txt", &before.version, "must not overwrite")
                .is_err()
        );
    }
}
