use super::*;
use workpilot_storage::Store;

/// Back up precisely the revisions about to be pruned, then decrypt and verify the saved file.
pub(crate) fn backup(
    store: &Store,
    data: &Path,
    rows: &[FileRevision],
    path: &str,
    password: &str,
) -> Result<Value> {
    HistoryTransferAction::Export {
        revision_ids: rows.iter().map(|r| r.id.clone()).collect(),
        path: path.into(),
        password: SecretInput(password.into()),
    }
    .validate()
    .map_err(str::to_owned)?;
    let destination = PathBuf::from(path);
    let parent = destination.parent().ok_or("Invalid backup path")?;
    codec::plain(parent, true)?;
    if !destination.is_absolute()
        || destination.exists()
        || parent
            .canonicalize()
            .map_err(|e| e.to_string())?
            .starts_with(data)
    {
        return Err(
            "请将备份存到应用数据目录以外的新文件 / Choose a new backup outside app data".into(),
        );
    }
    let manifest = Manifest {
        version: 1,
        archive_id: uuid::Uuid::new_v4().to_string(),
        created_at_ms: workpilot_storage::now_ms(),
        revisions: rows
            .iter()
            .map(|r| {
                let image = |i: &FileImage| Image {
                    exists: i.version.exists,
                    bytes: i.version.bytes,
                    sha256: i.version.sha256.clone(),
                };
                Revision {
                    id: r.id.clone(),
                    task_id: r.task_id.clone(),
                    operation_id: r.operation_id.clone(),
                    path: r.path.clone(),
                    previous_path: r.previous_path.clone(),
                    change: r.change.clone(),
                    source: r.source.clone(),
                    at_ms: r.at_ms,
                    before: image(&r.before),
                    after: image(&r.after),
                    origin: r.origin.clone(),
                }
            })
            .collect(),
    };
    manifest.objects()?;
    let vault = Vault::open(data)?;
    let mut references = BTreeMap::new();
    for r in rows {
        for image in [&r.before, &r.after] {
            if image.version.exists {
                references.insert(
                    image
                        .version
                        .sha256
                        .clone()
                        .ok_or("Missing image checksum")?,
                    image.blob.clone().ok_or("Missing image content")?,
                );
            }
        }
    }
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    let stop = AtomicBool::new(false);
    codec::write(&mut temp, password, &manifest, &stop, |sha| {
        let id = references.get(sha).ok_or("Missing history object")?;
        if let Some(id) = id.strip_prefix("legacy:") {
            store.legacy_file_bytes(id).map_err(|e| e.to_string())
        } else {
            vault.read(id)
        }
    })?;
    temp.as_file_mut().sync_all().map_err(|e| e.to_string())?;
    codec::plain(parent, true)?;
    temp.persist_noclobber(&destination)
        .map_err(|_| "备份位置已存在或写入失败 / Backup destination changed")?;
    let file = fs::File::open(&destination).map_err(|e| e.to_string())?;
    let (check, sha) = codec::read(file, password, &stop, |_, _| Ok(()))?;
    if check.archive_id != manifest.archive_id || check.revisions.len() != rows.len() {
        return Err("Backup verification failed".into());
    }
    Ok(
        json!({"path":path,"sha256":sha,"archive_id":manifest.archive_id,"revisions":rows.len(),"verified":true}),
    )
}
