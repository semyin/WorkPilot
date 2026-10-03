use crate::*;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum BrowserControl {
    Sessions,
    Start { channel: String },
    Pair { channel: String },
    Disconnect { session_id: String },
    Takeover { session_id: String },
    Resume { session_id: String },
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum BrowserAction {
    StartDedicated {
        channel: String,
    },
    Tabs {
        session_id: String,
    },
    Snapshot {
        session_id: String,
        tab_id: String,
        query: Option<String>,
    },
    Screenshot {
        session_id: String,
        tab_id: String,
        document: String,
    },
    NewTab {
        session_id: String,
        url: String,
    },
    Navigate {
        session_id: String,
        tab_id: String,
        document: String,
        url: String,
    },
    CloseTab {
        session_id: String,
        tab_id: String,
        document: String,
    },
    Click {
        session_id: String,
        tab_id: String,
        document: String,
        reference: String,
    },
    Fill {
        session_id: String,
        tab_id: String,
        document: String,
        reference: String,
        text: String,
    },
    Upload {
        session_id: String,
        tab_id: String,
        document: String,
        reference: String,
        path: String,
        expected: FileVersion,
    },
    Download {
        session_id: String,
        tab_id: String,
        document: String,
        reference: String,
        path: String,
        expected: FileVersion,
    },
    Dialog {
        session_id: String,
        tab_id: String,
        document: String,
        accept: bool,
        text: Option<String>,
    },
}
impl BrowserAction {
    pub fn read_only(&self) -> bool {
        matches!(
            self,
            Self::Tabs { .. } | Self::Snapshot { .. } | Self::Screenshot { .. }
        )
    }
    pub fn validate(&self) -> Result<(), &'static str> {
        if let Self::StartDedicated { channel } = self
            && !matches!(channel.as_str(), "chrome" | "msedge")
        {
            return Err("unsupported browser channel");
        }
        let v = serde_json::to_value(self).map_err(|_| "invalid browser action")?;
        for name in ["session_id", "tab_id", "document", "reference"] {
            if v.get(name).is_some_and(|s| {
                s.as_str()
                    .is_none_or(|s| s.is_empty() || s.len() > 256 || s.contains('\0'))
            }) {
                return Err("invalid browser target");
            }
        }
        for name in ["url", "text", "path", "query"] {
            if v.get(name).is_some_and(|s| {
                !s.is_null()
                    && s.as_str()
                        .is_none_or(|s| s.len() > 16384 || s.contains('\0'))
            }) {
                return Err("browser input exceeds limit");
            }
        }
        Ok(())
    }
}
