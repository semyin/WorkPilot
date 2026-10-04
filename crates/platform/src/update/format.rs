use super::{MAX_PACKAGE, Result, TRUST, io};
use ring::signature::{ED25519, UnparsedPublicKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, io::Read};

pub const MAGIC: &[u8; 8] = b"WPUPDT01";
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub format: u32,
    pub version: String,
    pub platform: String,
    pub notes: String,
    pub database_min: u32,
    pub database_target: u32,
    pub application: Vec<String>,
    pub tools: Vec<String>,
    pub files: Vec<Entry>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Preview {
    pub version: String,
    pub current_version: String,
    pub notes: String,
    pub bytes: u64,
    pub files: usize,
    pub fingerprint: String,
    pub key_id: String,
    pub application: Vec<String>,
    pub tools: Vec<String>,
    pub database_min: u32,
    pub database_target: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    key_id: String,
    manifest: String,
    signature: String,
}
#[derive(Deserialize)]
struct Trust {
    key_id: String,
    public_key: String,
}
pub(crate) fn hex(text: &str, length: usize) -> Result<Vec<u8>> {
    if text.len() != length * 2 || !text.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("更新签名或摘要格式不正确。".into());
    }
    (0..length)
        .map(|i| {
            u8::from_str_radix(&text[i * 2..i * 2 + 2], 16)
                .map_err(|_| "更新签名格式不正确。".into())
        })
        .collect()
}
pub(crate) fn path_ok(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 1024
        && !path.contains(['\\', ':', '\0'])
        && path.split('/').all(|part| {
            let stem = part.split('.').next().unwrap_or("").to_ascii_lowercase();
            !part.is_empty()
                && !matches!(part, "." | "..")
                && !part.ends_with(['.', ' '])
                && !part.chars().any(char::is_control)
                && !matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
                && !(stem.len() == 4
                    && (stem.starts_with("com") || stem.starts_with("lpt"))
                    && stem.as_bytes()[3].is_ascii_digit())
        })
}
impl Manifest {
    pub(crate) fn validate(&self, current: &str) -> Result<u64> {
        let version = semver::Version::parse(&self.version).map_err(|_| "更新版本格式不正确。")?;
        let current = semver::Version::parse(current).map_err(|_| "当前版本格式不正确。")?;
        if self.format != 1
            || version <= current
            || self.platform != "windows-x86_64"
            || self.notes.len() > 16384
            || self.files.is_empty()
            || self.files.len() > 100000
            || self.database_min > self.database_target
            || self.database_target > 10000
            || self.application.len() > 32
            || self.tools.len() > 32
            || self
                .application
                .iter()
                .chain(&self.tools)
                .any(|x| x.is_empty() || x.len() > 256)
        {
            return Err("更新版本、平台或数据兼容范围不适用；不允许降级。".into());
        }
        let mut paths = BTreeSet::new();
        let mut bytes = 0u64;
        for file in &self.files {
            if !path_ok(&file.path)
                || !paths.insert(file.path.to_ascii_lowercase())
                || file.bytes > 4 * 1024 * 1024 * 1024
            {
                return Err("更新文件路径重复、越界或过大。".into());
            }
            hex(&file.sha256, 32)?;
            bytes = bytes.checked_add(file.bytes).ok_or("更新过大。")?;
        }
        for path in &paths {
            let mut prefix = String::new();
            for part in path
                .split('/')
                .take(path.split('/').count().saturating_sub(1))
            {
                if !prefix.is_empty() {
                    prefix.push('/');
                }
                prefix.push_str(part);
                if paths.contains(&prefix) {
                    return Err("更新文件与目录重名。".into());
                }
            }
        }
        if bytes > MAX_PACKAGE
            || ![
                "workpilot-desktop.exe",
                "workpilot-sidecar.exe",
                "workpilot-update.exe",
            ]
            .iter()
            .all(|p| paths.contains(*p))
        {
            return Err("更新不完整或超过容量限制。".into());
        }
        Ok(bytes)
    }
}
pub fn inspect(reader: &mut impl Read, current: &str) -> Result<(Preview, Manifest)> {
    inspect_with_trust(reader, current, TRUST)
}
pub(crate) fn inspect_with_trust(
    reader: &mut impl Read,
    current: &str,
    trust: &str,
) -> Result<(Preview, Manifest)> {
    verify(&read_envelope(reader)?, current, trust)
}
pub(crate) fn read_envelope(reader: &mut impl Read) -> Result<Envelope> {
    let mut magic = [0; 8];
    io(reader.read_exact(&mut magic), "无法读取更新包")?;
    if &magic != MAGIC {
        return Err("这不是 WorkPilot 签名更新包。".into());
    }
    let mut length = [0; 4];
    io(reader.read_exact(&mut length), "更新包头不完整")?;
    let length = u32::from_le_bytes(length) as usize;
    if !(16..=16 * 1024 * 1024).contains(&length) {
        return Err("更新清单大小不正确。".into());
    }
    let mut bytes = vec![0; length];
    io(reader.read_exact(&mut bytes), "更新清单不完整")?;
    serde_json::from_slice(&bytes).map_err(|_| "更新清单格式错误。".into())
}
pub(crate) fn verify(
    envelope: &Envelope,
    current: &str,
    trust: &str,
) -> Result<(Preview, Manifest)> {
    let trust: Trust = serde_json::from_str(trust).map_err(|_| "本程序的更新信任配置损坏。")?;
    if trust.key_id != envelope.key_id {
        return Err("更新签名来自未信任的发布者。".into());
    }
    UnparsedPublicKey::new(&ED25519, hex(&trust.public_key, 32)?)
        .verify(envelope.manifest.as_bytes(), &hex(&envelope.signature, 64)?)
        .map_err(|_| "更新签名验证失败；请重新取得可信更新包。")?;
    let manifest: Manifest =
        serde_json::from_str(&envelope.manifest).map_err(|_| "签名更新内容格式错误。")?;
    let bytes = manifest.validate(current)?;
    let preview = Preview {
        version: manifest.version.clone(),
        current_version: current.into(),
        notes: manifest.notes.clone(),
        bytes,
        files: manifest.files.len(),
        fingerprint: format!("{:x}", Sha256::digest(envelope.manifest.as_bytes())),
        key_id: trust.key_id,
        application: manifest.application.clone(),
        tools: manifest.tools.clone(),
        database_min: manifest.database_min,
        database_target: manifest.database_target,
    };
    Ok((preview, manifest))
}
