//! Versioned, bounded encrypted history archive. Uses the existing ring primitives;
//! never contains the OS credential or the source vault's encryption key.
use ring::{
    aead, pbkdf2,
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::{Read, Write},
    num::NonZeroU32,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};
pub(super) use workpilot_contracts::{
    PortableFileImage as Image, PortableFileRevision as Revision,
};
use zeroize::Zeroizing;
type Result<T> = std::result::Result<T, String>;
const MAGIC: &[u8; 8] = b"WPHIST01";
pub(super) const MAX_TOTAL: u64 = 256 * 1024 * 1024;
const MAX_FILE: u64 = 64 * 1024 * 1024;
const MAX_META: usize = 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Manifest {
    pub version: u32,
    pub archive_id: String,
    pub created_at_ms: u64,
    pub revisions: Vec<Revision>,
}
impl Manifest {
    pub fn objects(&self) -> Result<BTreeMap<String, u64>> {
        if self.version != 1
            || uuid::Uuid::parse_str(&self.archive_id).is_err()
            || self.revisions.is_empty()
            || self.revisions.len() > 128
        {
            return Err("不支持的历史备份版本或数量 / Unsupported history archive".into());
        }
        let mut objects = BTreeMap::new();
        let mut revisions = HashSet::new();
        for r in &self.revisions {
            if !workpilot_contracts::valid_id(&r.id)
                || !workpilot_contracts::valid_id(&r.task_id)
                || !workpilot_contracts::valid_id(&r.operation_id)
                || !revisions.insert(&r.id)
                || r.source.len() > 256
                || !["created", "modified", "deleted", "renamed"].contains(&r.change.as_str())
            {
                return Err("历史备份记录无效 / Invalid history entry".into());
            }
            workpilot_tools::binary::user_path(&r.path)
                .map_err(|_| "备份包含不允许的相对路径 / Invalid history path")?;
            if let Some(path) = &r.previous_path {
                workpilot_tools::binary::user_path(path)
                    .map_err(|_| "Invalid previous history path")?;
            }
            if let Some(o) = &r.origin
                && (![&o.archive_id, &o.revision_id, &o.task_id, &o.operation_id]
                    .iter()
                    .all(|s| workpilot_contracts::valid_id(s))
                    || o.source.len() > 256)
            {
                return Err("Invalid origin".into());
            }
            for image in [&r.before, &r.after] {
                if !image.exists {
                    if image.bytes != 0 || image.sha256.is_some() {
                        return Err("Invalid absent image".into());
                    }
                } else {
                    let sha = image.sha256.as_ref().ok_or("Missing image checksum")?;
                    if image.bytes > MAX_FILE
                        || sha.len() != 64
                        || !sha
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                    {
                        return Err("Invalid image size or checksum".into());
                    }
                    if let Some(old) = objects.insert(sha.clone(), image.bytes)
                        && old != image.bytes
                    {
                        return Err("Inconsistent image sizes".into());
                    }
                }
            }
        }
        if objects.values().sum::<u64>() > MAX_TOTAL {
            return Err("一次备份最多 256 MiB，请减少所选版本 / Archive exceeds 256 MiB".into());
        }
        Ok(objects)
    }
}
fn check(stop: &AtomicBool) -> Result<()> {
    if stop.load(Ordering::Relaxed) {
        Err("历史备份操作已取消 / History transfer cancelled".into())
    } else {
        Ok(())
    }
}
fn key(password: &str, salt: &[u8]) -> Result<aead::LessSafeKey> {
    let mut raw = Zeroizing::new([0u8; 32]);
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        NonZeroU32::new(600_000).unwrap(),
        salt,
        password.as_bytes(),
        raw.as_mut(),
    );
    Ok(aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_256_GCM, raw.as_ref())
            .map_err(|_| "Invalid encryption key")?,
    ))
}
fn aad(header: &[u8], index: u32) -> Vec<u8> {
    let mut a = header.to_vec();
    a.extend_from_slice(&index.to_le_bytes());
    a
}
fn frame(
    output: &mut impl Write,
    key: &aead::LessSafeKey,
    header: &[u8],
    index: u32,
    bytes: &[u8],
) -> Result<()> {
    let mut nonce = [0; 12];
    SystemRandom::new()
        .fill(&mut nonce)
        .map_err(|_| "Randomness unavailable")?;
    let mut encrypted = bytes.to_vec();
    key.seal_in_place_append_tag(
        aead::Nonce::assume_unique_for_key(nonce),
        aead::Aad::from(aad(header, index)),
        &mut encrypted,
    )
    .map_err(|_| "Encryption failed")?;
    output
        .write_all(&(encrypted.len() as u64).to_le_bytes())
        .and_then(|_| output.write_all(&nonce))
        .and_then(|_| output.write_all(&encrypted))
        .map_err(|_| "无法写入备份 / Cannot write archive".into())
}
struct Reader<R> {
    inner: R,
    hash: Sha256,
    read: u64,
}
impl<R: Read> Read for Reader<R> {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(out)?;
        self.read += n as u64;
        if self.read > MAX_TOTAL + 2 * MAX_META as u64 {
            return Err(std::io::Error::other("Archive exceeds limit"));
        }
        self.hash.update(&out[..n]);
        Ok(n)
    }
}
fn unframe(
    input: &mut impl Read,
    key: &aead::LessSafeKey,
    header: &[u8],
    index: u32,
    max: usize,
) -> Result<Zeroizing<Vec<u8>>> {
    let bad =
        "口令错误、备份损坏或格式不受支持 / Incorrect passphrase, damaged or unsupported archive";
    let mut length = [0; 8];
    let mut nonce = [0; 12];
    input
        .read_exact(&mut length)
        .and_then(|_| input.read_exact(&mut nonce))
        .map_err(|_| bad)?;
    let size = u64::from_le_bytes(length);
    if size < 16 || size > max as u64 + 16 {
        return Err(bad.into());
    }
    let mut bytes = Zeroizing::new(vec![0; size as usize]);
    input.read_exact(&mut bytes).map_err(|_| bad)?;
    let size = key
        .open_in_place(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(aad(header, index)),
            &mut bytes,
        )
        .map_err(|_| bad)?
        .len();
    bytes.truncate(size);
    Ok(bytes)
}
pub(super) trait ArchiveIndex: Serialize + DeserializeOwned {
    const MAGIC: &'static [u8; 8];
    fn objects(&self) -> Result<BTreeMap<String, u64>>;
}
impl ArchiveIndex for Manifest {
    const MAGIC: &'static [u8; 8] = MAGIC;
    fn objects(&self) -> Result<BTreeMap<String, u64>> {
        self.objects()
    }
}
pub(super) fn write(
    output: impl Write,
    password: &str,
    manifest: &Manifest,
    stop: &AtomicBool,
    object: impl FnMut(&str) -> Result<Vec<u8>>,
) -> Result<()> {
    write_index(output, password, manifest, stop, object)
}
pub(super) fn read(
    input: impl Read,
    password: &str,
    stop: &AtomicBool,
    object: impl FnMut(&str, &[u8]) -> Result<()>,
) -> Result<(Manifest, String)> {
    read_index(input, password, stop, object)
}

pub(super) fn write_index<I: ArchiveIndex>(
    mut output: impl Write,
    password: &str,
    manifest: &I,
    stop: &AtomicBool,
    mut object: impl FnMut(&str) -> Result<Vec<u8>>,
) -> Result<()> {
    let objects = manifest.objects()?;
    check(stop)?;
    let mut header = [0; 24];
    header[..8].copy_from_slice(I::MAGIC);
    SystemRandom::new()
        .fill(&mut header[8..])
        .map_err(|_| "Randomness unavailable")?;
    let key = key(password, &header[8..])?;
    output
        .write_all(&header)
        .map_err(|_| "Cannot write archive header")?;
    let meta = Zeroizing::new(serde_json::to_vec(manifest).map_err(|_| "Cannot encode history")?);
    if meta.len() > MAX_META {
        return Err("History metadata exceeds limit".into());
    }
    frame(&mut output, &key, &header, 0, &meta)?;
    for (index, (sha, size)) in objects.iter().enumerate() {
        check(stop)?;
        let bytes = Zeroizing::new(object(sha)?);
        if bytes.len() as u64 != *size || digest(&bytes) != *sha {
            return Err(
                "历史原文件内容无法完整读取，未导出 / History content is incomplete".into(),
            );
        }
        frame(&mut output, &key, &header, index as u32 + 1, &bytes)?;
    }
    check(stop)
}
pub(super) fn read_index<I: ArchiveIndex>(
    input: impl Read,
    password: &str,
    stop: &AtomicBool,
    mut object: impl FnMut(&str, &[u8]) -> Result<()>,
) -> Result<(I, String)> {
    check(stop)?;
    let mut input = Reader {
        inner: input,
        hash: Sha256::new(),
        read: 0,
    };
    let mut header = [0; 24];
    input
        .read_exact(&mut header)
        .map_err(|_| "不完整的备份 / Incomplete archive")?;
    if &header[..8] != I::MAGIC {
        return Err("不是支持的 WorkPilot 备份 / Unsupported archive".into());
    }
    let key = key(password, &header[8..])?;
    let meta = unframe(&mut input, &key, &header, 0, MAX_META)?;
    let manifest: I = serde_json::from_slice(&meta).map_err(|_| "Invalid history manifest")?;
    let objects = manifest.objects()?;
    for (index, (sha, size)) in objects.iter().enumerate() {
        check(stop)?;
        let bytes = unframe(&mut input, &key, &header, index as u32 + 1, *size as usize)?;
        if bytes.len() as u64 != *size || digest(&bytes) != *sha {
            return Err("备份内容校验失败 / Archive content checksum mismatch".into());
        }
        object(sha, &bytes)?;
    }
    let mut tail = [0];
    if input.read(&mut tail).map_err(|_| "Cannot finish archive")? != 0 {
        return Err("Unexpected trailing archive data".into());
    }
    check(stop)?;
    Ok((manifest, format!("{:x}", input.hash.finalize())))
}
pub(super) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
/// Small authenticated settings document. A distinct magic keeps history archives incompatible.
pub(super) fn write_document(
    output: impl Write,
    password: &str,
    bytes: &[u8],
    stop: &AtomicBool,
) -> Result<()> {
    write_sized_document(output, password, bytes, stop, b"WPSET001", MAX_META)
}
pub(super) fn write_sized_document(
    mut output: impl Write,
    password: &str,
    bytes: &[u8],
    stop: &AtomicBool,
    magic: &[u8; 8],
    maximum: usize,
) -> Result<()> {
    if bytes.len() > maximum {
        return Err(
            "迁移包超过容量上限，请减少选择 / Transfer archive exceeds its size limit".into(),
        );
    }
    check(stop)?;
    let mut header = [0; 24];
    header[..8].copy_from_slice(magic);
    SystemRandom::new()
        .fill(&mut header[8..])
        .map_err(|_| "Randomness unavailable")?;
    let key = key(password, &header[8..])?;
    output
        .write_all(&header)
        .map_err(|_| "Cannot write settings archive")?;
    frame(&mut output, &key, &header, 0, bytes)?;
    check(stop)
}
pub(super) fn read_document(
    input: impl Read,
    password: &str,
    stop: &AtomicBool,
) -> Result<(Zeroizing<Vec<u8>>, String)> {
    read_sized_document(input, password, stop, b"WPSET001", MAX_META)
}
pub(super) fn read_sized_document(
    input: impl Read,
    password: &str,
    stop: &AtomicBool,
    magic: &[u8; 8],
    maximum: usize,
) -> Result<(Zeroizing<Vec<u8>>, String)> {
    check(stop)?;
    let mut input = Reader {
        inner: input,
        hash: Sha256::new(),
        read: 0,
    };
    let mut header = [0; 24];
    input
        .read_exact(&mut header)
        .map_err(|_| "不完整的设置包 / Incomplete settings archive")?;
    if &header[..8] != magic {
        return Err("不是支持的迁移包 / Unsupported transfer archive".into());
    }
    let key = key(password, &header[8..])?;
    let bytes = unframe(&mut input, &key, &header, 0, maximum)?;
    let mut tail = [0];
    if input
        .read(&mut tail)
        .map_err(|_| "Cannot finish settings archive")?
        != 0
    {
        return Err("设置包包含多余内容 / Trailing archive data".into());
    }
    check(stop)?;
    Ok((bytes, format!("{:x}", input.hash.finalize())))
}
pub(super) fn plain(path: &Path, directory: bool) -> Result<()> {
    if !path.is_absolute() {
        return Err("请选择绝对文件位置 / Select an absolute file path".into());
    }
    for part in path.ancestors() {
        let m = fs::symlink_metadata(part)
            .map_err(|_| "文件位置不存在或无法读取 / File location unavailable")?;
        if m.is_symlink() {
            return Err("不支持链接文件或文件夹 / Linked paths are unsupported".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if m.file_attributes() & 0x400 != 0 {
                return Err("不支持重解析路径 / Reparse paths are unsupported".into());
            }
        }
    }
    let m = fs::metadata(path).map_err(|_| "File location unavailable")?;
    if (directory && !m.is_dir())
        || (!directory && (!m.is_file() || m.len() > MAX_TOTAL + 2 * MAX_META as u64))
    {
        return Err("不支持的文件类型或备份大小 / Unsupported file type or archive size".into());
    }
    Ok(())
}
