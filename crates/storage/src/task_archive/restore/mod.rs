//! Explicit restoration creates new authority; imported history remains data.
mod attachments;
mod file_history;
mod history;
pub use attachments::TaskRestoreMedia;
mod command_history;
mod mapped;
mod prepare;
mod recovery;
mod team;
mod team_graph;
mod team_write;
mod write;
use super::*;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub(super) fn recovery_preview(bundle: &TaskArchiveBytes) -> Result<Value> {
    let snapshot = validate_bundle(&bundle.index, &bundle.blobs)?;
    let mut tasks = vec![];
    for task in &bundle.index.tasks {
        let session = snapshot.tables["execution_sessions"]
            .iter()
            .find(|s| s["task_id"] == task.id)
            .ok_or(Error::NotFound)?;
        let r: ContentRef = serde_json::from_value(session["context_object_id"].clone())?;
        let mut context: ExecutionContext =
            serde_json::from_slice(bundle.blobs.get(&r.object_id).ok_or(Error::NotFound)?)?;
        let items = recovery::seal(&mut context, &snapshot, &task.id)?;
        if !items.is_empty() {
            tasks.push(json!({"task_id":task.id,"title":task.title,"items":items}));
        }
    }
    Ok(json!(tasks))
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct ModelPin {
    protocol: ProtocolKind,
    model: String,
    base_url: String,
}
impl ModelPin {
    fn from_profile(p: &ProviderProfile) -> Self {
        Self {
            protocol: p.protocol,
            model: p.model.clone(),
            base_url: p.base_url.clone(),
        }
    }
    fn matches(&self, p: &ProviderProfile) -> bool {
        self.protocol == p.protocol && self.model == p.model && self.base_url == p.base_url
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct HistoricalData {
    profile: Option<ModelPin>,
    results: BTreeMap<String, ContentRef>,
    #[serde(default)]
    started: bool,
    #[serde(default)]
    team_ids: BTreeMap<String, String>,
    #[serde(default)]
    media_ids: BTreeMap<String, String>,
    #[serde(default)]
    recovery: Vec<recovery::RecoveryItem>,
    #[serde(default)]
    recovery_acknowledged: bool,
    #[serde(default)]
    commands: BTreeMap<String, BTreeMap<String, ContentRef>>,
}
pub(super) struct Prepared {
    index: TaskArchiveIndex,
    config: ExecutionConfig,
    context: ExecutionContext,
    messages: Vec<Message>,
    conversation: Vec<(String, ContentRef, u64)>,
    history: HistoricalData,
    project: Option<(WorkspaceProject, Option<String>)>,
    profile: ProviderProfile,
    state: TaskState,
    fingerprint: String,
    source_id: String,
    source_agent: Agent,
    history_roots: BTreeMap<String, String>,
}
fn restore_key(archive: &str) -> String {
    format!("task-restore:{archive}")
}
impl Store {
    pub fn task_restore_target(
        &self,
        project: Option<&str>,
    ) -> Result<Option<(WorkspaceProject, Option<String>)>> {
        project
            .map(|id| self.project_creation_defaults(id))
            .transpose()
    }
    pub fn task_restore_preview(
        &self,
        archive: &str,
        project: Option<&str>,
        profile: &str,
        stop: &AtomicBool,
    ) -> Result<Value> {
        if let Some(mut receipt) = self.restoration_receipt(archive)? {
            receipt["already_restored"] = json!(true);
            return Ok(receipt);
        }
        let p = self.prepare_task_restore(archive, project, profile, stop)?;
        Ok(
            json!({"already_restored":false,"fingerprint":p.fingerprint,"title":p.config.title,
            "messages":p.messages.len(),"queued":p.messages.iter().filter(|m| matches!(m.state,MessageState::Queued | MessageState::SteerRequested)).count(),
            "history_items":p.context.history.len(),"history_results":p.history.results.len(),
            "project":p.project.as_ref().map(|p| &p.0),"model":p.profile.model,
            "protocol":p.profile.protocol,"base_url":p.profile.base_url,
            "project_rules":p.config.project_rules,"state":p.state,"mode":p.config.mode,
            "recovery":p.history.recovery,"file_history":file_history::summary(&p.index),"file_history_included":p.index.version>=3}),
        )
    }
    fn restoration_receipt(&self, archive: &str) -> Result<Option<Value>> {
        if !valid_id(archive) {
            return Err(Error::Invalid("invalid archive identity"));
        }
        self.connection
            .query_row(
                "SELECT value_json FROM settings WHERE key=?1",
                [restore_key(archive)],
                |r| r.get::<_, String>(0),
            )
            .optional()?
            .map(|v| {
                let mut value: Value = serde_json::from_str(&v)?;
                let id = value["task_id"]
                    .as_str()
                    .ok_or(Error::Invalid("invalid restoration receipt"))?;
                let exists: bool = self.connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?1)",
                    [id],
                    |r| r.get(0),
                )?;
                value["deleted"] = json!(!exists);
                Ok(value)
            })
            .transpose()
    }
    pub(crate) fn restored_profile_guard(
        &self,
        task: &str,
        profile: &ProviderProfile,
    ) -> Result<()> {
        let data = self.restored_history(task)?;
        if data
            .as_ref()
            .is_some_and(|d| !d.recovery.is_empty() && !d.recovery_acknowledged)
        {
            return Err(Error::Invalid(
                "迁入操作尚待人工核对 / Review the unresolved migrated operations before continuing",
            ));
        }
        if data
            .and_then(|d| d.profile)
            .is_some_and(|pin| !pin.matches(profile))
        {
            return Err(Error::Invalid(
                "迁入会话须使用原协议、模型及服务地址 / Restored history requires the original protocol, model and service address",
            ));
        }
        Ok(())
    }
    fn restored_history(&self, task: &str) -> Result<Option<HistoricalData>> {
        let raw: Option<String> = self
            .connection
            .query_row(
                "SELECT value_json FROM settings WHERE key=?1",
                [format!("task-restored-history:{task}")],
                |r| r.get(0),
            )
            .optional()?;
        raw.map(|v| self.read_json(&serde_json::from_str::<ContentRef>(&v)?))
            .transpose()
    }
    pub(crate) fn restored_step_result(&self, task: &str, step: &str) -> Result<Option<Value>> {
        self.restored_history(task)?
            .and_then(|h| h.results.get(step).cloned())
            .map(|r| self.read_json(&r))
            .transpose()
    }
    pub(crate) fn restored_member_started(&self, task: &str) -> Result<bool> {
        Ok(self
            .restored_history(task)?
            .is_some_and(|h| h.started || h.profile.is_some()))
    }
    pub fn restored_team_ids(&self, task: &str) -> Result<BTreeMap<String, String>> {
        let root = self.team_root(task)?;
        Ok(self
            .restored_history(&root)?
            .map(|h| h.team_ids)
            .unwrap_or_default())
    }
}
