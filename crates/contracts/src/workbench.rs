use crate::*;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FileEdit {
    Save {
        path: String,
        expected: FileVersion,
        text: String,
    },
    Delete {
        path: String,
        expected: FileVersion,
    },
    Rename {
        path: String,
        destination: String,
        expected: FileVersion,
    },
    Restore {
        revision_id: String,
        before: bool,
        expected: FileVersion,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum WorkbenchAction {
    Media {
        effect: MediaEffect,
    },
    ReadDocument {
        path: String,
        expected: FileVersion,
    },
    Extension {
        effect: ExtensionEffect,
    },
    BrowserControl {
        control: BrowserControl,
    },
    Browser {
        action: BrowserAction,
    },
    List {
        path: String,
    },
    ReadFile {
        path: String,
    },
    Search {
        text: String,
    },
    History {
        path: Option<String>,
        before: Option<String>,
        limit: u32,
    },
    Revision {
        revision_id: String,
    },
    Edit {
        edit: FileEdit,
    },
    Terminal {
        program: String,
        args: Vec<String>,
        timeout_ms: u64,
        preview_port: Option<u16>,
    },
    GitStatus,
    GitDiff {
        path: String,
    },
    GitCommit {
        paths: Vec<String>,
        message: String,
        expected_status: String,
    },
    Approve {
        operation_id: String,
        fingerprint: String,
    },
    Stop {
        operation_id: String,
    },
    Operations,
    Operation {
        operation_id: String,
    },
    Preview {
        operation_id: String,
    },
    ResolvePath {
        path: String,
    },
}
impl WorkbenchAction {
    pub fn validate(&self) -> Result<(), &'static str> {
        fn path(p: &str) -> bool {
            !p.is_empty() && p.len() <= 4096 && !p.contains('\0')
        }
        match self {
            Self::Media { effect } => return effect.validate(),
            Self::ReadDocument { path: p, .. } if !path(p) => return Err("invalid file path"),
            Self::Extension { effect } => return effect.validate(),
            Self::Browser { action } => return action.validate(),
            Self::BrowserControl { control } => match control {
                BrowserControl::Start { channel } | BrowserControl::Pair { channel }
                    if !matches!(channel.as_str(), "chrome" | "msedge") =>
                {
                    return Err("unsupported browser channel");
                }
                BrowserControl::Disconnect { session_id }
                | BrowserControl::Takeover { session_id }
                | BrowserControl::Resume { session_id }
                    if !valid_id(session_id) =>
                {
                    return Err("invalid browser session");
                }
                _ => {}
            },
            Self::List { path: p }
            | Self::ReadFile { path: p }
            | Self::GitDiff { path: p }
            | Self::ResolvePath { path: p }
                if !path(p) =>
            {
                return Err("invalid file path");
            }
            Self::Search { text } if text.is_empty() || text.len() > 256 => {
                return Err("invalid search");
            }
            Self::History {
                path: p,
                before,
                limit,
            } if p.as_ref().is_some_and(|p| !path(p))
                || before.as_ref().is_some_and(|v| !valid_id(v))
                || !(1..=100).contains(limit) =>
            {
                return Err("invalid history page");
            }
            Self::Revision { revision_id } if !valid_id(revision_id) => {
                return Err("invalid revision");
            }
            Self::Edit { edit } => match edit {
                FileEdit::Save { path: p, text, .. } if !path(p) || text.len() > 256 * 1024 => {
                    return Err("editor limit is 256 KiB");
                }
                FileEdit::Delete { path: p, .. } if !path(p) => return Err("invalid file path"),
                FileEdit::Rename {
                    path: p,
                    destination,
                    ..
                } if !path(p) || !path(destination) || p == destination => {
                    return Err("invalid rename");
                }
                FileEdit::Restore { revision_id, .. } if !valid_id(revision_id) => {
                    return Err("invalid revision");
                }
                _ => {}
            },
            Self::Terminal {
                program,
                args,
                timeout_ms,
                preview_port,
            } => {
                if !path(program)
                    || args.len() > 128
                    || args.iter().any(|v| v.len() > 16384 || v.contains('\0'))
                    || !(100..=86_400_000).contains(timeout_ms)
                    || preview_port.is_some_and(|p| p < 1024)
                {
                    return Err("invalid terminal command");
                }
            }
            Self::GitCommit {
                paths,
                message,
                expected_status,
            } if paths.is_empty()
                || paths.len() > 128
                || paths.iter().any(|p| !path(p))
                || message.trim().is_empty()
                || message.len() > 4096
                || expected_status.len() != 64 =>
            {
                return Err("invalid Git commit");
            }
            Self::Approve {
                operation_id,
                fingerprint,
            } if !valid_id(operation_id) || fingerprint.len() != 64 => {
                return Err("invalid operation approval");
            }
            Self::Stop { operation_id }
            | Self::Operation { operation_id }
            | Self::Preview { operation_id }
                if !valid_id(operation_id) =>
            {
                return Err("invalid operation");
            }
            _ => {}
        }
        Ok(())
    }
    pub fn mutates(&self) -> bool {
        if matches!(self, Self::Extension { .. } | Self::Media { .. }) {
            return true;
        }
        if let Self::Browser { action } = self {
            return !action.read_only();
        }
        matches!(
            self,
            Self::Edit { .. } | Self::Terminal { .. } | Self::GitCommit { .. }
        )
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct FileImage {
    pub version: FileVersion,
    // Encrypted local vault identifier; never an ordinary trace content object.
    pub blob: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct FileRevision {
    pub id: String,
    pub operation_id: String,
    pub task_id: String,
    pub root_identity: String,
    pub path: String,
    pub previous_path: Option<String>,
    pub change: String,
    pub source: String,
    pub at_ms: u64,
    pub before: FileImage,
    pub after: FileImage,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct WorkbenchOperation {
    pub id: String,
    pub task_id: String,
    pub fingerprint: String,
    pub kind: String,
    pub summary: String,
    pub state: String,
    pub at_ms: u64,
    pub output: Option<ContentRef>,
    pub input: Option<ContentRef>,
    pub stdout: Option<ContentRef>,
    pub stderr: Option<ContentRef>,
    pub error: Option<String>,
    pub pid: Option<u32>,
    pub preview_port: Option<u16>,
}
