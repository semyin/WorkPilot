use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};
use workpilot_contracts::{Event, EventSource, Payload, TaskState, valid_id};

pub const LIMIT: usize = 128;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Preferences {
    pub in_app: bool,
    pub system: bool,
    pub tray: bool,
    pub foreground: bool,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            in_app: true,
            system: true,
            tray: true,
            foreground: false,
        }
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Completed,
    Failed,
    Input,
    Approval,
}
impl Kind {
    pub fn from_state(state: TaskState) -> Option<Self> {
        match state {
            TaskState::Completed => Some(Self::Completed),
            TaskState::Failed => Some(Self::Failed),
            TaskState::AwaitingInput => Some(Self::Input),
            TaskState::AwaitingApproval => Some(Self::Approval),
            _ => None,
        }
    }
    pub fn text(self, english: bool) -> &'static str {
        match (self, english) {
            (Self::Completed, false) => "有任务已完成",
            (Self::Completed, true) => "A task has completed",
            (Self::Failed, false) => "有任务出错了",
            (Self::Failed, true) => "A task needs attention after an error",
            (Self::Input, false) => "有任务需要你补充信息",
            (Self::Input, true) => "A task needs your input",
            (Self::Approval, false) => "有任务等待你的审批",
            (Self::Approval, true) => "A task needs your approval",
        }
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Delivery {
    Pending,
    Off,
    Foreground,
    Startup,
    Batched,
    Submitted,
    Unavailable,
    Failed,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Notice {
    pub id: String,
    pub sequence: u64,
    pub task_id: String,
    pub at_ms: u64,
    pub kind: Kind,
    pub read: bool,
    pub delivery: Delivery,
}
impl Notice {
    pub fn from_event(event: &Event) -> Option<Self> {
        // Only the actual terminal task transition. ApprovalRequested also occurs
        // for automatically approved tools, and history arrives in Reply frames.
        let Payload::TaskStateChanged { state, ref reason } = event.payload else {
            return None;
        };
        // A parent waiting for its members resumes automatically. The other
        // AwaitingInput reasons (question, plan confirmation, unreviewed team
        // results) require attention; keep unknown reasons visible as before.
        if event.source == EventSource::Recovery
            || (state == TaskState::AwaitingInput && reason.as_deref() == Some("team_waiting"))
        {
            return None;
        }
        let task_id = event.task_id.as_ref()?;
        if !valid_id(task_id) || !valid_id(&event.event_id) {
            return None;
        }
        Some(Self {
            id: event.event_id.clone(),
            sequence: event.sequence,
            task_id: task_id.clone(),
            at_ms: event.at_ms,
            kind: Kind::from_state(state)?,
            read: false,
            delivery: Delivery::Pending,
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Saved {
    pub version: u32,
    pub preferences: Preferences,
    pub entries: VecDeque<Notice>,
}
impl Default for Saved {
    fn default() -> Self {
        Self {
            version: 1,
            preferences: Preferences::default(),
            entries: VecDeque::new(),
        }
    }
}
impl Saved {
    pub fn validate(&self) -> bool {
        let mut ids = HashSet::new();
        self.version == 1
            && self.entries.len() <= LIMIT
            && self.entries.iter().all(|n| {
                valid_id(&n.id)
                    && valid_id(&n.task_id)
                    && n.sequence > 0
                    && n.sequence <= workpilot_contracts::MAX_SAFE_SEQUENCE
                    && n.at_ms <= 8_640_000_000_000_000
                    && ids.insert(&n.id)
            })
    }
    pub fn unread(&self) -> usize {
        self.entries.iter().filter(|n| !n.read).count()
    }
}

#[derive(Default)]
pub struct Ledger {
    pub saved: Saved,
    pub floor: u64,
    seen: HashSet<String>,
    seen_order: VecDeque<String>,
}
impl Ledger {
    pub fn insert(&mut self, notice: Notice) -> bool {
        if notice.sequence <= self.floor
            || self.seen.contains(&notice.id)
            || self.saved.entries.iter().any(|n| n.id == notice.id)
        {
            return false;
        }
        self.seen.insert(notice.id.clone());
        self.seen_order.push_back(notice.id.clone());
        if self.seen_order.len() > 4096
            && let Some(id) = self.seen_order.pop_front()
        {
            self.seen.remove(&id);
        }
        self.saved.entries.push_front(notice);
        self.saved.entries.truncate(LIMIT);
        true
    }
}

pub fn policy(preferences: &Preferences, focused: bool, attached: bool, burst: bool) -> Delivery {
    if !preferences.system {
        Delivery::Off
    } else if !attached {
        Delivery::Startup
    } else if focused && !preferences.foreground {
        Delivery::Foreground
    } else if burst {
        Delivery::Batched
    } else {
        Delivery::Pending
    }
}
