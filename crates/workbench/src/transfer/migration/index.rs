use super::*;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ScopeBundle {
    pub settings: ProjectTransferBundle,
    pub source_root: Option<String>,
    pub files: Option<file_index::FileIndex>,
    pub extensions: Option<ExtensionTransferBundle>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Bundle {
    pub version: u32,
    pub archive_id: String,
    pub created_at_ms: u64,
    pub projects: Vec<ScopeBundle>,
    pub tasks: Vec<TaskArchiveIndex>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Index {
    pub version: u32,
    pub archive_id: String,
    pub manifest: String,
    pub objects: BTreeMap<String, u64>,
}
impl codec::ArchiveIndex for Index {
    const MAGIC: &'static [u8; 8] = b"WPFULL01";
    fn objects(&self) -> Result<BTreeMap<String, u64>> {
        if self.version != 1
            || !valid_id(&self.archive_id)
            || !self.objects.contains_key(&self.manifest)
            || self.objects.len() > 8192
            || self.objects.values().any(|size| *size > 64 * 1024 * 1024)
            || self.objects.values().sum::<u64>() > codec::MAX_TOTAL
            || self.objects.keys().any(|id| !task_archive_checksum(id))
        {
            return Err("统一迁移包容量或格式无效 / Invalid full migration archive".into());
        }
        Ok(self.objects.clone())
    }
}
impl Bundle {
    pub(super) fn validate_task_models(&self, blobs: &BTreeMap<String, Vec<u8>>) -> Result<()> {
        for archive in &self.tasks {
            let snapshot: TaskArchiveSnapshot = serde_json::from_slice(
                blobs
                    .get(&archive.snapshot.object_id)
                    .ok_or("Missing task snapshot")?,
            )
            .map_err(|_| "Invalid task snapshot")?;
            for task in &snapshot.tables["tasks"] {
                let session = snapshot.tables["execution_sessions"]
                    .iter()
                    .find(|s| s["task_id"] == task["id"])
                    .ok_or("Missing task session")?;
                let mut pin = Value::Null;
                if let Some(run) = snapshot.tables["execution_runs"]
                    .iter()
                    .find(|r| r["run_id"] == session["current_run_id"] && !r["run_id"].is_null())
                {
                    pin = run["profile_json"].clone();
                } else {
                    for event in snapshot.tables["events"].iter().filter(|e| {
                        e["task_id"] == task["id"] && e["payload_json"]["kind"] == "task_restored"
                    }) {
                        let reference: ContentRef =
                            serde_json::from_value(event["payload_json"]["history"].clone())
                                .map_err(|_| "Invalid history model reference")?;
                        let history: Value = serde_json::from_slice(
                            blobs
                                .get(&reference.object_id)
                                .ok_or("Missing restored history")?,
                        )
                        .map_err(|_| "Invalid restored history")?;
                        pin = history["profile"].clone();
                    }
                }
                let available = self
                    .projects
                    .iter()
                    .filter(|p| {
                        task["project_id"].is_null() || task["project_id"] == p.settings.project.id
                    })
                    .flat_map(|p| &p.settings.profiles);
                if !available.into_iter().any(|p| {
                    pin.is_null()
                        || (pin["protocol"] == json!(p.protocol)
                            && pin["model"] == p.model
                            && pin["base_url"] == p.base_url)
                }) {
                    return Err(format!(
                        "请为任务“{}”选择原模型配置一同迁移 / Include the original model configuration for task “{}”",
                        task["title"].as_str().unwrap_or_default(),
                        task["title"].as_str().unwrap_or_default()
                    ));
                }
            }
        }
        Ok(())
    }
    pub(super) fn objects(&self) -> Result<BTreeMap<String, u64>> {
        if self.version != 1
            || !valid_id(&self.archive_id)
            || self.projects.is_empty()
            || self.projects.len() > 16
            || self.tasks.len() > 16
        {
            return Err("迁移包项目或任务数量无效 / Invalid migration project/task count".into());
        }
        let mut projects = HashSet::new();
        let mut objects = BTreeMap::new();
        let mut add = |items: BTreeMap<String, u64>| -> Result<()> {
            for (sha, size) in items {
                if objects.insert(sha, size).is_some_and(|old| old != size) {
                    return Err("Inconsistent object size".into());
                }
            }
            Ok(())
        };
        for p in &self.projects {
            p.settings.validate().map_err(str::to_owned)?;
            if !projects.insert(&p.settings.project.id) {
                return Err("Duplicate migration project".into());
            }
            if let Some(files) = &p.files {
                add(files.objects()?)?
            }
        }
        let mut tasks = HashSet::new();
        for t in &self.tasks {
            if t.tasks.iter().any(|t| !tasks.insert(&t.id)) {
                return Err("Duplicate source task".into());
            }
            add(t.objects()?)?;
        }
        Ok(objects)
    }
    pub(super) fn summary(&self) -> Value {
        json!({"archive_id":self.archive_id,"created_at_ms":self.created_at_ms,
            "projects":self.projects.iter().map(|p|json!({"id":p.settings.project.id,
                "name":p.settings.project.settings.name,"root_path":p.settings.project.settings.root_path,"source_root":p.source_root,
                "profiles":p.settings.profiles,"memories":p.settings.memories,
                "files":p.files.as_ref().map(|f|&f.files),"extensions":p.extensions.as_ref().map(|e|e.entries.iter().map(|e|json!({"source_id":e.source_id,"draft":e.draft,"versions":e.earlier.len()+1})).collect::<Vec<_>>())
            })).collect::<Vec<_>>(),
            "tasks":self.tasks.iter().map(workpilot_storage::task_archive_summary).collect::<Vec<_>>(),
            "history_roots":self.tasks.iter().flat_map(|t|&t.file_history).map(|h|h.root_identity.clone()).collect::<std::collections::BTreeSet<_>>()})
    }
}
