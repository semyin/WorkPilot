//! Portable file metadata and deterministic source-to-target mapping.
use super::{
    codec::{self, ArchiveIndex},
    *,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Entry {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct FileIndex {
    pub version: u32,
    pub archive_id: String,
    pub created_at_ms: u64,
    pub files: Vec<Entry>,
}
pub(super) fn safe_path(path: &str) -> Result<()> {
    workpilot_tools::binary::user_path(path).map_err(|e| e.to_string())?;
    if path.contains('\\') {
        return Err("备份路径必须使用 / / Invalid archive path separator".into());
    }
    for part in path.split('/') {
        let name = part.to_lowercase();
        if workpilot_tools::binary::EXCLUDED.contains(&name.as_str())
            || name == ".env"
            || name.starts_with(".env.")
            || name == ".ssh"
            || [
                "credentials.json",
                "credentials",
                "id_rsa",
                "id_ed25519",
                "id_ecdsa",
                "tokens.json",
            ]
            .contains(&name.as_str())
            || [
                ".pem",
                ".key",
                ".pfx",
                ".p12",
                ".wpfiles",
                ".wphistory",
                ".wpsettings",
                ".wpextensions",
            ]
            .iter()
            .any(|ext| name.ends_with(ext))
        {
            return Err("不能迁移凭据文件、内部环境或其它备份 / Credential, internal environment or archive files are excluded".into());
        }
    }
    Ok(())
}
impl ArchiveIndex for FileIndex {
    const MAGIC: &'static [u8; 8] = b"WPFILE01";
    fn objects(&self) -> Result<BTreeMap<String, u64>> {
        if self.version != 1
            || uuid::Uuid::parse_str(&self.archive_id).is_err()
            || self.files.is_empty()
            || self.files.len() > 128
        {
            return Err("项目文件备份版本或数量无效 / Invalid project file archive".into());
        }
        let mut objects = BTreeMap::new();
        let mut names = HashSet::new();
        let mut ancestors = HashMap::new();
        let mut total = 0u64;
        for file in &self.files {
            safe_path(&file.path)?;
            if !names.insert(file.path.to_lowercase())
                || file.bytes > 64 * 1024 * 1024
                || file.sha256.len() != 64
                || !file
                    .sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err(
                    "文件重复、过大或校验无效 / Duplicate, oversized or invalid file".into(),
                );
            }
            total += file.bytes;
            if total > codec::MAX_TOTAL {
                return Err("所选文件总量超过 256 MiB / Files exceed 256 MiB".into());
            }
            if let Some(old) = objects.insert(file.sha256.clone(), file.bytes)
                && old != file.bytes
            {
                return Err("文件校验大小不一致 / Inconsistent file size".into());
            }
            let mut prefix = String::new();
            for part in file.path.split('/') {
                if !prefix.is_empty() {
                    prefix.push('/');
                }
                prefix.push_str(part);
                if let Some(old) = ancestors.insert(prefix.to_lowercase(), prefix.clone())
                    && old != prefix
                {
                    return Err("路径大小写冲突 / Path case collision".into());
                }
            }
        }
        for path in &names {
            if path
                .match_indices('/')
                .any(|(i, _)| names.contains(&path[..i]))
            {
                return Err("文件与文件夹路径冲突 / File and directory path collision".into());
            }
        }
        Ok(objects)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ImportPlan {
    pub(super) index: FileIndex,
    pub task: String,
    pub root_identity: String,
    pub prefix: String,
    pub archive_sha256: String,
}
impl ImportPlan {
    pub fn paths(&self) -> Result<Vec<String>> {
        self.index.objects()?;
        if !self.prefix.is_empty() {
            safe_path(&self.prefix)?;
        }
        self.index
            .files
            .iter()
            .map(|f| {
                let path = if self.prefix.is_empty() {
                    f.path.clone()
                } else {
                    format!("{}/{}", self.prefix, f.path)
                };
                safe_path(&path)?;
                Ok(path)
            })
            .collect()
    }
    pub fn operation_id(&self) -> String {
        format!(
            "files-{}",
            codec::digest(
                json!([
                    self.archive_sha256,
                    self.task,
                    self.root_identity,
                    self.prefix
                ])
                .to_string()
                .as_bytes()
            )
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn index(paths: &[&str]) -> FileIndex {
        FileIndex {
            version: 1,
            archive_id: uuid::Uuid::new_v4().to_string(),
            created_at_ms: 0,
            files: paths
                .iter()
                .map(|p| Entry {
                    path: p.to_string(),
                    bytes: 0,
                    sha256: codec::digest(&[]),
                })
                .collect(),
        }
    }
    #[test]
    fn rejects_ambiguous_paths_credentials_and_counts() {
        for paths in [
            vec!["a", "a"],
            vec!["A", "a"],
            vec!["a", "a/b"],
            vec!["Dir/a", "dir/b"],
            vec!["../a"],
            vec![".env"],
            vec![".git/x"],
            vec!["node_modules/x"],
            vec!["id_rsa"],
            vec!["x.key"],
            vec!["dir\\a"],
        ] {
            assert!(index(&paths).objects().is_err(), "{paths:?}");
        }
        assert!(
            index(&["资料/图片.bin", "资料/空 格.txt"])
                .objects()
                .is_ok()
        );
        let mut too_big = index(&["a"]);
        too_big.files[0].bytes = 64 * 1024 * 1024 + 1;
        assert!(too_big.objects().is_err());
    }
    #[test]
    fn file_archive_is_authenticated_and_distinct_from_history() {
        let stop = AtomicBool::new(false);
        let mut bytes = vec![];
        codec::write_index(&mut bytes, "long-passphrase", &index(&["a"]), &stop, |_| {
            Ok(vec![])
        })
        .unwrap();
        assert!(
            codec::read_index::<FileIndex>(&bytes[..], "long-passphrase", &stop, |_, _| Ok(()))
                .is_ok()
        );
        assert!(
            codec::read_index::<FileIndex>(&bytes[..], "wrong-password", &stop, |_, _| Ok(()))
                .is_err()
        );
        assert!(codec::read(&bytes[..], "long-passphrase", &stop, |_, _| Ok(())).is_err());
        *bytes.last_mut().unwrap() ^= 1;
        assert!(
            codec::read_index::<FileIndex>(&bytes[..], "long-passphrase", &stop, |_, _| Ok(()))
                .is_err()
        );
    }
}
