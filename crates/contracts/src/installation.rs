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
