use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct RuntimeHealth {
    pub id: String,
    pub version: String,
    pub source: String,
    pub license: String,
    pub state: String,
    pub files: u32,
    pub checked_files: u32,
    pub bytes: u64,
    pub issues: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct InstallationReport {
    pub report_version: u32,
    pub app_version: String,
    pub schema_version: u32,
    pub platform: String,
    pub architecture: String,
    pub checked_at_ms: u64,
    pub manifest_present: bool,
    pub verified_hashes: bool,
    pub components: Vec<RuntimeHealth>,
    pub notices: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum SetupBrowser {
    Chrome,
    Edge,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum BrowserSetupAction {
    Inspect,
    Register { browser: SetupBrowser },
    Unregister { browser: SetupBrowser },
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct BrowserRegistration {
    pub browser: SetupBrowser,
    // missing, ready, repair, conflict, unavailable, unsupported
    pub state: String,
    pub can_register: bool,
    pub can_unregister: bool,
    pub other_location: Option<String>,
    pub fallback_detected: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct BrowserSetupReport {
    pub supported: bool,
    pub assets_ready: bool,
    pub extension_directory: Option<String>,
    pub extension_id: String,
    pub browsers: Vec<BrowserRegistration>,
}
