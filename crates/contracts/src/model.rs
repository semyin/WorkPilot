use serde::{Deserialize, Serialize};
use ts_rs::TS;

macro_rules! enums {
    ($($name:ident { $($variant:ident),+ $(,)? });+ $(;)?) => {$(
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
        #[serde(rename_all = "snake_case")]
        pub enum $name { $($variant),+ }
    )+};
}
enums! {
    TaskState { Queued, Running, AwaitingInput, AwaitingApproval, Stopping, Interrupted, Failed, Completed };
    WorkMode { Chat, Plan, Execute };
    PermissionMode { RequestApproval, AutoReview, FullAccess };
    MessageState { Queued, SteerRequested, Delivered, Cancelled };
    AgentState { Queued, Running, Interrupted, Failed, Completed };
    ToolState { Started, Succeeded, Failed, NeedsReview };
    ApprovalState { Pending, Approved, Rejected, Expired };
    ProtocolKind { ChatCompletions, Responses, Messages };
    CommandStatus { Accepted, Completed, Failed, Interrupted };
    ErrorCode { InvalidRequest, NotFound, Conflict, Busy, Storage, CredentialUnavailable, UnsupportedVersion, Internal };
    EventSource { Engine, User, Tool, Provider, Recovery };
    MemoryState { Suggested, Confirmed, Rejected }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ContentRef {
    pub object_id: String,
    pub bytes: u64,
    pub media_type: String,
}
/// Opaque locator, NEVER the credential itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct CredentialRef {
    pub id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub default_profile_id: Option<String>,
    pub permission: PermissionMode,
    pub created_at_ms: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Task {
    pub id: String,
    pub project_id: Option<String>,
    pub title: String,
    pub state: TaskState,
    pub mode: WorkMode,
    pub permission: PermissionMode,
    pub profile_id: Option<String>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub last_sequence: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Run {
    pub id: String,
    pub task_id: String,
    pub agent_id: Option<String>,
    pub state: TaskState,
    pub started_at_ms: u64,
    pub ended_at_ms: Option<u64>,
    pub result: Option<ContentRef>,
    pub failure_code: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Message {
    pub id: String,
    pub task_id: String,
    pub role: String,
    pub state: MessageState,
    pub queue_position: u64,
    pub content: ContentRef,
    pub created_at_ms: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Agent {
    pub id: String,
    pub task_id: String,
    pub parent_id: Option<String>,
    pub replaces_id: Option<String>,
    pub role: String,
    pub profile_id: Option<String>,
    pub state: AgentState,
    pub attempt: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ProviderProfile {
    pub id: String,
    pub label: String,
    pub protocol: ProtocolKind,
    pub base_url: String,
    pub model: String,
    pub credential: Option<CredentialRef>,
    pub supports_tools: Option<bool>,
    pub supports_images: Option<bool>,
    #[serde(default = "crate::provider::initial_revision")]
    pub revision: u32,
    #[serde(default)]
    pub auth: crate::AuthMode,
    #[serde(default)]
    pub capabilities: crate::ModelCapabilities,
    #[serde(default)]
    pub options: crate::ModelOptions,
    #[serde(default)]
    pub pricing: Option<crate::ModelPricing>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ToolCall {
    pub id: String,
    pub task_id: String,
    pub run_id: String,
    pub agent_id: Option<String>,
    pub name: String,
    pub state: ToolState,
    pub input: ContentRef,
    pub output: Option<ContentRef>,
    pub approval_id: Option<String>,
    pub started_at_ms: u64,
    pub ended_at_ms: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Approval {
    pub id: String,
    pub task_id: String,
    pub action_hash: String,
    pub scope: String,
    pub rule_version: String,
    pub state: ApprovalState,
    pub decided_by: Option<String>,
    pub decided_at_ms: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Artifact {
    pub id: String,
    pub task_id: String,
    pub path: String,
    pub latest_revision_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Revision {
    pub id: String,
    pub artifact_id: String,
    pub content: ContentRef,
    pub predecessor_id: Option<String>,
    pub created_at_ms: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Schedule {
    pub id: String,
    pub project_id: Option<String>,
    pub task_template: ContentRef,
    pub rule: String,
    pub timezone: String,
    pub enabled: bool,
    pub last_trigger_id: Option<String>,
    pub mode: WorkMode,
    pub permission: PermissionMode,
    pub profile_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Memory {
    pub id: String,
    pub project_id: Option<String>,
    pub source_task_id: Option<String>,
    pub content: ContentRef,
    pub state: MemoryState,
    pub confirmed_at_ms: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Usage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cost_microunits: Option<u64>,
    pub currency: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ExportHeader {
    pub format: String,
    pub version: u32,
    pub schema_version: u32,
    pub created_at_ms: u64,
    pub credentials_included: bool,
}
