//! Portable installed packages. Activation and credentials deliberately stay local.
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use std::collections::HashSet;
#[cfg(test)]
mod tests;

mod export;
const MAX_TOTAL: usize = 64 * 1024 * 1024;
struct Prepared {
    candidate: ExtensionImportCandidate,
    files: package::Contents,
    was_enabled: bool,
    previous: Vec<(PluginVersion, package::Contents)>,
}
fn check(stop: &AtomicBool) -> Result<()> {
    if stop.load(Ordering::SeqCst) {
        Err("扩展迁移已取消 / Extension transfer cancelled".into())
    } else {
        Ok(())
    }
}
impl Manager {
    pub async fn export_transfer(
        &self,
        scope: Option<&str>,
        selections: &[ExtensionSelection],
        stop: &AtomicBool,
    ) -> Result<ExtensionTransferBundle> {
        self.export_transfer_complete(scope, selections, false, &[], stop)
            .await
    }

    async fn prepare_transfer(
        &self,
        bundle: &ExtensionTransferBundle,
        scope: Option<&str>,
        stop: &AtomicBool,
    ) -> Result<Vec<Prepared>> {
        if ![1, 2].contains(&bundle.version)
            || uuid::Uuid::parse_str(&bundle.archive_id).is_err()
            || bundle.entries.is_empty()
            || bundle.entries.len() > 32
        {
            return Err("不支持的扩展备份格式或数量 / Unsupported extension archive".into());
        }
        let mut ids = HashSet::new();
        let mut scopes = HashSet::new();
        let mut prepared = Vec::new();
        let mut total = 0;
        let mut count = 0;
        for entry in &bundle.entries {
            check(stop)?;
            if !valid_id(&entry.source_id)
                || !ids.insert(&entry.source_id)
                || entry.files.is_empty()
                || entry.files.len() > package::MAX_FILES
            {
                return Err("扩展备份包含重复或无效条目 / Invalid extension archive entry".into());
            }
            let target = if entry.project_scoped {
                Some(scope.ok_or("包含项目扩展，请选择绑定目标文件夹的任务 / Select a task with a target project folder")?.to_owned())
            } else {
                None
            };
            let mut files = package::Contents::new();
            for file in &entry.files {
                check(stop)?;
                if file.base64.len() > package::MAX_FILE.div_ceil(3) * 4 {
                    return Err("扩展文件超过 8 MiB / Extension file exceeds 8 MiB".into());
                }
                let bytes = STANDARD
                    .decode(&file.base64)
                    .map_err(|_| "扩展文件编码无效 / Invalid extension file encoding")?;
                total += bytes.len();
                count += 1;
                if total > MAX_TOTAL
                    || count > 2048
                    || files.insert(file.path.clone(), bytes).is_some()
                {
                    return Err("扩展备份超限或含重复文件 / Extension archive exceeds limits or contains duplicate files".into());
                }
            }
            let (version, files) = package::validate(files)?;
            if version.digest != entry.digest
                || (!entry.draft && !scopes.insert((target.clone(), version.manifest.id.clone())))
            {
                return Err(
                    "扩展内容摘要不符或目标重名 / Extension checksum mismatch or duplicate target"
                        .into(),
                );
            }
            if entry.earlier.len() > 127
                || (bundle.version == 1
                    && (!entry.earlier.is_empty() || entry.draft || !entry.installed))
                || (entry.draft
                    && (!entry.earlier.is_empty() || entry.installed || entry.was_enabled))
            {
                return Err("Invalid extension history or draft state".into());
            }
            let mut previous = vec![];
            let mut digests = HashSet::from([version.digest.clone()]);
            for earlier in &entry.earlier {
                check(stop)?;
                let mut contents = package::Contents::new();
                for f in &earlier.files {
                    if f.base64.len() > package::MAX_FILE.div_ceil(3) * 4 {
                        return Err("Extension version file too large".into());
                    }
                    let bytes = STANDARD
                        .decode(&f.base64)
                        .map_err(|_| "Invalid extension version encoding")?;
                    total += bytes.len();
                    count += 1;
                    if total > MAX_TOTAL
                        || count > 2048
                        || contents.insert(f.path.clone(), bytes).is_some()
                    {
                        return Err("Extension history exceeds limits or duplicates files".into());
                    }
                }
                let (mut v, contents) = package::validate(contents)?;
                if v.digest != earlier.digest
                    || v.manifest.id != version.manifest.id
                    || !digests.insert(v.digest.clone())
                {
                    return Err("Invalid historical extension ownership or checksum".into());
                }
                v.created_at_ms = earlier.created_at_ms;
                previous.push((v, contents));
            }
            prepared.push(Prepared {
                candidate: ExtensionImportCandidate {
                    source_id: entry.source_id.clone(),
                    scope: target,
                    earlier: previous.iter().map(|(v, _)| v.clone()).collect(),
                    draft: entry.draft,
                    installed: entry.installed,
                    version,
                },
                files,
                was_enabled: entry.was_enabled,
                previous,
            });
        }
        self.0
            .storage
            .call(move |store| {
                for item in &prepared {
                    for bytes in item
                        .files
                        .values()
                        .chain(item.previous.iter().flat_map(|(_, f)| f.values()))
                    {
                        store.extension_content_allowed(&String::from_utf8_lossy(bytes))?;
                    }
                }
                Ok(prepared)
            })
            .await
            .map_err(|e| format!("无法核验扩展内容 / Cannot validate extension contents: {e}"))
    }

    pub async fn inspect_transfer(
        &self,
        scope: Option<&str>,
        bundle: &ExtensionTransferBundle,
        digest: &str,
        stop: &AtomicBool,
    ) -> Result<Value> {
        self.ensure_builtin().await?;
        let _guard = self.0.gate.lock().await;
        let prepared = self.prepare_transfer(bundle, scope, stop).await?;
        let (archive, target, sha) = (
            bundle.archive_id.clone(),
            scope.map(str::to_owned),
            digest.to_owned(),
        );
        let candidates = prepared
            .iter()
            .map(|p| p.candidate.clone())
            .collect::<Vec<_>>();
        let state = self
            .0
            .storage
            .call(move |s| {
                s.extension_transfer_preview(&archive, target.as_deref(), &sha, &candidates)
            })
            .await
            .map_err(|e| e.to_string())?;
        let mut entries = Vec::new();
        for item in &prepared {
            let v = &item.candidate.version;
            let mut warnings = v.warnings.clone();
            if let Err(error) = self.dependencies(v, item.candidate.scope.as_deref()).await {
                warnings.push(error);
            }
            for server in &v.manifest.servers {
                if let McpTransport::Stdio { runtime, entry, .. } = &server.transport
                    && let Err(error) =
                        runtime_command(*runtime, &self.version_path(&v.digest).join(entry))
                {
                    warnings.push(error);
                }
            }
            entries.push(json!({"source_id":item.candidate.source_id,"project_scoped":item.candidate.scope.is_some(),"was_enabled":item.was_enabled,"draft":item.candidate.draft,"installed":item.candidate.installed,"versions":item.candidate.earlier.iter().map(|v|json!({"digest":v.digest,"version":v.manifest.version,"files":v.files,"permissions":v.permissions})).collect::<Vec<_>>(),
                "manifest":v.manifest,"files":v.files,"skills":v.skills,"permissions":v.permissions,"warnings":warnings,"digest":v.digest}));
        }
        Ok(
            json!({"entries":entries,"state":state,"conflicts":state["conflicts"],"already_imported":state["already_imported"],"credentials_included":false,"enabled":false}),
        )
    }

    pub async fn import_transfer(
        &self,
        scope: Option<&str>,
        bundle: &ExtensionTransferBundle,
        digest: &str,
        expected: &Value,
        stop: &AtomicBool,
    ) -> Result<Value> {
        let _guard = self.0.gate.lock().await;
        let prepared = self.prepare_transfer(bundle, scope, stop).await?;
        let (archive, target, sha) = (
            bundle.archive_id.clone(),
            scope.map(str::to_owned),
            digest.to_owned(),
        );
        let candidates = prepared
            .iter()
            .map(|p| p.candidate.clone())
            .collect::<Vec<_>>();
        let (a, t, d, c) = (
            archive.clone(),
            target.clone(),
            sha.clone(),
            candidates.clone(),
        );
        let state = self
            .0
            .storage
            .call(move |s| s.extension_transfer_preview(&a, t.as_deref(), &d, &c))
            .await
            .map_err(|e| e.to_string())?;
        if &state != expected {
            return Err(
                "目标扩展已变化，请重新预览 / Target extensions changed; preview again".into(),
            );
        }
        if state["already_imported"] == true {
            return Ok(json!({"kind":"imported","duplicate":true,"receipt":state["receipt"]}));
        }
        if state["conflicts"].as_array().is_none_or(|v| !v.is_empty()) {
            return Err(
                "目标存在同名扩展，未导入 / Conflicting target extensions; nothing imported".into(),
            );
        }
        let directory = self.0.data.join("extensions/versions");
        std::fs::create_dir_all(&directory)
            .map_err(|_| "无法创建扩展目录 / Cannot prepare extension directory")?;
        for item in &prepared {
            check(stop)?;
            for (version, files) in std::iter::once((&item.candidate.version, &item.files))
                .chain(item.previous.iter().map(|(v, f)| (v, f)))
            {
                let destination = self.version_path(&version.digest);
                if !destination.exists() {
                    let temporary =
                        tempfile::tempdir_in(&directory).map_err(|_| "Cannot stage extension")?;
                    let staged = temporary.path().join("package");
                    package::write_new(&staged, files)?;
                    check(stop)?;
                    std::fs::rename(&staged, &destination)
                        .map_err(|_| "无法完成扩展落盘 / Cannot persist extension package")?;
                }
                for file in &version.files {
                    package::read_verified(&destination, version, &file.path)?;
                }
            }
        }
        check(stop)?;
        let receipt = self
            .0
            .storage
            .call(move |s| {
                s.import_extensions(&archive, target.as_deref(), &sha, &candidates, &state)
            })
            .await
            .map_err(|e| e.to_string())?;
        Ok(json!({"kind":"imported","duplicate":false,"receipt":receipt}))
    }
}
