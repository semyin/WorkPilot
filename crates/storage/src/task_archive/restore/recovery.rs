//! Seal old in-flight calls as historical outcomes. Never recreate executable actions.
use super::*;

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct RecoveryItem {
    pub kind: String,
    pub source_id: String,
    pub detail: String,
    #[serde(default)]
    pub record: Option<Value>,
}

pub(super) fn seal(
    context: &mut ExecutionContext,
    snapshot: &TaskArchiveSnapshot,
    task: &str,
) -> Result<Vec<RecoveryItem>> {
    let rows = &snapshot.tables;
    let runs: HashSet<_> = rows["runs"]
        .iter()
        .filter(|r| r["task_id"] == task)
        .filter_map(|r| r["id"].as_str())
        .collect();
    let mut audit = vec![];
    if rows["tasks"]
        .iter()
        .any(|r| r["id"] == task && r["state"] == "awaiting_approval")
    {
        audit.push(RecoveryItem {kind:"inactive_approval_state".into(),source_id:task.into(),
            detail:"原任务正在等待审批，须重新核对 / The original task awaited approval; review it again".into(),record:None});
    }
    for (table, kind) in [
        ("execution_steps", "uncertain_step"),
        ("approvals", "inactive_approval"),
        ("workbench_operations", "inactive_file_operation"),
        ("team_waiters", "inactive_team_wait"),
    ] {
        for row in &rows[table] {
            let belongs = if table == "execution_steps" {
                runs.contains(row["run_id"].as_str().unwrap_or_default())
            } else {
                row["task_id"] == task
            };
            if table == "team_waiters" && belongs {
                let valid_action = rows["execution_steps"].iter().any(|r| {
                    r["id"] == row["action_id"]
                        && runs.contains(r["run_id"].as_str().unwrap_or_default())
                });
                let valid_members = row["members_json"].as_array().is_some_and(|members| {
                    members
                        .iter()
                        .all(|m| rows["tasks"].iter().any(|t| t["id"] == *m))
                });
                if !valid_action || !valid_members {
                    return Err(Error::Invalid("invalid historical team wait"));
                }
            }
            let pending = match table {
                "execution_steps" => !matches!(
                    row["state"].as_str(),
                    Some("completed" | "failed" | "cancelled" | "skipped")
                ),
                "approvals" => row["data_json"]["state"] == "pending",
                "workbench_operations" => !matches!(
                    row["data_json"]["state"].as_str(),
                    Some("completed" | "failed" | "cancelled")
                ),
                _ => true,
            };
            if belongs && pending {
                audit.push(RecoveryItem {kind:kind.into(), source_id:row["id"].as_str()
                    .or(row["action_id"].as_str()).unwrap_or(task).into(),
                    detail:"原操作仅保留记录；效果须在新位置重新核对，原审批不生效 / Historical record only; verify effects at the destination and request new approval".into(),record:Some(row.clone())});
            }
        }
    }
    if let Some(pending) = context.pending.take() {
        let calls = &pending.response.tool_calls;
        if calls.is_empty()
            || calls.len() != pending.action_ids.len()
            || pending.next as usize != pending.results.len()
            || pending.results.len() > calls.len()
            || pending.action_ids.iter().collect::<HashSet<_>>().len() != calls.len()
            || calls.iter().map(|c| &c.id).collect::<HashSet<_>>().len() != calls.len()
        {
            return Err(Error::Invalid("invalid archived pending batch"));
        }
        for (i, action) in pending.action_ids.iter().enumerate() {
            let step = rows["execution_steps"]
                .iter()
                .find(|r| {
                    r["id"] == *action && runs.contains(r["run_id"].as_str().unwrap_or_default())
                })
                .ok_or(Error::Invalid("pending action belongs to another task"))?;
            if step["provider_call_id"] != calls[i].id
                || pending
                    .results
                    .get(i)
                    .is_some_and(|r| r.call_id != calls[i].id)
            {
                return Err(Error::Invalid("pending call ownership mismatch"));
            }
        }
        let mut results = pending.results;
        for call in calls.iter().skip(results.len()) {
            results.push(ModelToolResult {
                call_id:call.id.clone(), is_error:true,
                output:json!({"error":"migration_requires_reconciliation",
                    "message":"This source operation was not replayed. Its external effects may be unknown. Inspect the current destination before proposing a fresh action. Previous approval is inactive."}).to_string(),
            });
        }
        audit.push(RecoveryItem {
            kind: "sealed_tool_batch".into(),
            source_id: pending.model_step_id,
            record: Some(json!({"calls":calls})),
            detail: format!(
                "{} 个旧调用已封存；没有重新执行 / {} old calls sealed without execution",
                calls.len(),
                calls.len()
            ),
        });
        context.history.push(ModelHistoryItem::Exchange {
            continuation: pending.response.continuation,
            tool_results: results,
        });
    }
    if audit.len() > 512 {
        return Err(Error::Invalid("too many unresolved migration operations"));
    }
    if !audit.is_empty() {
        context.history.push(ModelHistoryItem::Message {message:ModelMessage {
            role:"user".into(), content:vec![ModelContent::Text {text:
                "WorkPilot migration notice: old in-flight calls, waits and approvals are historical only. Do not repeat them from memory. First inspect the destination and reconcile unknown effects; then propose fresh actions under the current request-approval policy. Nothing was executed by restoring this task.".into()}],
        }});
    }
    Ok(audit)
}

impl Store {
    pub fn migration_recovery_status(&self, task: &str) -> Result<Value> {
        self.task(task)?;
        let data = self.restored_history(task)?;
        Ok(
            json!({"required":data.as_ref().is_some_and(|d|!d.recovery.is_empty()&&!d.recovery_acknowledged),
            "items":data.map(|d|d.recovery).unwrap_or_default()}),
        )
    }
    pub fn resolve_migration_recovery(
        &mut self,
        task: &str,
        notes: &[String],
    ) -> Result<(Value, Vec<Event>)> {
        let mut history = self.restored_history(task)?.ok_or(Error::NotFound)?;
        if history.recovery_acknowledged {
            return Ok((json!({"resolved":true,"duplicate":true}), vec![]));
        }
        if history.recovery.len() != notes.len()
            || notes.iter().any(|s| s.trim().len() < 2 || s.len() > 4096)
        {
            return Err(Error::Invalid(
                "请逐项填写实际核对结果 / Enter the actual review outcome for every item",
            ));
        }
        let snapshot = self.execution_snapshot(task)?;
        if snapshot
            .latest_run
            .as_ref()
            .is_some_and(|r| matches!(r.run.state, TaskState::Running | TaskState::Queued))
        {
            return Err(Error::Busy);
        }
        let mut context = snapshot.context;
        let outcomes=history.recovery.iter().zip(notes).map(|(item,note)|json!({
            "kind":item.kind,"source_id":item.source_id,"user_review":self.redactor.text(note)
        })).collect::<Vec<_>>();
        context.history.push(ModelHistoryItem::Message {message:ModelMessage {role:"user".into(),content:vec![
            ModelContent::Text {text:format!("Migration reconciliation provided by the user. Old actions remain inactive; current approvals still apply:\n{}",serde_json::to_string(&outcomes)?)}
        ]}});
        history.recovery_acknowledged = true;
        let history_ref = self.save_json(serde_json::to_value(&history)?)?;
        let context_ref = self.save_json(serde_json::to_value(&context)?)?;
        let tx = self.connection.transaction()?;
        tx.execute(
            "UPDATE execution_sessions SET context_object_id=?2 WHERE task_id=?1",
            params![task, context_ref.object_id],
        )?;
        tx.execute(
            "UPDATE settings SET value_json=?2 WHERE key=?1",
            params![
                format!("task-restored-history:{task}"),
                encode(&history_ref)?
            ],
        )?;
        let event = record(
            &tx,
            &self.redactor,
            Some(task),
            None,
            EventSource::User,
            Payload::TaskRestored {
                archive_id: "reconciliation".into(),
                source_task_id: task.into(),
                history: history_ref,
            },
        )?;
        tx.commit()?;
        Ok((json!({"resolved":true,"duplicate":false}), vec![event]))
    }
}
