use crate::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginManifest {
    pub format: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub servers: Vec<McpServerSpec>,
    #[serde(default)]
    pub dependencies: Vec<PluginDependency>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginDependency {
    pub id: String,
    pub version: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct McpServerSpec {
    pub id: String,
    pub name: String,
    pub transport: McpTransport,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum McpTransport {
    Stdio {
        runtime: PluginRuntime,
        entry: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        secret_env: Vec<String>,
    },
    Http {
        url: String,
        #[serde(default)]
        auth: McpAuth,
    },
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum PluginRuntime {
    Node,
    Python,
    Powershell,
    Native,
}
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum McpAuth {
    #[default]
    None,
    Bearer,
    #[serde(rename = "oauth")]
    OAuth,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct SkillMetadata {
    pub name: String,
    pub description: String,
    pub path: String,
    pub license: Option<String>,
    pub compatibility: Option<String>,
    pub allowed_tools: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct PluginFile {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct PluginVersion {
    pub digest: String,
    pub manifest: PluginManifest,
    pub skills: Vec<SkillMetadata>,
    pub files: Vec<PluginFile>,
    pub permissions: Vec<String>,
    pub warnings: Vec<String>,
    pub created_at_ms: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct PluginInstallation {
    pub id: String,
    pub scope: Option<String>,
    pub slug: String,
    pub source: String,
    pub active_digest: String,
    pub enabled: bool,
    pub installed: bool,
    pub revision: u32,
    pub at_ms: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct PluginPreview {
    pub id: String,
    pub source: String,
    pub scope: Option<String>,
    pub version: PluginVersion,
    pub expected_revision: Option<u32>,
    pub installed_id: Option<String>,
    pub draft: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SkillDraftFile {
    pub path: String,
    pub text: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ExtensionAdmin {
    Catalog {
        query: Option<String>,
    },
    Preview {
        source: String,
        project: bool,
    },
    PreviewDraft {
        draft_id: String,
    },
    PreviewResource {
        draft_id: String,
        path: String,
    },
    DiscardPreview {
        draft_id: String,
    },
    Confirm {
        draft_id: String,
        digest: String,
        enable: bool,
    },
    SetEnabled {
        installation_id: String,
        revision: u32,
        enabled: bool,
    },
    Uninstall {
        installation_id: String,
        revision: u32,
    },
    Versions {
        installation_id: String,
    },
    Rollback {
        installation_id: String,
        digest: String,
        revision: u32,
    },
    ReadResource {
        installation_id: String,
        revision: u32,
        path: String,
    },
    SaveCredential {
        installation_id: String,
        server_id: String,
        revision: u32,
        key: String,
        secret: Option<SecretInput>,
    },
    Export {
        installation_id: String,
        revision: u32,
        destination: String,
    },
    #[serde(rename = "oauth_start")]
    OAuthStart {
        installation_id: String,
        server_id: String,
        revision: u32,
        client_id: Option<String>,
        scopes: Vec<String>,
    },
    #[serde(rename = "oauth_status")]
    OAuthStatus {
        flow_id: String,
    },
    #[serde(rename = "oauth_cancel")]
    OAuthCancel {
        flow_id: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ExtensionEffect {
    Discover {
        installation_id: String,
        revision: u32,
        server_id: String,
    },
    Call {
        installation_id: String,
        revision: u32,
        server_id: String,
        tool: String,
        tool_digest: String,
        arguments: Value,
    },
    RunScript {
        installation_id: String,
        revision: u32,
        path: String,
        args: Vec<String>,
    },
    CopyResource {
        installation_id: String,
        revision: u32,
        path: String,
        destination: String,
        expected: FileVersion,
    },
}
impl ExtensionEffect {
    pub fn installation(&self) -> (&str, u32) {
        match self {
            Self::Discover {
                installation_id,
                revision,
                ..
            }
            | Self::Call {
                installation_id,
                revision,
                ..
            }
            | Self::RunScript {
                installation_id,
                revision,
                ..
            }
            | Self::CopyResource {
                installation_id,
                revision,
                ..
            } => (installation_id, *revision),
        }
    }
    pub fn validate(&self) -> Result<(), &'static str> {
        if !valid_id(self.installation().0) {
            return Err("invalid extension installation");
        }
        let bytes = serde_json::to_vec(self).map_err(|_| "invalid extension action")?;
        if bytes.len() > 256 * 1024 {
            return Err("extension action exceeds limit");
        }
        Ok(())
    }
}
impl ExtensionAdmin {
    pub fn validate(&self) -> Result<(), &'static str> {
        if serde_json::to_vec(self)
            .map_err(|_| "invalid extension command")?
            .len()
            > 512 * 1024
        {
            return Err("extension command exceeds limit");
        }
        Ok(())
    }
}
