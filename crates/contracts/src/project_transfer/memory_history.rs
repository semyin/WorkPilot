use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectMemoryHistory {
    pub memory_id: String,
    pub versions: Vec<MemoryItem>,
}

impl ProjectTransferBundle {
    pub(super) fn validate_memory_history(&self) -> Result<(), &'static str> {
        let bad = "记忆历史缺失、重复、越界或超过上限 / Missing, duplicate, out-of-scope or excessive memory history";
        if self.version == 1 {
            return if self.memory_history.is_empty() {
                Ok(())
            } else {
                Err(bad)
            };
        }
        if self.memory_history.len() != self.memories.len()
            || self
                .memory_history
                .iter()
                .map(|h| h.versions.len())
                .sum::<usize>()
                > 2048
            || !selection(
                &self
                    .memory_history
                    .iter()
                    .map(|h| h.memory_id.clone())
                    .collect::<Vec<_>>(),
            )
        {
            return Err(bad);
        }
        for history in &self.memory_history {
            let current = self
                .memories
                .iter()
                .find(|m| m.id == history.memory_id)
                .ok_or(bad)?;
            if history.versions.is_empty()
                || history.versions.len() > 256
                || current.revision == u32::MAX
            {
                return Err(bad);
            }
            let mut previous = 0;
            for v in &history.versions {
                if v.id != current.id
                    || v.revision <= previous
                    || v.revision > current.revision
                    || v.text.trim().is_empty()
                    || v.text.len() > 4096
                    || v.source_label.len() > 4096
                    || v.source_quote.len() > 4096
                    || v.change.len() > 256
                    || v.project_id
                        .as_ref()
                        .is_some_and(|id| id != &self.project.id)
                    || v.source_task_id.as_ref().is_some_and(|id| !valid_id(id))
                    || [
                        v.created_at_ms,
                        v.updated_at_ms,
                        v.confirmed_at_ms.unwrap_or(0),
                    ]
                    .iter()
                    .any(|n| *n > MAX_SAFE_SEQUENCE)
                {
                    return Err(bad);
                }
                previous = v.revision;
            }
            let mut latest = history.versions.last().ok_or(bad)?.clone();
            // Source-task deletion clears the live link; historical provenance may retain its ID.
            latest.source_task_id = current.source_task_id.clone();
            if serde_json::to_value(latest).map_err(|_| bad)?
                != serde_json::to_value(current).map_err(|_| bad)?
            {
                return Err(bad);
            }
        }
        Ok(())
    }
}
