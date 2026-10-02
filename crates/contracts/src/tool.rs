use crate::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

pub const TOOL_RULE_VERSION: &str = "workpilot.tools.1";
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(default, deny_unknown_fields)]
pub struct ToolSettings {
    pub root_path: Option<String>,
    pub permission: Option<PermissionMode>,
    pub review_profile_id: Option<String>,
    pub commands_enabled: bool,
    pub revision: u32,
}
impl ToolSettings {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self
            .root_path
            .as_ref()
            .is_some_and(|p| p.trim().is_empty() || p.len() > 4096 || p.contains('\0'))
            || self
                .review_profile_id
                .as_ref()
                .is_some_and(|p| !valid_id(p))
        {
            return Err("invalid tool settings");
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct DefaultToolSettings {
    pub permission: PermissionMode,
    pub review_profile_id: Option<String>,
    pub revision: u32,
}
impl Default for DefaultToolSettings {
    fn default() -> Self {
        Self {
            permission: PermissionMode::RequestApproval,
            review_profile_id: None,
            revision: 0,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ToolSettingsView {
    pub settings: ToolSettings,
    pub defaults: DefaultToolSettings,
    pub effective_permission: PermissionMode,
    pub review_profile_id: Option<String>,
    pub epoch: String,
    pub root_identity: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ToolRisk {
    ReadOnly,
    ManagedWrite,
    Process,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ToolDescriptor {
    pub definition: ToolDefinition,
    pub result_schema: Value,
    pub risk: ToolRisk,
    pub scope: String,
    pub cancellation: String,
    pub replay: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct FileVersion {
    pub exists: bool,
    pub sha256: Option<String>,
    pub bytes: u64,
    pub identity: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ToolIntent {
    pub task_id: String,
    pub action_id: String,
    pub tool: String,
    pub arguments: Value,
    pub root_path: String,
    pub root_identity: String,
    pub target: String,
    pub version: FileVersion,
    pub epoch: String,
    pub mode: WorkMode,
    pub risk: ToolRisk,
    pub execution_scope: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ApprovalReview {
    pub profile_id: String,
    pub state: String,
    pub reason: String,
    pub diagnostic: Option<ModelDiagnostic>,
    pub input: Option<ContentRef>,
    pub output: Option<ContentRef>,
    pub usage: Option<Usage>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ToolApproval {
    pub id: String,
    pub task_id: String,
    pub action_id: String,
    pub fingerprint: String,
    pub intent: ToolIntent,
    pub state: ApprovalState,
    pub decided_by: Option<String>,
    pub decided_at_ms: Option<u64>,
    pub created_at_ms: u64,
    pub consumed: bool,
    pub review: Option<ApprovalReview>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ManagedFileChange {
    pub action_id: String,
    pub path: String,
    pub before: FileVersion,
    pub after: FileVersion,
    pub before_content: Option<ContentRef>,
    pub after_content: ContentRef,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ToolTaskState {
    pub policy: ToolSettingsView,
    pub approvals: Vec<ToolApproval>,
    pub changes: Vec<ManagedFileChange>,
}
