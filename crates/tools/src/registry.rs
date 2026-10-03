use crate::files::{self, Error, Result, Root, Snapshot};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{io::Read, path::PathBuf};
use workpilot_contracts::*;
pub enum Action {
    List {
        path: String,
    },
    Read {
        path: String,
        offset: usize,
        limit: usize,
    },
    Search {
        path: String,
        text: String,
    },
    Write {
        path: String,
        text: String,
        before: Snapshot,
    },
    Process {
        program: PathBuf,
        args: Vec<String>,
        timeout_ms: u64,
        sandboxed: bool,
        inventory: Value,
        _program_guard: std::fs::File,
    },
    Artifact {
        path: String,
    },
    ReadOutput {
        step_id: String,
        channel: String,
        offset: u64,
        limit: u32,
    },
}
pub struct Prepared {
    pub root: Root,
    pub action: Action,
    pub intent: ToolIntent,
}
fn descriptor(
    name: &str,
    description: &str,
    properties: Value,
    required: &[&str],
    risk: ToolRisk,
) -> ToolDescriptor {
    ToolDescriptor {
        definition: ToolDefinition {
            name: name.into(),
            description: description.into(),
            parameters: json!({"type":"object","properties":properties,"required":required,"additionalProperties":false}),
        },
        result_schema: result_schema(name),
        scope: "Explicit task project directory; process scope is reported separately.".into(),
        cancellation: if matches!(risk, ToolRisk::Process) {
            "Stops the owned process job and descendants"
        } else {
            "Bounded file operation; a completed write cannot be undone by cancellation"
        }
        .into(),
        replay: if matches!(risk, ToolRisk::ReadOnly) {
            "Read-only; may be repeated"
        } else {
            "Never blindly repeat an uncertain effect; reconcile saved versions or ask the user"
        }
        .into(),
        risk,
    }
}
fn result_schema(name: &str) -> Value {
    let version = json!({"type":"object","required":["exists","sha256","bytes","identity"],"properties":{"exists":{"type":"boolean"},"sha256":{"type":["string","null"]},"bytes":{"type":"integer"},"identity":{"type":["string","null"]}}});
    let reference = json!({"type":"object","required":["object_id","bytes","media_type"],"properties":{"object_id":{"type":"string"},"bytes":{"type":"integer"},"media_type":{"type":"string"}}});
    let properties = match name {
        "list_directory" => {
            json!({"path":{"type":"string"},"entries":{"type":"array","items":{"type":"object","required":["name","directory","linked","bytes"]}},"truncated":{"type":"boolean"}})
        }
        "read_file" => {
            json!({"path":{"type":"string"},"text":{"type":"string"},"version":version,"next_offset":{"type":"integer"},"has_more":{"type":"boolean"}})
        }
        "search_files" => {
            json!({"matches":{"type":"array","items":{"type":"object","required":["path","line","text"]}},"files_scanned":{"type":"integer"},"skipped":{"type":"integer"},"truncated":{"type":"boolean"}})
        }
        "write_file" => {
            json!({"path":{"type":"string"},"version":version,"version_saved":{"type":"boolean"}})
        }
        "register_artifact" => {
            json!({"path":{"type":"string"},"version":version,"registered":{"type":"boolean"}})
        }
        "run_command" => {
            json!({"step_id":{"type":"string"},"exit_code":{"type":"integer"},"stopped":{"type":["string","null"]},"containment":{"type":"string"},"stdout":reference,"stderr":reference,"record":reference,"stdout_preview":{"type":"string"},"stderr_preview":{"type":"string"},"workspace_after":{"type":"object"}})
        }
        "read_command_output" => {
            json!({"text":{"type":"string"},"next_offset":{"type":"integer"},"total_bytes":{"type":"integer"}})
        }
        _ => unreachable!(),
    };
    json!({"oneOf":[{"type":"object","required":properties.as_object().unwrap().keys().collect::<Vec<_>>(),"properties":properties},{"type":"object","required":["error","executed"],"properties":{"error":{"type":"string"},"executed":{"const":false}}},{"type":"object","required":["summary","record"],"properties":{"summary":{"type":"string"},"record":reference}}]})
}
pub fn registry() -> Vec<ToolDescriptor> {
    vec![
        descriptor(
            "list_directory",
            "List up to 256 entries in an authorized directory; paths are relative; '.' means project root.",
            json!({"path":{"type":"string"}}),
            &["path"],
            ToolRisk::ReadOnly,
        ),
        descriptor(
            "read_file",
            "Read UTF-8 file pages up to 32768 bytes; files up to 1 MiB. Returns a version hash needed for overwrites.",
            json!({"path":{"type":"string"},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":32768}}),
            &["path", "offset", "limit"],
            ToolRisk::ReadOnly,
        ),
        descriptor(
            "search_files",
            "Find literal text in authorized UTF-8 files; bounded results report truncation and skipped files.",
            json!({"path":{"type":"string"},"text":{"type":"string"}}),
            &["path", "text"],
            ToolRisk::ReadOnly,
        ),
        descriptor(
            "write_file",
            "Create or replace a UTF-8 file. Parent directories must exist. Set expected_sha256 to null only for new files, otherwise use the exact hash from read_file. Approval binds the actual file version.",
            json!({"path":{"type":"string"},"text":{"type":"string"},"expected_sha256":{"type":["string","null"]}}),
            &["path", "text", "expected_sha256"],
            ToolRisk::ManagedWrite,
        ),
        descriptor(
            "run_command",
            "Run one executable (absolute path, or bundled node/python/git alias) with an argument array in the authorized project directory. Windows limits child lifetime. In approval modes it uses AppContainer with no network; full access uses OS account permissions. Workspace snapshots: 4096 files / 1024 directories / 256 MiB total / 64 MiB per file, no links; .git, node_modules, target, dist, .venv, .cache, .local, .workpilot-data and .test-results are excluded. Shell commands must explicitly name the shell executable and its arguments.",
            json!({"program":{"type":"string"},"args":{"type":"array","items":{"type":"string"}},"timeout_ms":{"type":"integer","minimum":100,"maximum":300000}}),
            &["program", "args", "timeout_ms"],
            ToolRisk::Process,
        ),
        descriptor(
            "register_artifact",
            "Register an existing authorized UTF-8 file as a task artifact, including its current version. Does not change the file.",
            json!({"path":{"type":"string"}}),
            &["path"],
            ToolRisk::ReadOnly,
        ),
        descriptor(
            "read_command_output",
            "Read a saved command's stdout or stderr page. Use step_id returned by run_command. Only this task's results can be read.",
            json!({"step_id":{"type":"string"},"channel":{"type":"string","enum":["stdout","stderr"]},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":32768}}),
            &["step_id", "channel", "offset", "limit"],
            ToolRisk::ReadOnly,
        ),
    ]
}
pub fn is_real(name: &str) -> bool {
    registry().iter().any(|d| d.definition.name == name)
}
pub fn definitions(mode: WorkMode, settings: &ToolSettingsView) -> Vec<ToolDefinition> {
    if settings.settings.root_path.is_none() {
        return vec![];
    }
    registry()
        .into_iter()
        .filter(|d| {
            (mode == WorkMode::Execute || matches!(d.risk, ToolRisk::ReadOnly))
                && (d.definition.name != "run_command" || settings.settings.commands_enabled)
        })
        .map(|d| d.definition)
        .collect()
}
pub fn prepare(
    task: &str,
    action_id: &str,
    call: &ModelToolCall,
    mode: WorkMode,
    settings: &ToolSettingsView,
) -> Result<Prepared> {
    let root = Root::open(
        settings
            .settings
            .root_path
            .as_deref()
            .ok_or(Error::Rejected("task has no authorized project directory"))?,
        settings.root_identity.as_deref(),
    )?;
    let descriptor = registry()
        .into_iter()
        .find(|d| d.definition.name == call.name)
        .ok_or(Error::Rejected("unknown tool"))?;
    if !matches!(descriptor.risk, ToolRisk::ReadOnly) && mode != WorkMode::Execute {
        return Err(Error::Rejected("work mode is read-only"));
    }
    if call.name == "run_command" && !settings.settings.commands_enabled {
        return Err(Error::Rejected("process tools are disabled for this task"));
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct PathArg {
        path: String,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct ReadArg {
        path: String,
        offset: usize,
        limit: usize,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct SearchArg {
        path: String,
        text: String,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct WriteArg {
        path: String,
        text: String,
        expected_sha256: Option<String>,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct ProcessArg {
        program: String,
        args: Vec<String>,
        timeout_ms: u64,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct OutputArg {
        step_id: String,
        channel: String,
        offset: u64,
        limit: u32,
    }
    fn decode<T: serde::de::DeserializeOwned>(v: &Value) -> Result<T> {
        serde_json::from_value(v.clone())
            .map_err(|_| Error::Rejected("tool arguments do not match the declared schema"))
    }
    let mut version = FileVersion {
        exists: true,
        sha256: None,
        bytes: 0,
        identity: Some(root.identity.clone()),
    };
    let (action, target) = match call.name.as_str() {
        "list_directory" => {
            let a: PathArg = decode(&call.arguments)?;
            files::relative(&a.path, true)?;
            (
                Action::List {
                    path: a.path.clone(),
                },
                a.path,
            )
        }
        "read_file" => {
            let a: ReadArg = decode(&call.arguments)?;
            files::relative(&a.path, false)?;
            if a.limit == 0 || a.limit > 32768 {
                return Err(Error::Rejected("invalid read limit"));
            }
            version = root.snapshot(&a.path)?.version;
            (
                Action::Read {
                    path: a.path.clone(),
                    offset: a.offset,
                    limit: a.limit,
                },
                a.path,
            )
        }
        "search_files" => {
            let a: SearchArg = decode(&call.arguments)?;
            files::relative(&a.path, true)?;
            if a.text.is_empty() || a.text.len() > 256 {
                return Err(Error::Rejected("invalid search text"));
            }
            (
                Action::Search {
                    path: a.path.clone(),
                    text: a.text,
                },
                a.path,
            )
        }
        "write_file" => {
            if call.arguments.get("expected_sha256").is_none() {
                return Err(Error::Rejected(
                    "expected_sha256 is required, use null only for a new file",
                ));
            }
            let a: WriteArg = decode(&call.arguments)?;
            if a.text.len() > 65536 {
                return Err(Error::Rejected("write argument exceeds 64 KiB"));
            }
            let before = root.snapshot(&a.path)?;
            if before.version.sha256 != a.expected_sha256 {
                return Err(Error::Rejected(
                    "file changed; read it before requesting an overwrite",
                ));
            }
            version = before.version.clone();
            (
                Action::Write {
                    path: a.path.clone(),
                    text: a.text,
                    before,
                },
                a.path,
            )
        }
        "register_artifact" => {
            let a: PathArg = decode(&call.arguments)?;
            version = root.snapshot(&a.path)?.version;
            if !version.exists {
                return Err(Error::Rejected("artifact does not exist"));
            }
            (
                Action::Artifact {
                    path: a.path.clone(),
                },
                a.path,
            )
        }
        "read_command_output" => {
            let a: OutputArg = decode(&call.arguments)?;
            if !valid_id(&a.step_id)
                || !["stdout", "stderr"].contains(&a.channel.as_str())
                || a.limit == 0
                || a.limit > 32768
                || a.offset > MAX_SAFE_SEQUENCE
            {
                return Err(Error::Rejected("invalid command output page"));
            }
            (
                Action::ReadOutput {
                    step_id: a.step_id.clone(),
                    channel: a.channel,
                    offset: a.offset,
                    limit: a.limit,
                },
                a.step_id,
            )
        }
        "run_command" => {
            if !cfg!(windows) {
                return Err(Error::Rejected(
                    "process boundary is not verified on this platform",
                ));
            }
            let a: ProcessArg = decode(&call.arguments)?;
            if !PathBuf::from(&a.program).is_absolute()
                && !matches!(
                    a.program.to_ascii_lowercase().as_str(),
                    "node"
                        | "node.exe"
                        | "python"
                        | "python.exe"
                        | "python3"
                        | "python3.exe"
                        | "git"
                        | "git.exe"
                )
            {
                return Err(Error::Rejected(
                    "Use an absolute program path or the bundled node/python/git alias",
                ));
            }
            let program = workpilot_platform::runtimes::resolve_program(&a.program)?;
            if !program.is_absolute()
                || a.args.len() > 128
                || a.args.iter().any(|s| s.len() > 16384 || s.contains('\0'))
                || a.timeout_ms < 100
                || a.timeout_ms > 300000
            {
                return Err(Error::Rejected("invalid command boundary"));
            }
            #[cfg(windows)]
            if program
                .extension()
                .and_then(|s| s.to_str())
                .is_none_or(|s| !s.eq_ignore_ascii_case("exe"))
            {
                return Err(Error::Rejected(
                    "invoke scripts through an explicit executable",
                ));
            }
            let mut options = std::fs::OpenOptions::new();
            options.read(true);
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                options.share_mode(1);
            }
            let mut file = options.open(&program)?;
            if !file.metadata()?.is_file() || file.metadata()?.len() > 128 * 1024 * 1024 {
                return Err(Error::Rejected("invalid executable file"));
            }
            let mut hash = Sha256::new();
            let mut buf = [0u8; 65536];
            loop {
                let n = file.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                hash.update(&buf[..n]);
            }
            let inventory = root.inventory()?;
            hash.update(
                serde_json::to_vec(&inventory)
                    .map_err(|_| Error::Rejected("invalid workspace snapshot"))?,
            );
            version.sha256 = Some(format!("{:x}", hash.finalize()));
            let sandboxed = settings.effective_permission != PermissionMode::FullAccess;
            (
                Action::Process {
                    program,
                    args: a.args,
                    timeout_ms: a.timeout_ms,
                    sandboxed,
                    inventory,
                    _program_guard: file,
                },
                a.program,
            )
        }
        _ => return Err(Error::Rejected("unknown tool")),
    };
    let intent = ToolIntent {
        task_id: task.into(),
        action_id: action_id.into(),
        tool: call.name.clone(),
        arguments: call.arguments.clone(),
        root_path: root.path.to_string_lossy().into_owned(),
        root_identity: root.identity.clone(),
        target,
        version,
        epoch: settings.epoch.clone(),
        mode,
        risk: descriptor.risk,
        execution_scope: if call.name == "run_command" {
            if settings.effective_permission == PermissionMode::FullAccess {
                "OS account access; no filesystem or network sandbox"
            } else {
                "Windows AppContainer; authorized project and system resources; no network"
            }
        } else {
            "authorized project directory only"
        }
        .into(),
    };
    Ok(Prepared {
        root,
        action,
        intent,
    })
}
