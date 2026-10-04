//! Commands, queries and their input validation.
use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub request_id: String,
    pub command: Command,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    TaskArchive {
        action: TaskArchiveAction,
    },
    MediaTransfer {
        task_id: String,
        action: MediaTransferAction,
    },
    FileTransfer {
        task_id: String,
        action: FileTransferAction,
    },
    ExtensionTransfer {
        task_id: Option<String>,
        action: ExtensionTransferAction,
    },
    ProjectTransfer {
        action: ProjectTransferAction,
    },
    HistoryTransfer {
        task_id: String,
        action: HistoryTransferAction,
    },
    BrowserSetup {
        action: BrowserSetupAction,
    },
    InspectInstallation {
        verify_hashes: bool,
    },
    Schedules {
        action: ScheduleAction,
    },
    Memory {
        action: MemoryAction,
    },
    Media {
        task_id: Option<String>,
        action: MediaAdmin,
    },
    Extensions {
        task_id: Option<String>,
        action: ExtensionAdmin,
    },
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
            Command::TaskArchive { action } => action.validate()?,
            Command::MediaTransfer { task_id, action } => {
                if !valid_id(task_id) {
                    return Err("invalid task id");
                }
                action.validate()?;
            }
            Command::FileTransfer { task_id, action } => {
                if !valid_id(task_id) {
                    return Err("invalid task id");
                }
                action.validate()?;
            }
            Command::ExtensionTransfer { task_id, action } => {
                if task_id.as_ref().is_some_and(|id| !valid_id(id)) {
                    return Err("invalid task");
                }
                action.validate()?;
            }
            Command::ProjectTransfer { action } => action.validate()?,
            Command::HistoryTransfer { task_id, action } => {
                if !valid_id(task_id) {
                    return Err("invalid task");
                }
                action.validate()?;
            }
            Command::Media { task_id, action } => {
                if task_id.as_ref().is_some_and(|id| !valid_id(id)) {
                    return Err("invalid task");
                }
                action.validate()?;
            }
            Command::Extensions { task_id, action } => {
                if task_id.as_ref().is_some_and(|id| !valid_id(id)) {
                    return Err("invalid task");
                }
                action.validate()?;
            }
            Command::Workbench { task_id, action } => {
                if !valid_id(task_id) {
                    return Err("invalid task");
                }
                action.validate()?;
            }
            Command::Workspace { action } => action.validate()?,
            Command::Memory { action } => action.validate()?,
            Command::Schedules { action } => action.validate()?,
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
