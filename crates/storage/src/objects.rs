use crate::{Error, Redactor, Result};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{BufRead, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};
use workpilot_contracts::{ContentPage, ContentRef};

pub const MAX_TEXT_LINE: usize = 65_536;
pub const MAX_OBJECT_BYTES: u64 = 256 * 1024 * 1024;
/// Caller provides bounded, structurally redacted JSON. Text line rules do not apply.
pub(crate) fn put_json(root: &Path, bytes: &[u8]) -> Result<ContentRef> {
    put_bytes(root, bytes, "application/json")
}
/// Tool capture is already bounded in memory. Redact complete lines before
/// saving, including a single long line; do not split secrets across chunks.
pub(crate) fn put_tool_text(root: &Path, text: &str, redactor: &Redactor) -> Result<ContentRef> {
    if text.len() > 8 * 1024 * 1024 {
        return Err(Error::Invalid("tool text exceeds 8 MiB"));
    }
    let safe = redactor.text(text);
    put_bytes(root, safe.as_bytes(), "text/plain; charset=utf-8")
}
fn put_bytes(root: &Path, bytes: &[u8], media_type: &str) -> Result<ContentRef> {
    let id = format!("{:x}", Sha256::digest(bytes));
    let path = object_path(root, &id)?;
    let content = ContentRef {
        object_id: id,
        bytes: bytes.len() as u64,
        media_type: media_type.into(),
    };
    if path.exists() {
        verify(root, &content)?;
        return Ok(content);
    }
    let mut temporary = tempfile::NamedTempFile::new_in(root.join("objects"))?;
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist_noclobber(path)
        .map_err(|e| Error::Io(e.error))?;
    #[cfg(unix)]
    File::open(root.join("objects"))?.sync_all()?;
    Ok(content)
}
/// Already authenticated, hash-checked and credential-checked archive content.
pub(crate) fn put_archive_bytes(root: &Path, bytes: &[u8], media_type: &str) -> Result<ContentRef> {
    put_bytes(root, bytes, media_type)
}
pub(crate) fn object_path(root: &Path, id: &str) -> Result<PathBuf> {
    if id.len() != 64
        || !id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(Error::Invalid("object id"));
    }
    let directory = root.join("objects");
    // Refuse symlinks/junctions even if they point to another valid directory.
    if directory.canonicalize()? != directory {
        return Err(Error::Invalid("linked object directory"));
    }
    let path = directory.join(id);
    if path.exists() && path.canonicalize()? != path {
        return Err(Error::Invalid("linked object"));
    }
    Ok(path)
}

/// Bounded UTF-8 lines: oversized lines fail visibly instead of loading unlimited text.
/// Data is redacted and fsynced BEFORE a transaction may create a reference.
pub(crate) fn put_text(
    root: &Path,
    reader: &mut impl BufRead,
    redactor: &Redactor,
) -> Result<ContentRef> {
    let directory = root.join("objects");
    object_path(root, &"0".repeat(64))?;
    let mut temporary = tempfile::NamedTempFile::new_in(&directory)?;
    let mut hasher = Sha256::new();
    let mut bytes = 0_u64;
    loop {
        let mut line = Vec::with_capacity(MAX_TEXT_LINE);
        let count = reader
            .take((MAX_TEXT_LINE + 1) as u64)
            .read_until(b'\n', &mut line)?;
        if count == 0 {
            break;
        }
        if count > MAX_TEXT_LINE {
            return Err(Error::Invalid("text line exceeds 64 KiB"));
        }
        let line = std::str::from_utf8(&line).map_err(|_| Error::Invalid("text is not UTF-8"))?;
        let clean = redactor.text(line);
        bytes += clean.len() as u64;
        if bytes > MAX_OBJECT_BYTES {
            return Err(Error::Invalid("object exceeds 256 MiB"));
        }
        hasher.update(clean.as_bytes());
        temporary.write_all(clean.as_bytes())?;
    }
    temporary.as_file().sync_all()?;
    let id = format!("{:x}", hasher.finalize());
    let path = object_path(root, &id)?;
    if path.exists() {
        verify(
            root,
            &ContentRef {
                object_id: id.clone(),
                bytes,
                media_type: "text/plain; charset=utf-8".into(),
            },
        )?;
    } else {
        temporary
            .persist_noclobber(path)
            .map_err(|e| Error::Io(e.error))?;
        #[cfg(unix)]
        File::open(directory)?.sync_all()?;
    }
    Ok(ContentRef {
        object_id: id,
        bytes,
        media_type: "text/plain; charset=utf-8".into(),
    })
}
pub(crate) fn verify(root: &Path, content: &ContentRef) -> Result<()> {
    let mut file = File::open(object_path(root, &content.object_id)?)?;
    if file.metadata()?.len() != content.bytes {
        return Err(Error::Corrupt("object length"));
    }
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 65_536];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    if format!("{:x}", hash.finalize()) != content.object_id {
        return Err(Error::Corrupt("object checksum"));
    }
    Ok(())
}
pub(crate) fn read(
    root: &Path,
    content: &ContentRef,
    offset: u64,
    limit: u32,
) -> Result<ContentPage> {
    if offset > content.bytes {
        return Err(Error::Invalid("content offset"));
    }
    let mut file = File::open(object_path(root, &content.object_id)?)?;
    file.seek(SeekFrom::Start(offset))?;
    if file.metadata()?.len() != content.bytes {
        return Err(Error::Corrupt("object length"));
    }
    let mut buffer = vec![0; limit as usize + 3];
    let n = file.read(&mut buffer)?;
    buffer.truncate(n);
    let complete = match std::str::from_utf8(&buffer) {
        Ok(text) => text,
        Err(error) if error.error_len().is_none() => {
            std::str::from_utf8(&buffer[..error.valid_up_to()])
                .map_err(|_| Error::Corrupt("UTF-8"))?
        }
        Err(_) => return Err(Error::Invalid("offset is not a UTF-8 boundary")),
    };
    let mut end = complete.len().min(limit as usize);
    while !complete.is_char_boundary(end) {
        end -= 1;
    }
    // Even limit=1 must advance on a multibyte character.
    if end == 0 && !complete.is_empty() {
        end = complete.chars().next().unwrap().len_utf8();
    }
    Ok(ContentPage {
        text: complete[..end].into(),
        next_offset: offset + end as u64,
        total_bytes: content.bytes,
    })
}
