use crate::*;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(default, deny_unknown_fields)]
pub struct ExecutionLimits {
    pub max_steps: u32,
    pub max_duration_ms: u32,
    pub context_bytes: u32,
    pub max_result_bytes: u32,
}
impl Default for ExecutionLimits {
    fn default() -> Self {
        Self {
            max_steps: 32,
            max_duration_ms: 300_000,
            context_bytes: 65_536,
            max_result_bytes: 32_768,
        }
    }
}
impl ExecutionLimits {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !(1..=256).contains(&self.max_steps)
            || !(1000..=3_600_000).contains(&self.max_duration_ms)
            || !(8192..=524_288).contains(&self.context_bytes)
            || !(1024..=65_536).contains(&self.max_result_bytes)
        {
            return Err("invalid execution limits");
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ExecutionConfig {
    pub title: String,
    pub goal: String,
    pub constraints: Vec<String>,
    pub project_rules: String,
    pub project_id: Option<String>,
    pub profile_id: Option<String>,
    pub mode: WorkMode,
    pub controlled_tools: bool,
    pub limits: ExecutionLimits,
}
impl ExecutionConfig {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.title.trim().is_empty()
            || self.title.len() > 512
            || self.goal.trim().is_empty()
            || self.goal.len() > 16_384
            || self.project_rules.len() > 16_384
            || self.constraints.len() > 32
            || self.constraints.iter().map(String::len).sum::<usize>() > 8192
            || [&self.project_id, &self.profile_id]
                .into_iter()
                .flatten()
                .any(|id| !valid_id(id))
        {
            return Err("invalid execution configuration");
        }
        self.limits.validate()
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ModelHistoryItem {
    Message {
        message: ModelMessage,
    },
    Exchange {
        continuation: ProviderContinuation,
        tool_results: Vec<ModelToolResult>,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct PlanStep {
    pub id: String,
    pub text: String,
    pub status: PlanStepStatus,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum PlanStepStatus {
    Pending,
    Running,
    Done,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct InputQuestion {
    pub text: String,
    pub choices: Vec<String>,
    pub plan_confirmation: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct UserDirection {
    pub message_id: String,
    pub text: String,
    pub steered: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ContextSource {
    pub step_id: String,
    pub summary: String,
    pub output: ContentRef,
    pub tool_call_ids: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ContextDigest {
    pub compacted_items: u32,
    pub archive: ContentRef,
    pub recent_sources: Vec<ContextSource>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ExecutionContext {
    pub version: u32,
    pub goal: String,
    pub constraints: Vec<String>,
    pub project_rules: String,
    pub directions: Vec<UserDirection>,
    pub history: Vec<ModelHistoryItem>,
    pub sources: Vec<ContextSource>,
    pub digest: Option<ContextDigest>,
    pub plan: Vec<PlanStep>,
    pub question: Option<InputQuestion>,
    pub pending: Option<PendingBatch>,
    pub last_text: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct PendingBatch {
    pub model_step_id: String,
    pub response: ModelOutput,
    pub action_ids: Vec<String>,
    pub next: u32,
    pub results: Vec<ModelToolResult>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionStepKind {
    Model,
    Tool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionStepState {
    Prepared,
    Running,
    Completed,
    Failed,
    Cancelled,
    Skipped,
    NeedsReview,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ExecutionStep {
    pub id: String,
    pub run_id: String,
    pub ordinal: u32,
    pub kind: ExecutionStepKind,
    pub name: String,
    pub state: ExecutionStepState,
    pub provider_call_id: Option<String>,
    pub input: ContentRef,
    pub output: Option<ContentRef>,
    pub tool_call_id: Option<String>,
    pub started_at_ms: Option<u64>,
    pub ended_at_ms: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ExecutionRun {
    pub run: Run,
    pub session_id: String,
    pub request_id: String,
    pub predecessor_id: Option<String>,
    pub profile: ProviderProfile,
    pub mode: WorkMode,
    pub limits: ExecutionLimits,
    pub steps: u32,
    pub reason: Option<String>,
    pub diagnostic: Option<ModelDiagnostic>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ExecutionSnapshot {
    pub task: Task,
    pub session_id: String,
    pub agent_id: String,
    pub config: ExecutionConfig,
    pub latest_run: Option<ExecutionRun>,
    pub checkpoint_id: Option<String>,
    pub context: ExecutionContext,
    pub messages: Vec<Message>,
    pub steps: Vec<ExecutionStep>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ActionResolution {
    NotApplied,
    Applied { output: String },
}
