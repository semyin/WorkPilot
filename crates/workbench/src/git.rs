use crate::vault::Result;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, atomic::AtomicBool},
};
use workpilot_platform::tool_process::{self, ProcessResult, ProcessSpec};
use workpilot_tools::{binary::user_path, files::Root};
pub fn executable(name: &str) -> Result<PathBuf> {
    workpilot_platform::runtimes::resolve_program(name).map_err(|e| e.to_string())
}
pub fn run(
    root: &Root,
    data: &Path,
    args: &[String],
    stop: Arc<AtomicBool>,
) -> Result<ProcessResult> {
    let mut actual = vec![
        "--literal-pathspecs".into(),
        "-c".into(),
        "core.quotepath=false".into(),
        "-c".into(),
        "core.fsmonitor=false".into(),
        "-c".into(),
        "commit.gpgsign=false".into(),
        "-c".into(),
        format!(
            "core.hooksPath={}",
            data.join("disabled-git-hooks").display()
        ),
    ];
    actual.extend_from_slice(args);
    tool_process::run(
        ProcessSpec {
            program: executable("git")?,
            args: actual,
            cwd: root.path.clone(),
            sandboxed: false,
            timeout_ms: 30000,
            output_limit: 4 * 1024 * 1024,
            ledger_dir: data.join("tool-boundary"),
        },
        stop,
    )
    .map_err(|e| e.to_string())
}
fn checked(root: &Root, data: &Path, args: &[&str]) -> Result<String> {
    let r = run(
        root,
        data,
        &args.iter().map(|v| (*v).into()).collect::<Vec<_>>(),
        Arc::new(AtomicBool::new(false)),
    )?;
    if r.exit_code != 0 || r.stopped.is_some() {
        return Err(r.stderr);
    }
    Ok(r.stdout)
}
pub fn status(root: &Root, data: &Path) -> Result<Value> {
    let top = checked(root, data, &["rev-parse", "--show-toplevel"])?;
    if Path::new(top.trim())
        .canonicalize()
        .map_err(|e| e.to_string())?
        != root.path.canonicalize().map_err(|e| e.to_string())?
    {
        return Err("请将项目绑定到 Git 仓库根目录。".into());
    }
    let head = checked(root, data, &["rev-parse", "--verify", "HEAD"])
        .unwrap_or_default()
        .trim()
        .to_owned();
    let branch = checked(root, data, &["symbolic-ref", "--short", "HEAD"])
        .unwrap_or_else(|_| "detached".into())
        .trim()
        .to_owned();
    let raw = checked(
        root,
        data,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    let mut fields = raw.split('\0').filter(|s| !s.is_empty());
    let mut entries = vec![];
    while let Some(field) = fields.next() {
        if field.len() < 4 || !field.is_char_boundary(3) {
            return Err("invalid Git status".into());
        }
        if entries.len() >= 4096 {
            return Err("Git changes exceed 4096 files".into());
        }
        let code = &field[..2];
        let path = &field[3..];
        user_path(path).map_err(|e| e.to_string())?;
        let previous = if code.contains(['R', 'C']) {
            fields.next().map(str::to_owned)
        } else {
            None
        };
        let version = root
            .binary_snapshot(path)
            .map_err(|e| e.to_string())?
            .version;
        entries.push(json!({"status":code,"path":path,"previous_path":previous,"version":version}));
    }
    let index = checked(root, data, &["ls-files", "--stage", "-z"])?;
    let fingerprint = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&json!({"head":head,"index":index,"entries":entries}))
                .map_err(|e| e.to_string())?
        )
    );
    Ok(json!({"head":head,"branch":branch,"entries":entries,"fingerprint":fingerprint}))
}
pub fn diff(root: &Root, data: &Path, path: &str) -> Result<Value> {
    user_path(path).map_err(|e| e.to_string())?;
    let unstaged = checked(
        root,
        data,
        &["diff", "--no-ext-diff", "--no-textconv", "--", path],
    )?;
    let staged = checked(
        root,
        data,
        &[
            "diff",
            "--cached",
            "--no-ext-diff",
            "--no-textconv",
            "--",
            path,
        ],
    )?;
    Ok(json!({"path":path,"staged":staged,"unstaged":unstaged}))
}
pub fn commit(
    root: &Root,
    data: &Path,
    paths: &[String],
    message: &str,
    expected: &str,
    stop: Arc<AtomicBool>,
) -> Result<Value> {
    let current = status(root, data)?;
    if current["fingerprint"].as_str() != Some(expected) {
        return Err("Git 或文件发生了变化，请刷新后重新选择提交范围。".into());
    }
    let entries = current["entries"].as_array().ok_or("invalid Git status")?;
    let mut additions = vec![];
    for p in paths {
        user_path(p).map_err(|e| e.to_string())?;
        let attributes = checked(root, data, &["check-attr", "-z", "filter", "--", p])?;
        let value = attributes.split('\0').nth(2).unwrap_or("unspecified");
        if value != "unspecified" && value != "unset" {
            return Err(
                "此文件配置了外部 Git 过滤器。当前内置提交不会执行过滤器，请使用项目终端处理。"
                    .into(),
            );
        }
        let row = entries
            .iter()
            .find(|e| e["path"].as_str() == Some(p) || e["previous_path"].as_str() == Some(p))
            .ok_or("selected file has no changes")?;
        if row["status"]
            .as_str()
            .is_some_and(|s| s.contains('U') || s == "AA" || s == "DD")
        {
            return Err("请先解决 Git 合并冲突。".into());
        }
        if let Some(previous) = row["previous_path"].as_str()
            && !paths.iter().any(|p| p == previous)
        {
            return Err("重命名提交需要同时选择原路径和新路径。".into());
        }
        if row["status"] == "??" {
            additions.push(p.clone());
        }
    }
    if !additions.is_empty() {
        let mut args = vec!["add".into(), "--intent-to-add".into(), "--".into()];
        args.extend(additions);
        let added = run(root, data, &args, stop.clone())?;
        if added.exit_code != 0 || added.stopped.is_some() {
            return Err(added.stderr);
        }
    }
    let mut args = vec![
        "commit".into(),
        "--only".into(),
        "--no-verify".into(),
        "-m".into(),
        message.into(),
        "--".into(),
    ];
    args.extend_from_slice(paths);
    let result = run(root, data, &args, stop)?;
    if result.exit_code != 0 || result.stopped.is_some() {
        return Err(format!(
            "提交未完成。已选新文件可能保留为待添加状态；其它暂存内容未清理。 {}",
            result.stderr
        ));
    }
    let after = status(root, data)?;
    Ok(json!({"commit":after["head"],"output":result.stdout,"status":after,"pushed":false}))
}
