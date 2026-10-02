use crate::{CredentialRef, ProtocolKind, ProviderProfile, Usage};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;
use zeroize::Zeroize;

/// Secret is allowed only in a short-lived IPC request, never in a data model/event.
#[derive(Clone, Serialize, Deserialize, TS)]
#[serde(transparent)]
pub struct SecretInput(pub String);
impl Drop for SecretInput {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}
impl std::fmt::Debug for SecretInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretInput([REDACTED])")
    }
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AuthMode {
    #[default]
    Auto,
    Bearer,
    ApiKey,
    None,
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum CapabilitySource {
    #[default]
    Unknown,
    User,
    Observed,
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct Capability {
    pub supported: Option<bool>,
    pub source: CapabilitySource,
    pub checked_at_ms: Option<u64>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ModelCapabilities {
    pub text: Capability,
    pub streaming: Capability,
    pub tools: Capability,
    pub images: Capability,
    pub usage: Capability,
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ChatTokenParameter {
    #[default]
    MaxCompletionTokens,
    MaxTokens,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(default, deny_unknown_fields)]
pub struct ModelOptions {
    pub max_output_tokens: Option<u32>,
    pub temperature: Option<f64>,
    pub reasoning_effort: Option<String>,
    pub chat_token_parameter: ChatTokenParameter,
    pub timeout_ms: u32,
    pub idle_timeout_ms: u32,
    pub anthropic_version: String,
}
impl Default for ModelOptions {
    fn default() -> Self {
        Self {
            max_output_tokens: Some(1024),
            temperature: None,
            reasoning_effort: None,
            chat_token_parameter: ChatTokenParameter::MaxCompletionTokens,
            timeout_ms: 90_000,
            idle_timeout_ms: 30_000,
            anthropic_version: "2023-06-01".into(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ModelPricing {
    pub currency: String,
    pub input_microunits_per_million: u64,
    pub output_microunits_per_million: u64,
}
pub fn initial_revision() -> u32 {
    1
}
impl ProviderProfile {
    pub fn new(id: String, protocol: ProtocolKind, base_url: String, model: String) -> Self {
        Self {
            id,
            label: "New model service".into(),
            protocol,
            base_url,
            model,
            credential: None,
            supports_tools: None,
            supports_images: None,
            revision: 1,
            auth: AuthMode::Auto,
            capabilities: ModelCapabilities::default(),
            options: ModelOptions::default(),
            pricing: None,
        }
    }
    pub fn without_credential(&self) -> Self {
        let mut value = self.clone();
        value.credential = None;
        value
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProfileScope {
    Global,
    Project { id: String },
    Task { id: String },
    Agent { id: String },
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ProfileView {
    pub profile: ProviderProfile,
    pub endpoint: String,
    pub credential_saved: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ProfileCatalog {
    pub profiles: Vec<ProfileView>,
    pub global_default: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ProfileBundle {
    pub format: String,
    pub version: u32,
    pub profiles: Vec<ProviderProfile>,
    pub global_default: Option<String>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ModelProbeMode {
    Text,
    Tools,
    Image,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ModelCallState {
    Running,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ModelErrorCode {
    Configuration,
    Authentication,
    Permission,
    RateLimit,
    Server,
    Timeout,
    Network,
    Cancelled,
    MalformedStream,
    Incomplete,
    Capability,
    Unsupported,
    Limit,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ModelDiagnostic {
    pub code: ModelErrorCode,
    pub message_zh: String,
    pub message_en: String,
    pub detail: Option<String>,
    pub http_status: Option<u16>,
    pub provider_request_id: Option<String>,
    pub retryable: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ModelCallRecord {
    pub id: String,
    pub task_id: String,
    pub profile_id: String,
    pub profile_revision: u32,
    pub profile_snapshot: ProviderProfile,
    pub mode: ModelProbeMode,
    pub state: ModelCallState,
    pub started_at_ms: u64,
    pub ended_at_ms: Option<u64>,
    pub output: Option<crate::ContentRef>,
    pub diagnostic: Option<ModelDiagnostic>,
    pub usage: Option<Usage>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ModelInfo {
    pub id: String,
    pub display_name: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ModelContent {
    Text { text: String },
    Image { media_type: String, base64: String },
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ModelMessage {
    pub role: String,
    pub content: Vec<ModelContent>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ModelToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
    pub provider_item_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ModelToolResult {
    pub call_id: String,
    pub output: String,
    pub is_error: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ProviderContinuation {
    pub protocol: ProtocolKind,
    pub response_id: Option<String>,
    pub items: Vec<Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ModelInput {
    #[serde(default)]
    pub history: Vec<crate::ModelHistoryItem>,
    pub messages: Vec<ModelMessage>,
    pub tools: Vec<ToolDefinition>,
    pub tool_results: Vec<ModelToolResult>,
    pub continuation: Option<ProviderContinuation>,
    pub capability_probe: Option<ModelProbeMode>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ModelOutput {
    pub text: String,
    pub tool_calls: Vec<ModelToolCall>,
    pub continuation: ProviderContinuation,
    pub finish_reason: String,
    pub actual_model: Option<String>,
    pub usage: Usage,
    pub raw_usage: Option<Value>,
}
/// Provider transport events do not imply that a tool is allowed to execute.
#[derive(Debug, Clone)]
pub enum ModelUpdate {
    Text(String),
    PublicReasoning(String),
}

/// Credential references are not caller-selected when creating/updating profiles.
pub fn credential_id(reference: &Option<CredentialRef>) -> Option<&str> {
    reference.as_ref().map(|r| r.id.as_str())
}
