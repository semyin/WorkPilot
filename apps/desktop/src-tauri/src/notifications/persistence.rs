use super::model::Saved;
use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

const MAX_BYTES: u64 = 128 * 1024;
fn plain(path: &Path, directory: bool) -> io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    let linked = meta.file_type().is_symlink();
    #[cfg(windows)]
    let linked = {
        use std::os::windows::fs::MetadataExt;
        linked || meta.file_attributes() & 0x400 != 0
    };
    if linked
        || meta.is_dir() != directory
        || (!directory && (!meta.is_file() || meta.len() > MAX_BYTES))
    {
        return Err(io::Error::other(
            "notification storage is not a regular owned path",
        ));
    }
    Ok(())
}
pub fn directory(root: &Path) -> io::Result<PathBuf> {
    if !root.is_absolute() {
        return Err(io::Error::other("absolute data directory required"));
    }
    for ancestor in root.ancestors() {
        plain(ancestor, true)?;
    }
    let directory = root.join("desktop-notifications");
    if !directory.exists() {
        fs::create_dir(&directory)?;
    }
    plain(&directory, true)?;
    Ok(directory)
}
pub fn load(directory: &Path) -> io::Result<Saved> {
    let path = directory.join("state.json");
    if !path.exists() {
        return Ok(Saved::default());
    }
    plain(&path, false)?;
    let mut text = Vec::new();
    fs::File::open(path)?
        .take(MAX_BYTES + 1)
        .read_to_end(&mut text)?;
    let value: Saved = serde_json::from_slice(&text)?;
    if text.len() > MAX_BYTES as usize || !value.validate() {
        return Err(io::Error::other("notification record format is invalid"));
    }
    Ok(value)
}
pub fn save(directory: &Path, saved: &Saved) -> io::Result<()> {
    plain(directory, true)?;
    let path = directory.join("state.json");
    if path.exists() {
        plain(&path, false)?;
    }
    let mut next = tempfile::Builder::new()
        .prefix(".notification-")
        .tempfile_in(directory)?;
    serde_json::to_writer(next.as_file_mut(), saved)?;
    next.flush()?;
    next.as_file().sync_all()?;
    next.persist(path).map_err(|e| e.error)?;
    Ok(())
}
