use super::*;
use serde_json::{Value, json};
use std::collections::HashMap;

impl Store {
    pub fn export_project_settings(
        &self,
        project: &str,
        profiles: &[String],
        memories: &[String],
        include_memory_history: bool,
    ) -> Result<ProjectTransferBundle> {
        let mut p = self.workspace_project(project)?;
        let available = self.export_profiles()?.profiles;
        let profiles = profiles
            .iter()
            .map(|id| {
                available
                    .iter()
                    .find(|p| &p.id == id)
                    .cloned()
                    .ok_or(Error::NotFound)
            })
            .collect::<Result<Vec<_>>>()?;
        if p.settings
            .default_profile_id
            .as_ref()
            .is_some_and(|id| !profiles.iter().any(|p| &p.id == id))
        {
            p.settings.default_profile_id = None;
        }
        let mut memory_history = Vec::new();
        let mut version_count = 0;
        if include_memory_history {
            for memory in memories {
                let history = self.transferred_memory_history(memory)?;
                version_count += history.versions.len();
                if version_count > 2048 {
                    return Err(Error::Invalid(
                        "记忆历史超过 2048 个版本，请减少选择 / Archive exceeds 2048 memory revisions",
                    ));
                }
                memory_history.push(history);
            }
        }
        let bundle = ProjectTransferBundle {
            version: if include_memory_history { 2 } else { 1 },
            archive_id: id(),
            created_at_ms: now_ms(),
            project: p,
            profiles,
            memory_history,
            memories: memories
                .iter()
                .map(|id| self.memory_get(id))
                .collect::<Result<Vec<_>>>()?,
        };
        bundle.validate().map_err(Error::Invalid)?;
        if self.redactor.contains_registered_secret(&encode(&bundle)?) {
            return Err(Error::Invalid(
                "所选设置包含已配置凭据，请先移除 / Selected settings contain a configured credential",
            ));
        }
        Ok(bundle)
    }
    pub fn project_import_preview(
        &self,
        bundle: &ProjectTransferBundle,
        root: &str,
        name: &str,
        digest: &str,
    ) -> Result<Value> {
        bundle.validate().map_err(Error::Invalid)?;
        let key = receipt_key(&bundle.archive_id, root);
        let old: Option<String> = self
            .connection
            .query_row(
                "SELECT value_json FROM settings WHERE key=?1",
                [&key],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(old) = old {
            let value: Value = serde_json::from_str(&old)?;
            if value["digest"] != digest {
                return Err(Error::Conflict);
            }
            return Ok(json!({"already_imported":true,"receipt":value,"conflicts":[]}));
        }
        let mut conflicts = vec![];
        let mut q = self.connection.prepare("SELECT p.id,p.data_json,w.root_identity FROM projects p LEFT JOIN project_workspace w ON w.project_id=p.id")?;
        for row in q.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })? {
            let (_, raw, identity) = row?;
            let p: Project = serde_json::from_str(&raw)?;
            if identity.as_deref() == Some(root) {
                conflicts.push("目标文件夹已经绑定项目 / Folder is already bound to a project");
            }
            if p.name.to_lowercase() == name.trim().to_lowercase() {
                conflicts.push(
                    "同名项目已存在，请使用新名称 / Project name already exists; choose a new name",
                );
            }
        }
        let profiles: usize =
            self.connection
                .query_row("SELECT count(*) FROM provider_profiles", [], |r| r.get(0))?;
        let memories: usize =
            self.connection
                .query_row("SELECT count(*) FROM memory_meta", [], |r| r.get(0))?;
        if profiles + bundle.profiles.len() > 128 {
            conflicts.push("模型配置将超过 128 项 / Model configuration limit would be exceeded");
        }
        if memories + bundle.memories.len() > 4096 {
            conflicts.push("记忆数量将超过 4096 条 / Memory limit would be exceeded");
        }
        // Counts and existing project revisions bind the preview to the current destination.
        let projects: Vec<(String, u32)> = {
            let mut q = self
                .connection
                .prepare("SELECT project_id,revision FROM project_workspace ORDER BY project_id")?;
            q.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<std::result::Result<_, _>>()?
        };
        Ok(
            json!({"already_imported":false,"conflicts":conflicts,"destination_state":[profiles,memories,projects]}),
        )
    }
    pub fn import_project_settings(
        &mut self,
        bundle: &ProjectTransferBundle,
        root_path: &str,
        root: &str,
        name: &str,
        digest: &str,
        expected: &Value,
    ) -> Result<(Value, Vec<Event>)> {
        let preview = self.project_import_preview(bundle, root, name, digest)?;
        if &preview != expected {
            return Err(Error::Conflict);
        }
        if preview["already_imported"] == true {
            return Ok((preview["receipt"].clone(), vec![]));
        }
        if preview["conflicts"]
            .as_array()
            .is_none_or(|a| !a.is_empty())
        {
            return Err(Error::Conflict);
        }
        let project_id = id();
        let mut profile_map = HashMap::new();
        let mut profiles = vec![];
        for source in &bundle.profiles {
            let mut p = source.without_credential();
            p.id = id();
            p.revision = 1;
            super::providers::clear_observed(&mut p);
            p.label = self.redactor.text(&p.label);
            while p.label.len() > 240 {
                p.label.pop();
            }
            p.label.push_str(" (imported)");
            p.model = self.redactor.text(&p.model);
            profile_map.insert(source.id.clone(), p.id.clone());
            profiles.push(p);
        }
        let project = Project {
            id: project_id.clone(),
            name: self.redactor.text(name.trim()),
            root_path: root_path.into(),
            default_profile_id: bundle
                .project
                .settings
                .default_profile_id
                .as_ref()
                .and_then(|id| profile_map.get(id))
                .cloned(),
            permission: PermissionMode::RequestApproval,
            created_at_ms: now_ms(),
        };
        let mut memories = vec![];
        let mut origins = vec![];
        for source in &bundle.memories {
            let versions = self.prepare_transferred_history(
                source,
                bundle
                    .memory_history
                    .iter()
                    .find(|h| h.memory_id == source.id),
                &project_id,
                &bundle.archive_id,
            )?;
            let memory = &versions
                .last()
                .ok_or(Error::Invalid("missing imported memory"))?
                .0;
            origins.push(json!({"source_id":source.id,"source_revision":source.revision,"source_task_id":source.source_task_id,"target_id":memory.memory.id,"history_versions":versions.len().saturating_sub(1),
                "version_sources":bundle.memory_history.iter().find(|h|h.memory_id==source.id).map(|h|h.versions.iter().map(|v|json!({"revision":v.revision,"source_task_id":v.source_task_id})).collect::<Vec<_>>()).unwrap_or_default()}));
            memories.extend(versions);
        }
        let receipt = json!({"project_id":project_id,"archive_id":bundle.archive_id,"source_project_id":bundle.project.id,"digest":digest,"profiles":profile_map,"memories":origins,"at_ms":now_ms()});
        let tx = self.connection.transaction()?;
        for p in profiles {
            let data = encode(&p)?;
            tx.execute(
                "INSERT INTO provider_profiles(id,data_json) VALUES(?1,?2)",
                params![p.id, data],
            )?;
            tx.execute(
                "INSERT INTO profile_versions(profile_id,revision,snapshot_json) VALUES(?1,1,?2)",
                params![p.id, data],
            )?;
        }
        tx.execute(
            "INSERT INTO projects(id,root_path,data_json) VALUES(?1,?2,?3)",
            params![project.id, root_path, encode(&project)?],
        )?;
        tx.execute("INSERT INTO project_workspace(project_id,rules,root_identity,revision) VALUES(?1,?2,?3,1)",params![project.id,self.redactor.text(&bundle.project.settings.rules),root])?;
        for (value, text) in memories {
            super::memory::write(&tx, &value, &text)?;
        }
        tx.execute(
            "INSERT INTO settings(key,value_json) VALUES(?1,?2)",
            params![receipt_key(&bundle.archive_id, root), encode(&receipt)?],
        )?;
        let event = record(
            &tx,
            &self.redactor,
            None,
            None,
            EventSource::User,
            Payload::WorkspaceChanged {
                entity_id: project.id,
                change: "project_settings_imported".into(),
                content: None,
            },
        )?;
        tx.commit()?;
        Ok((receipt, vec![event]))
    }
}
fn receipt_key(archive: &str, root: &str) -> String {
    format!(
        "project-transfer:{:x}",
        Sha256::digest(format!("{archive}\0{root}").as_bytes())
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn bundle() -> ProjectTransferBundle {
        let profile = ProviderProfile::new(
            "source-model".into(),
            ProtocolKind::Messages,
            "https://example.com/v1".into(),
            "fixture".into(),
        );
        let project = WorkspaceProject {
            id: "source-project".into(),
            created_at_ms: 1,
            settings: ProjectSettings {
                name: "原项目".into(),
                root_path: "C:/old-project".into(),
                default_profile_id: Some(profile.id.clone()),
                permission: PermissionMode::FullAccess,
                rules: "保留项目规则".into(),
                revision: 4,
            },
        };
        let memory = |id: &str, scope| MemoryItem {
            id: id.into(),
            project_id: scope,
            source_task_id: Some("source-task".into()),
            text: format!("记忆 {id}"),
            state: MemoryState::Confirmed,
            revision: 2,
            deleted: false,
            source_label: "原任务".into(),
            source_quote: "原话".into(),
            created_at_ms: 1,
            updated_at_ms: 2,
            confirmed_at_ms: Some(2),
            change: "edited".into(),
        };
        ProjectTransferBundle {
            version: 1,
            memory_history: vec![],
            archive_id: id(),
            created_at_ms: 3,
            project,
            profiles: vec![profile],
            memories: vec![
                memory("local", Some("source-project".into())),
                memory("global", None),
            ],
        }
    }
    #[test]
    fn failed_import_is_atomic_retry_is_deduplicated_and_scopes_survive_restart() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path()).unwrap();
        let b = bundle();
        let initial = s
            .project_import_preview(&b, "target-root", "新项目", "sha")
            .unwrap();
        s.connection.execute_batch("CREATE TEMP TRIGGER fail_import BEFORE INSERT ON memory_meta WHEN (SELECT count(*) FROM memory_meta)>=1 BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
        assert!(
            s.import_project_settings(
                &b,
                "C:/new-project",
                "target-root",
                "新项目",
                "sha",
                &initial
            )
            .is_err()
        );
        for table in [
            "projects",
            "provider_profiles",
            "profile_versions",
            "memories",
            "memory_meta",
            "memory_versions",
        ] {
            assert_eq!(
                s.connection
                    .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                        .get::<_, u32>(0))
                    .unwrap(),
                0,
                "{table}"
            );
        }
        assert_eq!(
            s.project_import_preview(&b, "target-root", "新项目", "sha")
                .unwrap(),
            initial
        );
        s.connection
            .execute_batch("DROP TRIGGER fail_import;")
            .unwrap();
        let (receipt, events) = s
            .import_project_settings(
                &b,
                "C:/new-project",
                "target-root",
                "新项目",
                "sha",
                &initial,
            )
            .unwrap();
        assert_eq!(events.len(), 1);
        let p = s
            .workspace_project(receipt["project_id"].as_str().unwrap())
            .unwrap();
        assert_eq!(p.settings.permission, PermissionMode::RequestApproval);
        assert_eq!(p.settings.rules, "保留项目规则");
        assert_ne!(
            p.settings.default_profile_id.as_deref(),
            Some("source-model")
        );
        assert!(s.global_profile().unwrap().is_none());
        assert!(s.profiles().unwrap().iter().all(|p| p.credential.is_none()));
        let memories = s.memory_active(Some(&p.id), "", 64).unwrap();
        assert_eq!(memories.len(), 2);
        assert_eq!(
            memories
                .iter()
                .filter(|m| m.project_id.as_ref() == Some(&p.id))
                .count(),
            1
        );
        assert!(
            memories
                .iter()
                .all(|m| m.source_task_id.is_none() && m.change == "imported_and_confirmed")
        );
        let duplicate = s
            .project_import_preview(&b, "target-root", "新项目", "sha")
            .unwrap();
        assert!(
            s.import_project_settings(
                &b,
                "C:/new-project",
                "target-root",
                "新项目",
                "sha",
                &duplicate
            )
            .unwrap()
            .1
            .is_empty()
        );
        assert!(
            s.project_import_preview(&b, "target-root", "新项目", "different-sha")
                .is_err()
        );
        drop(s);
        let s = Store::open(dir.path()).unwrap();
        assert_eq!(
            s.project_import_preview(&b, "target-root", "新项目", "sha")
                .unwrap()["already_imported"],
            true
        );
        assert_eq!(s.memory_active(Some(&p.id), "", 64).unwrap().len(), 2);
    }
    #[test]
    fn conflicts_stale_destination_and_foreign_memories_cannot_overwrite_existing_data() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path()).unwrap();
        let b = bundle();
        let before = s
            .project_import_preview(&b, "target-root", "same", "sha")
            .unwrap();
        s.import_project_settings(&b, "C:/target", "target-root", "same", "sha", &before)
            .unwrap();
        let mut other = b.clone();
        other.archive_id = id();
        let conflict = s
            .project_import_preview(&other, "target-root", "same", "other")
            .unwrap();
        assert!(!conflict["conflicts"].as_array().unwrap().is_empty());
        assert!(
            s.import_project_settings(
                &other,
                "C:/target",
                "target-root",
                "same",
                "other",
                &conflict
            )
            .is_err()
        );
        assert!(
            s.import_project_settings(
                &other,
                "C:/target2",
                "target-2",
                "different",
                "other",
                &before
            )
            .is_err()
        );
        other.memories[0].project_id = Some("unrelated".into());
        assert!(
            s.project_import_preview(&other, "target-2", "different", "other")
                .is_err()
        );
        assert_eq!(s.profiles().unwrap().len(), 1);
        assert_eq!(s.memory_active(None, "", 64).unwrap().len(), 1);
    }
}
