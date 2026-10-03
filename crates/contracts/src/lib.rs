//! Versioned wire and persistence types. TypeScript is generated from these types.
use serde::{Deserialize, Serialize};
use ts_rs::TS;
mod request;
mod typescript;
pub use request::{Command, Query, Request, valid_id};
pub use typescript::typescript;
pub mod execution;
pub mod model;
pub mod provider;
pub mod team;
pub mod tool;
pub use execution::*;
pub use model::*;
pub use provider::*;
pub use team::*;
mod workbench;
mod workspace;
pub use tool::*;
pub use workbench::*;
mod browser;
pub use browser::*;
mod extension;
pub use extension::*;
pub use workspace::*;
mod media;
pub use media::*;
mod memory;
pub use memory::*;
mod schedule;
pub use schedule::*;
mod installation;
pub use installation::*;
mod history_transfer;
pub use history_transfer::*;
mod project_transfer;
pub use project_transfer::*;
mod extension_transfer;
pub use extension_transfer::*;

pub const PROTOCOL: &str = "workpilot.v1";
pub const SCHEMA_VERSION: u32 = 11;
pub const EXPORT_VERSION: u32 = 1;
pub const MAX_COMMAND_BYTES: usize = 1_048_576;
pub const MAX_EVENT_BYTES: usize = 65_536;
pub const MAX_PAGE: u32 = 256;
pub const MAX_SAFE_SEQUENCE: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Event {
    pub protocol: String,
    pub event_id: String,
    pub sequence: u64,
    pub task_id: Option<String>,
    pub task_sequence: Option<u64>,
    pub agent_id: Option<String>,
    pub source: EventSource,
    pub at_ms: u64,
    pub request_id: Option<String>,
    #[serde(flatten)]
    pub payload: Payload,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Payload {
    WorkbenchChanged {
        operation_id: String,
        state: String,
        record: Option<ContentRef>,
    },
    WorkspaceChanged {
        entity_id: String,
        change: String,
        content: Option<ContentRef>,
    },
    TeamChanged {
        member_task_id: Option<String>,
        change: String,
        record: Option<ContentRef>,
    },
    ToolPolicyChanged {
        revision: u32,
    },
    ToolApprovalRequested {
        approval_id: String,
        intent: ContentRef,
    },
    ToolApprovalDecided {
        approval_id: String,
        approved: bool,
        decided_by: String,
    },
    ToolReviewFinished {
        approval_id: String,
        review: ApprovalReview,
    },
    ManagedFileChanged {
        change: ManagedFileChange,
    },
    ExecutionCreated {
        session_id: String,
        #[serde(rename = "primary_agent_id")]
        agent_id: String,
        goal: ContentRef,
    },
    ExecutionQueued {
        run_id: String,
    },
    ExecutionStarted {
        run_id: String,
        predecessor_id: Option<String>,
        profile_id: String,
        profile_revision: u32,
    },
    ExecutionStepChanged {
        run_id: String,
        step_id: String,
        name: String,
        state: ExecutionStepState,
        input: Option<ContentRef>,
        output: Option<ContentRef>,
    },
    ExecutionText {
        run_id: String,
        step_id: String,
        content: ContentRef,
        reasoning: bool,
    },
    ExecutionEnded {
        run_id: String,
        state: TaskState,
        reason: String,
        diagnostic: Option<ModelDiagnostic>,
        output: Option<ContentRef>,
    },
    CheckpointSaved {
        run_id: String,
        checkpoint_id: String,
        phase: String,
    },
    ContextCompacted {
        run_id: String,
        archive: ContentRef,
        removed_items: u32,
    },
    MessageDelivered {
        message_id: String,
        run_id: String,
        steered: bool,
    },
    WorkModeChanged {
        mode: WorkMode,
    },
    InputRequested {
        question: InputQuestion,
    },
    PlanUpdated {
        steps: Vec<PlanStep>,
    },
    ActionReconciled {
        action_id: String,
        resolution_source: String,
    },
    ProviderSaved {
        profile_id: String,
        revision: u32,
    },
    ProviderRemoved {
        profile_id: String,
    },
    ProfileDefaultChanged {
        scope: ProfileScope,
        profile_id: Option<String>,
    },
    ProvidersImported {
        count: u32,
    },
    ModelCallStarted {
        call_id: String,
        profile_id: String,
        profile_revision: u32,
        mode: ModelProbeMode,
    },
    ModelText {
        call_id: String,
        content: ContentRef,
    },
    ModelReasoning {
        call_id: String,
        content: ContentRef,
    },
    ModelCallEnded {
        call_id: String,
        state: ModelCallState,
        diagnostic: Option<ModelDiagnostic>,
        output: Option<ContentRef>,
        usage: Option<Usage>,
    },
    Ready {
        pid: u32,
        version: String,
        data_dir: String,
    },
    Pong,
    ProbeStarted {
        ticks: u32,
    },
    Progress {
        current: u32,
        total: u32,
    },
    ProbeEnded {
        reason: String,
    },
    Error {
        code: ErrorCode,
        message: String,
    },
    Bye,
    CommandAccepted {
        command_kind: String,
    },
    CommandFinished {
        status: CommandStatus,
    },
    TaskCreated {
        title: String,
    },
    TaskStateChanged {
        state: TaskState,
        reason: Option<String>,
    },
    MessageQueued {
        message_id: String,
        content: ContentRef,
    },
    MessageSteered {
        message_id: String,
    },
    CancelRequested,
    TextDelta {
        content: ContentRef,
    },
    ToolStarted {
        tool_call_id: String,
        name: String,
        input: ContentRef,
    },
    ToolFinished {
        tool_call_id: String,
        state: ToolState,
        output: ContentRef,
    },
    ToolNeedsReview {
        tool_call_id: String,
    },
    ApprovalChanged {
        approval_id: String,
        state: ApprovalState,
    },
    AgentChanged {
        #[serde(rename = "target_agent_id", alias = "agent_id")]
        agent_id: String,
        state: AgentState,
    },
    ArtifactCreated {
        artifact_id: String,
        revision_id: String,
        content: ContentRef,
    },
    UsageRecorded {
        usage: Usage,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Receipt {
    pub request_id: String,
    pub status: CommandStatus,
    pub task_id: Option<String>,
    pub duplicate: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct EventPage {
    pub events: Vec<Event>,
    /// Always a global sequence, including when filtering by task.
    pub next_after: u64,
    pub high_watermark: u64,
    pub has_more: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct TaskPage {
    pub tasks: Vec<Task>,
    pub next_before: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ContentPage {
    pub text: String,
    pub next_offset: u64,
    pub total_bytes: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Response {
    BrowserSetup {
        report: BrowserSetupReport,
    },
    Installation {
        report: InstallationReport,
    },
    Schedules {
        data: ScheduleData,
    },
    Memory {
        data: MemoryData,
    },
    Workbench {
        data: serde_json::Value,
    },
    Workspace {
        data: Box<WorkspaceData>,
    },
    Team {
        view: Box<TeamView>,
    },
    TaskTools {
        state: Box<ToolTaskState>,
    },
    ToolDefaults {
        settings: DefaultToolSettings,
    },
    ToolRegistry {
        tools: Vec<ToolDescriptor>,
    },
    Execution {
        snapshot: Box<ExecutionSnapshot>,
    },
    Executions {
        tasks: Vec<Task>,
    },
    Profiles {
        catalog: ProfileCatalog,
    },
    ProfileBundle {
        bundle: ProfileBundle,
    },
    ProviderSaved {
        profile: Box<ProfileView>,
    },
    Models {
        models: Vec<ModelInfo>,
        has_more: bool,
    },
    ModelCalls {
        calls: Vec<ModelCallRecord>,
    },
    ModelStarted {
        call: Box<ModelCallRecord>,
        duplicate: bool,
    },
    ModelError {
        diagnostic: ModelDiagnostic,
    },
    Receipt {
        receipt: Receipt,
    },
    Events {
        page: EventPage,
    },
    Tasks {
        page: TaskPage,
    },
    Content {
        page: ContentPage,
    },
    Error {
        code: ErrorCode,
        message: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Wire {
    Event {
        event: Box<Event>,
    },
    Reply {
        request_id: String,
        response: Response,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Snapshot {
    pub events: Vec<Event>,
    pub alive: bool,
    pub error: Option<String>,
    pub next_after: u64,
    pub has_more: bool,
    pub history_truncated: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unknown_commands_and_unbounded_input() {
        assert!(
            serde_json::from_str::<Request>(
                r#"{"request_id":"a","command":{"kind":"launch_shell"}}"#
            )
            .is_err()
        );
        assert!(
            Request {
                request_id: "a".into(),
                command: Command::StartProbe {
                    ticks: 0,
                    interval_ms: 10
                }
            }
            .validate()
            .is_err()
        );
        assert!(
            Query::Events {
                after: 0,
                task_id: None,
                limit: MAX_PAGE + 1
            }
            .validate()
            .is_err()
        );
        assert!(
            Query::Content {
                object_id: "../outside".into(),
                offset: 0,
                limit: 1
            }
            .validate()
            .is_err()
        );
    }
    #[test]
    fn generated_types_match_checked_in_contract() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../apps/desktop/src/generated/contracts.ts");
        assert_eq!(
            std::fs::read_to_string(path)
                .expect("run npm run contracts:generate")
                .replace("\r\n", "\n"),
            typescript()
        );
    }
}
