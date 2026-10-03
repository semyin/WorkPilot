//! File versions are separate from exportable, redacted execution records.
use ring::{
    aead,
    rand::{SecureRandom, SystemRandom},
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak},
};
use workpilot_contracts::CredentialRef;
use workpilot_platform::credentials::{CredentialStore, Secret, SystemCredentials};
use zeroize::Zeroizing;
pub type Result<T> = std::result::Result<T, String>;
pub struct Vault {
    directory: PathBuf,
    key: aead::LessSafeKey,
}
impl Vault {
    pub fn open(data: &Path) -> Result<Arc<Self>> {
        static CACHE: OnceLock<Mutex<HashMap<PathBuf, Weak<Vault>>>> = OnceLock::new();
        let data = data.canonicalize().map_err(|e| e.to_string())?;
        let mut cache = CACHE
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| "version cache unavailable")?;
        if let Some(v) = cache.get(&data).and_then(Weak::upgrade) {
            return Ok(v);
        }
        let directory = data.join("versions");
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        if directory.canonicalize().map_err(|e| e.to_string())? != directory {
            return Err("linked version directory is not accepted".into());
        }
        let key_file = directory.join("key-id");
        let credentials = SystemCredentials::new("file-history").map_err(|e| e.to_string())?;
        let key = if key_file.exists() {
            if fs::metadata(&key_file).map_err(|e| e.to_string())?.len() > 128
                || key_file.canonicalize().map_err(|e| e.to_string())? != key_file
            {
                return Err("invalid or linked file history key reference".into());
            }
            let id = fs::read_to_string(&key_file).map_err(|e| e.to_string())?;
            let secret = credentials
                .get(&CredentialRef { id })
                .map_err(|_| "文件历史密钥不可用；请解锁系统凭据，未创建替代密钥。".to_owned())?;
            let raw = secret.expose();
            if raw.len() != 64 || !raw.bytes().all(|c| c.is_ascii_hexdigit()) {
                return Err("invalid file history key".into());
            }
            let mut key = Zeroizing::new([0u8; 32]);
            for (i, b) in key.iter_mut().enumerate() {
                *b = u8::from_str_radix(&raw[2 * i..2 * i + 2], 16)
                    .map_err(|_| "invalid file history key")?;
            }
            key
        } else {
            let mut key = Zeroizing::new([0u8; 32]);
            SystemRandom::new()
                .fill(key.as_mut())
                .map_err(|_| "system randomness unavailable")?;
            let id = uuid::Uuid::new_v4().to_string();
            let value = key.iter().map(|b| format!("{b:02x}")).collect::<String>();
            credentials
                .put(
                    &CredentialRef { id: id.clone() },
                    &Secret::new(value).map_err(|e| e.to_string())?,
                )
                .map_err(|_| "无法安全保存文件历史密钥；本次操作未执行。".to_owned())?;
            let mut marker = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&key_file)
                .map_err(|e| e.to_string())?;
            marker
                .write_all(id.as_bytes())
                .and_then(|_| marker.sync_all())
                .map_err(|e| e.to_string())?;
            key
        };
        let vault = Arc::new(Self::with_key(directory, &key[..])?);
        cache.insert(data, Arc::downgrade(&vault));
        Ok(vault)
    }
    fn with_key(directory: PathBuf, key: &[u8]) -> Result<Self> {
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let directory = directory.canonicalize().map_err(|e| e.to_string())?;
        let key =
            aead::UnboundKey::new(&aead::AES_256_GCM, key).map_err(|_| "invalid encryption key")?;
        Ok(Self {
            directory,
            key: aead::LessSafeKey::new(key),
        })
    }
    fn path(&self, id: &str) -> Result<PathBuf> {
        if id.len() != 64
            || !id
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        {
            return Err("invalid version object".into());
        }
        let path = self.directory.join(id);
        if self.directory.canonicalize().map_err(|e| e.to_string())? != self.directory
            || (path.exists() && path.canonicalize().map_err(|e| e.to_string())? != path)
        {
            return Err("linked version object".into());
        }
        Ok(path)
    }
    pub fn put(&self, bytes: &[u8]) -> Result<String> {
        if bytes.len() > 64 * 1024 * 1024 {
            return Err("version object exceeds 64 MiB".into());
        }
        let id = format!("{:x}", Sha256::digest(bytes));
        let path = self.path(&id)?;
        if path.exists() {
            self.read(&id)?;
            return Ok(id);
        }
        let mut nonce = [0; 12];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| "system randomness unavailable")?;
        let mut encrypted = bytes.to_vec();
        self.key
            .seal_in_place_append_tag(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(id.as_bytes()),
                &mut encrypted,
            )
            .map_err(|_| "version encryption failed")?;
        let mut temp =
            tempfile::NamedTempFile::new_in(&self.directory).map_err(|e| e.to_string())?;
        temp.write_all(b"WPV1")
            .and_then(|_| temp.write_all(&nonce))
            .and_then(|_| temp.write_all(&encrypted))
            .and_then(|_| temp.as_file().sync_all())
            .map_err(|e| e.to_string())?;
        match temp.persist_noclobber(path) {
            Ok(_) => {}
            Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => {
                self.read(&id)?;
            }
            Err(e) => return Err(e.error.to_string()),
        }
        Ok(id)
    }
    pub fn read(&self, id: &str) -> Result<Vec<u8>> {
        let path = self.path(id)?;
        let size = fs::metadata(&path).map_err(|e| e.to_string())?.len();
        if !(32..=64 * 1024 * 1024 + 32).contains(&size) {
            return Err("invalid encrypted version length".into());
        }
        let mut data = fs::read(path).map_err(|e| e.to_string())?;
        if &data[..4] != b"WPV1" {
            return Err("invalid encrypted version header".into());
        }
        let nonce: [u8; 12] = data[4..16]
            .try_into()
            .map_err(|_| "invalid version nonce")?;
        let bytes = self
            .key
            .open_in_place(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(id.as_bytes()),
                &mut data[16..],
            )
            .map_err(|_| "文件历史校验失败；未恢复损坏的数据。")?;
        if format!("{:x}", Sha256::digest(&*bytes)) != id {
            return Err("version checksum mismatch".into());
        }
        Ok(bytes.to_vec())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_binary_history_is_encrypted_and_tampering_fails() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::with_key(dir.path().to_path_buf(), &[7; 32]).unwrap();
        let bytes = b"synthetic-secret\0\xff exact bytes";
        let id = vault.put(bytes).unwrap();
        assert_eq!(vault.read(&id).unwrap(), bytes);
        let path = vault.path(&id).unwrap();
        let mut disk = fs::read(&path).unwrap();
        assert!(!disk.windows(16).any(|v| v == b"synthetic-secret"));
        disk[20] ^= 1;
        fs::write(path, disk).unwrap();
        assert!(vault.read(&id).is_err());
    }
}
