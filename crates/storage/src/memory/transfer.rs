//! Portable memory revisions, preserving state without inheriting task links.
use super::*;

impl Store {
    pub(crate) fn transferred_memory_history(&self, memory: &str) -> Result<ProjectMemoryHistory> {
        let mut q = self.connection.prepare(
            "SELECT data_json FROM memory_versions WHERE memory_id=?1 ORDER BY revision LIMIT 257",
        )?;
        let raw = q
            .query_map([memory], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        if raw.len() > 256 {
            return Err(Error::Invalid(
                "单条记忆历史超过 256 个版本，未截断导出 / Memory history exceeds 256 versions; export was not truncated",
            ));
        }
        Ok(ProjectMemoryHistory {
            memory_id: memory.into(),
            versions: raw
                .into_iter()
                .map(|v| self.memory_item(serde_json::from_str(&v)?))
                .collect::<Result<_>>()?,
        })
    }
    pub(crate) fn prepare_transferred_history(
        &mut self,
        source: &MemoryItem,
        history: Option<&ProjectMemoryHistory>,
        target_project: &str,
        archive: &str,
    ) -> Result<Vec<(Stored, String)>> {
        let Some(history) = history else {
            let value = self.prepare_transferred_memory(
                source,
                source
                    .project_id
                    .as_ref()
                    .map(|_| target_project.to_owned()),
                archive,
            )?;
            let text = self.read_text_value(&value.memory.content)?;
            return Ok(vec![(value, text)]);
        };
        let target_id = id();
        let mut versions = Vec::new();
        for original in &history.versions {
            let mut value = self.prepare_transferred_memory(
                original,
                original
                    .project_id
                    .as_ref()
                    .map(|_| target_project.to_owned()),
                archive,
            )?;
            value.memory.id = target_id.clone();
            if let Some(task) = &original.source_task_id {
                value
                    .source_label
                    .push_str(&format!(" · source task: {task}"));
            }
            value.memory.state = original.state;
            value.memory.confirmed_at_ms = original.confirmed_at_ms;
            value.revision = original.revision;
            value.deleted = original.deleted;
            value.updated_at_ms = original.updated_at_ms;
            value.change = original.change.clone();
            let text = self.read_text_value(&value.memory.content)?;
            versions.push((value, text));
        }
        let (mut current, text) = versions
            .last()
            .cloned()
            .ok_or(Error::Invalid("missing memory history"))?;
        current.revision = current.revision.checked_add(1).ok_or(Error::Conflict)?;
        current.updated_at_ms = now_ms();
        current.change = "imported_with_history".into();
        if current.memory.state == MemoryState::Confirmed && !current.deleted {
            current.memory.confirmed_at_ms = Some(current.updated_at_ms);
        }
        versions.push((current, text));
        Ok(versions)
    }
    pub(crate) fn prepare_transferred_memory(
        &mut self,
        original: &MemoryItem,
        project: Option<String>,
        archive: &str,
    ) -> Result<Stored> {
        let mut label = original.source_label.clone();
        while label.len() > 2048 {
            label.pop();
        }
        let mut value = self.new_memory(
            &original.text,
            None,
            None,
            format!(
                "导入 / Imported: {} · {}@{} · {}",
                label, original.id, original.revision, archive
            ),
            original.source_quote.clone(),
            MemoryState::Confirmed,
        )?;
        value.memory.project_id = project;
        value.created_at_ms = original.created_at_ms;
        value.change = "imported_and_confirmed".into();
        Ok(value)
    }
}
