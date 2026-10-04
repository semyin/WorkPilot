//! Offline maintenance: no runtime, scheduler, model, or plugin is started here.
use crate::vault::{Result, Vault};
use serde_json::{Value, json};
use std::{
    collections::{BTreeSet, VecDeque},
    fs,
    path::Path,
};
use workpilot_contracts::*;
use workpilot_storage::Store;
mod reset;
#[cfg(test)]
mod tests;

pub fn apply(data: &Path, request: MaintenanceApply) -> Result<Value> {
    request.selection.validate().map_err(str::to_owned)?;
    let expected = if matches!(request.selection, MaintenanceSelection::Reset) {
        "RESET"
    } else {
        "DELETE"
    };
    if request.confirmation != expected {
        return Err("确认文字不匹配，未处理数据 / Confirmation does not match".into());
    }
    let mut store = Store::open_exclusive(data).map_err(|e| e.to_string())?;
    let data = data.canonicalize().map_err(|e| e.to_string())?;
    // A previous explicit reset is retryable even if only file/credential cleanup remains.
    if matches!(request.selection, MaintenanceSelection::Reset)
        && !store
            .maintenance_cleanup_pending()
            .map_err(|e| e.to_string())?
            .is_null()
    {
        return reset::finish(&mut store, &data);
    }
    let plan = store
        .maintenance_plan(&request.selection)
        .map_err(|e| e.to_string())?;
    if plan.fingerprint != request.fingerprint {
        return Err("数据在预览后已变化，未执行清理，请重启后重新预览 / Data changed; restart and preview again".into());
    }
    if matches!(request.selection, MaintenanceSelection::Reset) {
        reset::preflight(&store, &data)?;
    }
    let backup = if !plan.revisions.is_empty() {
        Some(crate::transfer::maintenance_backup::backup(
            &store,
            &data,
            &plan.revisions,
            request.backup_path.as_deref().ok_or("请选择备份保存位置")?,
            &request.backup_password.as_ref().ok_or("请输入备份口令")?.0,
        )?)
    } else {
        None
    };
    // The backup has been fsynced and decrypted successfully before changing any history row.
    store
        .maintenance_apply_rows(&plan, backup.as_ref())
        .map_err(|e| e.to_string())?;
    if matches!(request.selection, MaintenanceSelection::Reset) {
        return reset::finish(&mut store, &data);
    }
    let gc = (|| -> Result<Value> {
        let records = store
            .collect_unreferenced_objects()
            .map_err(|e| e.to_string())?;
        let versions = collect_versions(&store, &data)?;
        Ok(
            json!({"record_objects":records,"encrypted_objects":versions.0,"encrypted_bytes":versions.1}),
        )
    })();
    // Database changes are committed. A filesystem failure must not be presented as a rollback.
    Ok(
        json!({"state":"completed","deleted_tasks":plan.tasks.len(),"pruned_versions":plan.revisions.len(),"deleted_archives":plan.archives.len(),"backup":backup,"cleanup":gc.as_ref().ok(),"cleanup_error":gc.err(),"project_files_preserved":true,"restart_required":true}),
    )
}
pub fn resume_pending(data: &Path) -> Result<()> {
    let mut store = Store::open_exclusive(data).map_err(|e| e.to_string())?;
    if !store
        .maintenance_cleanup_pending()
        .map_err(|e| e.to_string())?
        .is_null()
    {
        let data = data.canonicalize().map_err(|e| e.to_string())?;
        reset::finish(&mut store, &data)?;
    }
    Ok(())
}
fn hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn hashes(value: &Value, ids: &mut BTreeSet<String>) {
    match value {
        Value::String(s) if hash(s) => {
            ids.insert(s.clone());
        }
        Value::Array(a) => {
            for v in a {
                hashes(v, ids);
            }
        }
        Value::Object(o) => {
            for v in o.values() {
                hashes(v, ids);
            }
        }
        _ => (),
    }
}
fn collect_versions(store: &Store, data: &Path) -> Result<(u64, u64)> {
    let directory = data.join("versions");
    if !directory.exists() {
        return Ok((0, 0));
    }
    reset::plain_tree(&directory, data)?;
    let inventory = fs::read_dir(&directory)
        .map_err(|e| e.to_string())?
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    let available: BTreeSet<_> = inventory
        .iter()
        .filter_map(|e| {
            e.file_name()
                .to_str()
                .filter(|s| hash(s))
                .map(str::to_owned)
        })
        .collect();
    let mut live = store.maintenance_vault_roots().map_err(|e| e.to_string())?;
    for id in store
        .maintenance_required_vault_roots()
        .map_err(|e| e.to_string())?
    {
        if !available.contains(&id) {
            return Err("仍在使用的加密内容缺失，已暂停版本回收 / Referenced encrypted content is missing; collection stopped".into());
        }
        live.insert(id);
    }
    let mut queue: VecDeque<_> = live
        .iter()
        .filter(|id| available.contains(*id))
        .cloned()
        .collect();
    let vault = Vault::open(data)?;
    // Follow staged file manifests transitively, including those in resumable migration receipts.
    // Unknown hash-like values are conservatively retained, never guessed to be garbage.
    while let Some(id) = queue.pop_front() {
        let bytes = vault.read(&id)?;
        if bytes.len() <= 4 * 1024 * 1024
            && let Ok(value) = serde_json::from_slice::<Value>(&bytes)
        {
            let mut found = BTreeSet::new();
            hashes(&value, &mut found);
            for id in found {
                if available.contains(&id) && live.insert(id.clone()) {
                    queue.push_back(id);
                }
            }
        }
    }
    let mut removed = 0;
    let mut bytes = 0;
    for entry in inventory {
        let name = entry.file_name().to_string_lossy().into_owned();
        if hash(&name) && !live.contains(&name) {
            let path = entry.path();
            reset::plain_tree(&path, data)?;
            if entry.file_type().map_err(|e| e.to_string())?.is_file() {
                let size = entry.metadata().map_err(|e| e.to_string())?.len();
                fs::remove_file(path).map_err(|e| e.to_string())?;
                removed += 1;
                bytes += size;
            }
        }
    }
    Ok((removed, bytes))
}
