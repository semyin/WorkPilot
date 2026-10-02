use crate::*;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(default, deny_unknown_fields)]
pub struct TeamSettings {
    pub enabled: bool,
    pub max_parallel: u32,
    pub max_members: u32,
    pub max_depth: u32,
    pub max_replacements: u32,
    pub revision: u32,
}
impl Default for TeamSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            max_parallel: 3,
            max_members: 16,
            max_depth: 2,
            max_replacements: 2,
            revision: 0,
        }
    }
}
impl TeamSettings {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !(1..=8).contains(&self.max_parallel)
            || !(1..=32).contains(&self.max_members)
            || !(1..=3).contains(&self.max_depth)
            || self.max_replacements > 5
        {
            return Err("invalid team limits");
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SchedulerSettings {
    pub max_running: u32,
    pub revision: u32,
}
impl Default for SchedulerSettings {
    fn default() -> Self {
        Self {
            max_running: 4,
            revision: 0,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct MemberSpec {
    pub key: String,
    pub role: String,
    pub goal: String,
    pub profile_id: Option<String>,
    pub depends_on: Vec<String>,
}
impl MemberSpec {
    pub fn validate(&self) -> Result<(), &'static str> {
        let valid_key = |s: &str| {
            !s.is_empty()
                && s.len() <= 64
                && !s.chars().any(|c| c.is_control() || c.is_whitespace())
        };
        if !valid_key(&self.key)
            || self.role.trim().is_empty()
            || self.role.len() > 256
            || self.goal.trim().is_empty()
            || self.goal.len() > 8192
            || self.profile_id.as_ref().is_some_and(|s| !valid_id(s))
            || self.depends_on.len() > 16
            || self
                .depends_on
                .iter()
                .any(|s| !valid_key(s) || s == &self.key)
        {
            return Err("invalid team member");
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct TeamMember {
    pub task_id: String,
    pub agent_id: String,
    pub parent_task_id: String,
    pub root_task_id: String,
    pub key: String,
    pub role: String,
    pub goal: String,
    pub profile_id: String,
    pub depth: u32,
    pub replaces_id: Option<String>,
    pub superseded_by: Option<String>,
    pub replacement_reason: Option<String>,
    pub attempt: u32,
    pub state: TaskState,
    pub pending_start: bool,
    pub depends_on: Vec<String>,
    pub report: Option<ContentRef>,
    pub review: String,
    pub review_reason: Option<String>,
    pub diagnostic: Option<ModelDiagnostic>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct TeamView {
    pub root_task_id: String,
    pub settings: TeamSettings,
    pub scheduler: SchedulerSettings,
    pub scheduling_enabled: bool,
    pub members: Vec<TeamMember>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentArtifact {
    pub path: String,
    pub revision_id: String,
    pub content: ContentRef,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentReport {
    pub task_id: String,
    pub agent_id: String,
    pub run_id: Option<String>,
    pub state: TaskState,
    pub summary: String,
    pub summary_truncated: bool,
    pub result: Option<ContentRef>,
    pub artifacts: Vec<AgentArtifact>,
    pub steps: Vec<ExecutionStep>,
    pub usage: Usage,
    pub diagnostic: Option<ModelDiagnostic>,
}
