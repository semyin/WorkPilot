use crate::*;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ScheduleRule {
    Once {
        local: String,
    },
    Interval {
        minutes: u32,
    },
    Daily {
        hour: u32,
        minute: u32,
    },
    Weekly {
        weekdays: Vec<u32>,
        hour: u32,
        minute: u32,
    },
}
impl ScheduleRule {
    pub fn validate(&self) -> Result<(), &'static str> {
        let valid = match self {
            Self::Once { local } => matches!(local.len(), 16 | 19),
            Self::Interval { minutes } => (1..=10080).contains(minutes),
            Self::Daily { hour, minute } => *hour < 24 && *minute < 60,
            Self::Weekly {
                weekdays,
                hour,
                minute,
            } => {
                *hour < 24
                    && *minute < 60
                    && !weekdays.is_empty()
                    && weekdays.len() <= 7
                    && weekdays.iter().all(|n| (1..=7).contains(n))
            }
        };
        if valid {
            Ok(())
        } else {
            Err("触发时间无效 / Invalid schedule time")
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ScheduleSpec {
    pub title: String,
    pub goal: String,
    pub project_id: Option<String>,
    pub profile_id: String,
    pub mode: WorkMode,
    pub permission: PermissionMode,
    pub review_profile_id: Option<String>,
    pub commands_enabled: bool,
    pub timezone: String,
    pub rule: ScheduleRule,
    pub enabled: bool,
}
impl ScheduleSpec {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.title.trim().is_empty()
            || self.title.len() > 256
            || self.goal.trim().is_empty()
            || self.goal.len() > 16384
            || !valid_id(&self.profile_id)
            || self.project_id.as_ref().is_some_and(|s| !valid_id(s))
            || self
                .review_profile_id
                .as_ref()
                .is_some_and(|s| !valid_id(s))
            || self.timezone.is_empty()
            || self.timezone.len() > 128
            || self.commands_enabled && self.project_id.is_none()
        {
            return Err("请检查目标、模型、项目和时区 / Invalid schedule settings");
        }
        self.rule.validate()
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct SchedulePlan {
    pub id: String,
    pub revision: u32,
    pub spec: ScheduleSpec,
    pub project_revision: Option<u32>,
    pub profile_revision: u32,
    pub review_profile_revision: Option<u32>,
    pub next_at_ms: Option<u64>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub deleted: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ScheduleOccurrence {
    pub sequence: u64,
    pub id: String,
    pub schedule_id: String,
    pub revision: u32,
    pub due_at_ms: u64,
    pub recorded_at_ms: u64,
    pub trigger: String,
    pub state: String,
    pub reason: Option<String>,
    pub task_id: Option<String>,
    pub task_state: Option<TaskState>,
    pub active: bool,
    pub missed_count: Option<u64>,
    pub missed_until_ms: Option<u64>,
    pub plan: ContentRef,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ScheduleAction {
    List {
        include_deleted: bool,
        offset: u32,
        limit: u32,
    },
    Timezones,
    Preview {
        timezone: String,
        rule: ScheduleRule,
    },
    Save {
        schedule_id: Option<String>,
        revision: u32,
        spec: ScheduleSpec,
    },
    SetEnabled {
        schedule_id: String,
        revision: u32,
        enabled: bool,
    },
    Delete {
        schedule_id: String,
        revision: u32,
    },
    RunNow {
        schedule_id: String,
        revision: u32,
    },
    History {
        schedule_id: String,
        before: Option<u64>,
        limit: u32,
    },
}
impl ScheduleAction {
    pub fn validate(&self) -> Result<(), &'static str> {
        match self {
            Self::List { offset, limit, .. } => {
                if *offset <= 1_000_000 && (1..=16).contains(limit) {
                    Ok(())
                } else {
                    Err("invalid schedule page")
                }
            }
            Self::Timezones => Ok(()),
            Self::Preview { timezone, rule } => {
                if timezone.is_empty() || timezone.len() > 128 {
                    return Err("invalid timezone");
                }
                rule.validate()
            }
            Self::Save {
                schedule_id, spec, ..
            } => {
                if schedule_id.as_ref().is_some_and(|s| !valid_id(s)) {
                    return Err("invalid schedule");
                }
                spec.validate()
            }
            Self::History {
                schedule_id,
                before,
                limit,
            } => {
                if valid_id(schedule_id)
                    && before.is_none_or(|v| v <= MAX_SAFE_SEQUENCE)
                    && (1..=64).contains(limit)
                {
                    Ok(())
                } else {
                    Err("invalid history page")
                }
            }
            Self::SetEnabled { schedule_id, .. }
            | Self::Delete { schedule_id, .. }
            | Self::RunNow { schedule_id, .. } => {
                if valid_id(schedule_id) {
                    Ok(())
                } else {
                    Err("invalid schedule")
                }
            }
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ScheduleData {
    List {
        items: Vec<SchedulePlan>,
        total: u32,
    },
    Timezones {
        zones: Vec<String>,
        version: String,
    },
    Preview {
        next_at_ms: Option<u64>,
        timezone_database: String,
    },
    Updated {
        schedule_id: String,
    },
    Run {
        occurrence: Box<ScheduleOccurrence>,
    },
    History {
        items: Vec<ScheduleOccurrence>,
        has_more: bool,
    },
}
