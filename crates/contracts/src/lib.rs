//! Versioned wire and persistence types. TypeScript is generated from these types.
use serde::{Deserialize, Serialize};
use ts_rs::TS;
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
pub use workspace::*;

pub const PROTOCOL: &str = "workpilot.v1";
pub const SCHEMA_VERSION: u32 = 7;
pub const EXPORT_VERSION: u32 = 1;
pub const MAX_COMMAND_BYTES: usize = 1_048_576;
pub const MAX_EVENT_BYTES: usize = 65_536;
pub const MAX_PAGE: u32 = 256;
pub const MAX_SAFE_SEQUENCE: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub request_id: String,
    pub command: Command,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    Workbench {
        task_id: String,
        action: WorkbenchAction,
    },
    Workspace {
        action: WorkspaceAction,
    },
    ConfigureTeam {
        task_id: String,
        settings: TeamSettings,
    },
    ConfigureScheduler {
        settings: SchedulerSettings,
    },
    AddTeamMembers {
        task_id: String,
        members: Vec<MemberSpec>,
    },
    OverrideTeamMember {
        task_id: String,
        member_id: String,
        spec: MemberSpec,
    },
    ReplaceTeamMember {
        task_id: String,
        member_id: String,
        profile_id: Option<String>,
        reason: String,
    },
    ReviewTeamMember {
        task_id: String,
        member_id: String,
        report_id: String,
        accept: bool,
        reason: String,
    },
    ConfigureTaskTools {
        task_id: String,
        settings: ToolSettings,
    },
    ConfigureToolDefaults {
        settings: DefaultToolSettings,
    },
    DecideToolApproval {
        task_id: String,
        approval_id: String,
        fingerprint: String,
        approve: bool,
    },
    CreateExecution {
        config: Box<ExecutionConfig>,
    },
    StartExecution {
        task_id: String,
    },
    ConfigureExecution {
        task_id: String,
        mode: WorkMode,
        profile_id: Option<String>,
        limits: ExecutionLimits,
    },
    ResolveExecutionAction {
        task_id: String,
        action_id: String,
        resolution: ActionResolution,
    },
    Ping,
    StartProbe {
        ticks: u32,
        interval_ms: u64,
    },
    Stop,
    Shutdown,
    CreateTask {
        title: String,
        project_id: Option<String>,
    },
    Enqueue {
        task_id: String,
        text: String,
    },
    Steer {
        task_id: String,
        message_id: String,
    },
    Cancel {
        task_id: String,
    },
    DeleteTask {
        task_id: String,
    },
    Read {
        query: Query,
    },
    SaveProvider {
        profile: Box<ProviderProfile>,
        secret: Option<SecretInput>,
        clear_credential: bool,
    },
    DeleteProvider {
        profile_id: String,
        expected_revision: u32,
    },
    SetDefaultProfile {
        scope: ProfileScope,
        profile_id: Option<String>,
    },
    ImportProfiles {
        bundle: Box<ProfileBundle>,
    },
    ProviderModels {
        profile_id: String,
    },
    StartModelProbe {
        profile_id: Option<String>,
        task_id: Option<String>,
        agent_id: Option<String>,
        mode: ModelProbeMode,
        prompt: String,
    },
    CancelModelProbe {
        call_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Query {
    Workspace {
        query: WorkspaceQuery,
    },
    Team {
        task_id: String,
    },
    TaskTools {
        task_id: String,
    },
    ToolDefaults,
    ToolRegistry,
    Execution {
        task_id: String,
    },
    Executions {
        limit: u32,
    },
    Profiles,
    ExportProfiles,
    ModelCalls {
        limit: u32,
    },
    Events {
        after: u64,
        task_id: Option<String>,
        limit: u32,
    },
    Tasks {
        before: Option<String>,
        limit: u32,
    },
    Content {
        object_id: String,
        offset: u64,
        limit: u32,
    },
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_:.".contains(&c))
}
impl Request {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !valid_id(&self.request_id) {
            return Err("invalid request_id");
        }
        match &self.command {
            Command::Workbench { task_id, action } => {
                if !valid_id(task_id) {
                    return Err("invalid task");
                }
                action.validate()?;
            }
            Command::Workspace { action } => action.validate()?,
            Command::ConfigureTeam { task_id, settings } => {
                if !valid_id(task_id) {
                    return Err("invalid task");
                }
                settings.validate()?;
            }
            Command::ConfigureScheduler { settings } => {
                if !(1..=16).contains(&settings.max_running) {
                    return Err("invalid scheduler limit");
                }
            }
            Command::AddTeamMembers { task_id, members } => {
                if !valid_id(task_id) || members.is_empty() || members.len() > 8 {
                    return Err("invalid member batch");
                }
                for m in members {
                    m.validate()?;
                }
            }
            Command::OverrideTeamMember {
                task_id,
                member_id,
                spec,
            } => {
                if !valid_id(task_id) || !valid_id(member_id) {
                    return Err("invalid member");
                }
                spec.validate()?;
            }
            Command::ReplaceTeamMember {
                task_id,
                member_id,
                profile_id,
                reason,
            } => {
                if !valid_id(task_id)
                    || !valid_id(member_id)
                    || profile_id.as_ref().is_some_and(|p| !valid_id(p))
                    || reason.trim().is_empty()
                    || reason.len() > 4096
                {
                    return Err("invalid replacement");
                }
            }
            Command::ReviewTeamMember {
                task_id,
                member_id,
                report_id,
                reason,
                ..
            } => {
                if !valid_id(task_id)
                    || !valid_id(member_id)
                    || !valid_id(report_id)
                    || reason.trim().is_empty()
                    || reason.len() > 4096
                {
                    return Err("invalid member review");
                }
            }
            Command::ConfigureTaskTools { task_id, settings } => {
                if !valid_id(task_id) {
                    return Err("invalid task_id");
                }
                settings.validate()?;
            }
            Command::ConfigureToolDefaults { settings } => {
                if settings
                    .review_profile_id
                    .as_ref()
                    .is_some_and(|p| !valid_id(p))
                {
                    return Err("invalid review profile");
                }
            }
            Command::DecideToolApproval {
                task_id,
                approval_id,
                fingerprint,
                ..
            } => {
                if !valid_id(task_id)
                    || !valid_id(approval_id)
                    || fingerprint.len() != 64
                    || !fingerprint.bytes().all(|b| b.is_ascii_hexdigit())
                {
                    return Err("invalid approval decision");
                }
            }
            Command::CreateExecution { config } => config.validate()?,
            Command::StartExecution { task_id } if !valid_id(task_id) => {
                return Err("invalid task_id");
            }
            Command::ConfigureExecution {
                task_id,
                profile_id,
                limits,
                ..
            } => {
                if !valid_id(task_id) || profile_id.as_ref().is_some_and(|id| !valid_id(id)) {
                    return Err("invalid execution reference");
                }
                limits.validate()?;
            }
            Command::ResolveExecutionAction {
                task_id,
                action_id,
                resolution,
            } => {
                if !valid_id(task_id) || !valid_id(action_id) {
                    return Err("invalid action reference");
                }
                if let ActionResolution::Applied { output } = resolution
                    && (output.is_empty() || output.len() > 65_536)
                {
                    return Err("invalid resolved output");
                }
            }
            Command::StartProbe { ticks, interval_ms }
                if !(1..=100_000).contains(ticks) || !(1..=1_000).contains(interval_ms) =>
            {
                return Err("invalid probe range");
            }
            Command::CreateTask { title, project_id } => {
                if title.trim().is_empty() || title.len() > 512 {
                    return Err("invalid title");
                }
                if project_id.as_ref().is_some_and(|id| !valid_id(id)) {
                    return Err("invalid project_id");
                }
            }
            Command::Enqueue { task_id, text } => {
                if !valid_id(task_id) || text.trim().is_empty() || text.len() > 32_768 {
                    return Err("invalid queued message");
                }
            }
            Command::Steer {
                task_id,
                message_id,
            } => {
                if !valid_id(task_id) || !valid_id(message_id) {
                    return Err("invalid message reference");
                }
            }
            Command::Cancel { task_id } | Command::DeleteTask { task_id } if !valid_id(task_id) => {
                return Err("invalid task_id");
            }
            Command::Read { query } => query.validate()?,
            Command::SaveProvider {
                profile,
                secret,
                clear_credential,
            } => {
                if !valid_id(&profile.id)
                    || (secret.is_some() && *clear_credential)
                    || secret.as_ref().is_some_and(|s| {
                        s.0.is_empty() || s.0.len() > 4096 || s.0.chars().any(char::is_control)
                    })
                {
                    return Err("invalid provider configuration");
                }
            }
            Command::DeleteProvider { profile_id, .. } | Command::ProviderModels { profile_id }
                if !valid_id(profile_id) =>
            {
                return Err("invalid profile_id");
            }
            Command::SetDefaultProfile { scope, profile_id } => {
                if profile_id.as_ref().is_some_and(|v| !valid_id(v)) {
                    return Err("invalid profile_id");
                }
                match scope {
                    ProfileScope::Project { id }
                    | ProfileScope::Task { id }
                    | ProfileScope::Agent { id }
                        if !valid_id(id) =>
                    {
                        return Err("invalid scope");
                    }
                    _ => {}
                }
            }
            Command::ImportProfiles { bundle }
                if bundle.format != "workpilot.profiles"
                    || bundle.version != 1
                    || bundle.profiles.len() > 128 =>
            {
                return Err("unsupported profile bundle");
            }
            Command::StartModelProbe {
                profile_id,
                task_id,
                agent_id,
                prompt,
                ..
            } => {
                if [profile_id, task_id, agent_id]
                    .into_iter()
                    .flatten()
                    .any(|s| !valid_id(s))
                    || prompt.len() > 16_384
                {
                    return Err("invalid model probe");
                }
            }
            Command::CancelModelProbe { call_id } if !valid_id(call_id) => {
                return Err("invalid call_id");
            }
            _ => {}
        }
        Ok(())
    }
}
impl Query {
    pub fn validate(&self) -> Result<(), &'static str> {
        match self {
            Self::Workspace { query } => query.validate()?,
            Self::Team { task_id } | Self::TaskTools { task_id } if !valid_id(task_id) => {
                return Err("invalid task_id");
            }
            Self::Team { .. }
            | Self::TaskTools { .. }
            | Self::ToolDefaults
            | Self::ToolRegistry => {}
            Self::Execution { task_id } if !valid_id(task_id) => return Err("invalid task_id"),
            Self::Executions { limit } if !(1..=64).contains(limit) => {
                return Err("invalid execution page");
            }
            Self::Execution { .. } | Self::Executions { .. } => {}
            Self::Profiles | Self::ExportProfiles => {}
            Self::ModelCalls { limit } if !(1..=64).contains(limit) => {
                return Err("invalid model call page");
            }
            Self::ModelCalls { .. } => {}
            Self::Events {
                after,
                task_id,
                limit,
            } => {
                if *after > MAX_SAFE_SEQUENCE
                    || task_id.as_ref().is_some_and(|id| !valid_id(id))
                    || !(1..=MAX_PAGE).contains(limit)
                {
                    return Err("invalid event page");
                }
            }
            Self::Tasks { before, limit } => {
                if before.as_ref().is_some_and(|id| !valid_id(id))
                    || !(1..=MAX_PAGE).contains(limit)
                {
                    return Err("invalid task page");
                }
            }
            Self::Content {
                object_id,
                offset,
                limit,
            } => {
                if object_id.len() != 64
                    || !object_id
                        .bytes()
                        .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
                    || *offset > MAX_SAFE_SEQUENCE
                    || !(1..=65_536).contains(limit)
                {
                    return Err("invalid content page");
                }
            }
        }
        Ok(())
    }
}

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

/// Deterministic generation; CI compares this output with the checked-in file.
pub fn typescript() -> String {
    let mut output = String::from(
        "// Generated by workpilot-contracts. Do not edit.\n/* prettier-ignore-file */\n",
    );
    let config = ts_rs::Config::default().with_large_int("number");
    macro_rules! export { ($($ty:ty),* $(,)?) => { $(output.push_str("export "); output.push_str(&<$ty>::decl(&config)); output.push('\n');)* }; }
    export!(
        WorkbenchAction,
        FileEdit,
        FileRevision,
        FileImage,
        WorkbenchOperation,
        Request,
        Command,
        Query,
        Event,
        Payload,
        Receipt,
        EventPage,
        TaskPage,
        ContentPage,
        Response,
        Wire,
        Snapshot,
        TaskState,
        WorkMode,
        PermissionMode,
        MessageState,
        AgentState,
        ToolState,
        ApprovalState,
        ProtocolKind,
        CommandStatus,
        ErrorCode,
        EventSource,
        MemoryState,
        ContentRef,
        CredentialRef,
        Project,
        Task,
        Run,
        Message,
        Agent,
        ProviderProfile,
        ToolCall,
        Approval,
        Artifact,
        Revision,
        Schedule,
        Memory,
        Usage,
        ExportHeader,
        SecretInput,
        AuthMode,
        Capability,
        CapabilitySource,
        ModelCapabilities,
        ModelOptions,
        ModelPricing,
        ChatTokenParameter,
        ProfileScope,
        ProfileView,
        ProfileCatalog,
        ProfileBundle,
        ModelProbeMode,
        ModelCallState,
        ModelErrorCode,
        ModelDiagnostic,
        ModelCallRecord,
        ModelInfo,
        ToolDefinition,
        ModelContent,
        ModelMessage,
        ModelToolCall,
        ModelToolResult,
        ProviderContinuation,
        ModelInput,
        ModelOutput,
        serde_json::Value,
        ExecutionLimits,
        ExecutionConfig,
        ModelHistoryItem,
        PlanStep,
        PlanStepStatus,
        InputQuestion,
        UserDirection,
        ContextSource,
        ContextDigest,
        ExecutionContext,
        PendingBatch,
        ExecutionStepKind,
        ExecutionStepState,
        ExecutionStep,
        ExecutionRun,
        ExecutionSnapshot,
        ActionResolution,
        ToolSettings,
        DefaultToolSettings,
        ToolSettingsView,
        ToolRisk,
        ToolDescriptor,
        FileVersion,
        ToolIntent,
        ApprovalReview,
        ToolApproval,
        ManagedFileChange,
        ToolTaskState,
        TeamSettings,
        WorkspaceAction,
        WorkspaceQuery,
        WorkspaceData,
        WorkspacePreferences,
        ProjectSettings,
        WorkspaceProject,
        WorkspaceNotice,
        WorkspaceArtifact,
        ConversationEntry,
        SchedulerSettings,
        MemberSpec,
        TeamMember,
        TeamView,
        AgentArtifact,
        AgentReport
    );
    output
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
