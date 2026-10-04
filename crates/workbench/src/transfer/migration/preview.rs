use super::*;
use std::collections::HashSet;

impl Manager {
    pub(super) async fn preview_migration(
        &self,
        bundle: &Bundle,
        blobs: &BTreeMap<String, Vec<u8>>,
        digest: &str,
        destinations: &[MigrationDestination],
        history: &[MigrationHistoryMapping],
        extensions: &workpilot_extensions::Manager,
    ) -> Result<Value> {
        if destinations.len() != bundle.projects.len() {
            return Err("每个项目都需要目标位置 / Every project needs a destination".into());
        }
        let mut seen = HashSet::new();
        let mut roots = HashSet::new();
        let mut names = HashSet::new();
        let mut targets = vec![];
        let mut conflicts = vec![];
        for source in &bundle.projects {
            let source_id = &source.settings.project.id;
            let d = destinations
                .iter()
                .find(|d| &d.source_project_id == source_id)
                .ok_or("Missing project destination")?;
            if !seen.insert(source_id) || !names.insert(d.name.trim().to_lowercase()) {
                return Err("目标项目名称重复 / Duplicate destination name".into());
            }
            let root = Root::open(&d.root_path, None)
                .map_err(|_| "目标文件夹不存在或无法访问 / Destination folder unavailable")?;
            if !roots.insert(root.identity.clone()) {
                return Err("多个原项目不能静默合并到同一个目录 / Choose a distinct folder for each project".into());
            }
            let (settings, identity, name, sha) = (
                source.settings.clone(),
                root.identity.clone(),
                d.name.clone(),
                codec::digest(
                    &serde_json::to_vec(&source.settings).map_err(|_| "Invalid settings")?,
                ),
            );
            let state = self
                .storage
                .call(move |s| s.project_import_preview(&settings, &identity, &name, &sha))
                .await
                .map_err(|e| e.to_string())?;
            conflicts.extend(state["conflicts"].as_array().cloned().unwrap_or_default());
            let mut files = vec![];
            if let Some(index) = &source.files {
                for file in &index.files {
                    let current = root
                        .binary_snapshot(&file.path)
                        .map_err(|e| e.to_string())?;
                    if current.version.exists {
                        // A previous confirmed import is handled through its durable operation.
                        files.push(json!({"path":file.path,"exists":true,"bytes":file.bytes}));
                    } else {
                        files.push(json!({"path":file.path,"exists":false,"bytes":file.bytes}));
                    }
                }
            }
            let extension = if let Some(b) = &source.extensions {
                let sha =
                    codec::digest(&serde_json::to_vec(b).map_err(|_| "Invalid extension bundle")?);
                let p = extensions
                    .inspect_transfer(Some(&root.identity), b, &sha, &self.stop)
                    .await?;
                if let Some(c) = p["conflicts"].as_array() {
                    conflicts.extend(c.clone());
                }
                p
            } else {
                Value::Null
            };
            targets.push(json!({"source_project_id":source_id,"root_identity":root.identity,
                "root_path":root.path.to_string_lossy(),"name":d.name.trim(),"state":state,"files":files,"extensions":extension}));
        }
        let required = bundle
            .tasks
            .iter()
            .flat_map(|t| &t.file_history)
            .map(|h| h.root_identity.as_str())
            .collect::<HashSet<_>>();
        let existing = targets
            .iter()
            .find_map(|t| t["state"]["destination_state"].as_array());
        if let Some(existing) = existing {
            let pending = bundle
                .projects
                .iter()
                .filter(|p| {
                    targets.iter().any(|t| {
                        t["source_project_id"] == p.settings.project.id
                            && t["state"]["already_imported"] != true
                    })
                })
                .collect::<Vec<_>>();
            if existing[0].as_u64().unwrap_or_default()
                + pending
                    .iter()
                    .map(|p| p.settings.profiles.len() as u64)
                    .sum::<u64>()
                > 128
            {
                conflicts.push(json!("全部所选项目的模型配置合计超过 128 项 / Combined selected models exceed 128 configurations"));
            }
            if existing[1].as_u64().unwrap_or_default()
                + pending
                    .iter()
                    .map(|p| p.settings.memories.len() as u64)
                    .sum::<u64>()
                > 4096
            {
                conflicts.push(json!("全部所选项目的记忆合计超过 4096 条 / Combined selected memories exceed 4096 entries"));
            }
        }
        let mut mapped = HashSet::new();
        if history.iter().any(|h| {
            !required.contains(h.source_root.as_str())
                || !mapped.insert(h.source_root.as_str())
                || !seen.contains(&h.source_project_id)
        }) || mapped != required
        {
            return Err("请为每个历史原文件夹指定目标项目 / Map every historical source folder to a selected destination project".into());
        }
        let binding = codec::digest(
            json!([
                digest,
                targets
                    .iter()
                    .map(|t| json!([
                        t["source_project_id"],
                        t["root_identity"],
                        t["root_path"],
                        t["name"]
                    ]))
                    .collect::<Vec<_>>(),
                history
            ])
            .to_string()
            .as_bytes(),
        );
        let id = bundle.archive_id.clone();
        let receipt = self
            .storage
            .call(move |s| s.migration_receipt(&id))
            .await
            .map_err(|e| e.to_string())?;
        if receipt.as_ref().is_some_and(|r| r["binding"] != binding) {
            return Err("这份备份已按不同目标开始迁移，请使用原映射继续 / This archive already has a different destination mapping".into());
        }
        if receipt.is_none() {
            for target in &targets {
                if target["files"]
                    .as_array()
                    .is_some_and(|f| f.iter().any(|f| f["exists"] == true))
                {
                    conflicts.push(json!("选定文件在目标已存在，请使用空文件夹 / Selected destination files already exist; choose an empty folder"));
                }
            }
        }
        let mut recovery = vec![];
        for index in &bundle.tasks {
            let own = index
                .objects
                .iter()
                .map(|r| {
                    Ok((
                        r.object_id.clone(),
                        blobs
                            .get(&r.object_id)
                            .cloned()
                            .ok_or("Missing archive object")?,
                    ))
                })
                .collect::<Result<_>>()?;
            let raw = workpilot_storage::TaskArchiveBytes {
                index: index.clone(),
                blobs: own,
            };
            let rows = self
                .storage
                .call(move |s| s.task_archive_recovery_preview(&raw))
                .await
                .map_err(|e| e.to_string())?;
            recovery.extend(rows.as_array().cloned().ok_or("Invalid recovery preview")?);
        }
        Ok(
            json!({"kind":"preview","fingerprint":binding,"binding":binding,"summary":bundle.summary(),
            "targets":targets,"history_roots":history,"conflicts":conflicts,"receipt":receipt,"recovery":recovery,
            "rules":"分步导入，失败保留成功回执供重试；文件另行审批，任务须手动继续，未知效果须逐项人工核对。模型密钥重新填写，扩展停用。 / Resumable import; files need approval, tasks need manual continuation, unknown effects need human review. Re-enter credentials; extensions stay disabled."}),
        )
    }
}
