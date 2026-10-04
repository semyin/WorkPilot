use super::*;

impl Store {
    pub(super) fn archived_command_outputs(
        &self,
        index: &TaskArchiveIndex,
        snapshot: &TaskArchiveSnapshot,
        task: &str,
    ) -> Result<BTreeMap<String, BTreeMap<String, ContentRef>>> {
        let rows = &snapshot.tables;
        let runs: HashSet<_> = rows["runs"]
            .iter()
            .filter(|r| r["task_id"] == task)
            .filter_map(|r| r["id"].as_str())
            .collect();
        let mut commands = BTreeMap::new();
        for step in rows["execution_steps"].iter().filter(|r| {
            r["name"] == "run_command"
                && !r["output_object_id"].is_null()
                && runs.contains(r["run_id"].as_str().unwrap_or_default())
        }) {
            let id = step["id"]
                .as_str()
                .filter(|s| valid_id(s))
                .ok_or(Error::Invalid("invalid command step"))?;
            let output: ContentRef = serde_json::from_value(step["output_object_id"].clone())?;
            if !index.objects.contains(&output) {
                return Err(Error::Invalid("foreign command result"));
            }
            let result: ModelToolResult = self.read_json(&output)?;
            let body: Value = serde_json::from_str(&result.output)?;
            let mut channels = BTreeMap::new();
            for channel in ["stdout", "stderr"] {
                if body[channel].is_null() {
                    continue;
                }
                let reference: ContentRef = serde_json::from_value(body[channel].clone())?;
                if !index.objects.contains(&reference)
                    || !rows["tool_result_objects"].iter().any(|r| {
                        r["action_id"] == id
                            && r["object_id"]
                                == serde_json::to_value(&reference).unwrap_or_default()
                    })
                {
                    return Err(Error::Invalid("command output lacks owned reference"));
                }
                channels.insert(channel.into(), reference);
            }
            commands.insert(id.into(), channels);
        }
        Ok(commands)
    }
    pub(crate) fn restored_command_output(
        &self,
        task: &str,
        step: &str,
        channel: &str,
        offset: u64,
        limit: u32,
    ) -> Result<Option<Value>> {
        let Some(history) = self.restored_history(task)? else {
            return Ok(None);
        };
        let Some(channels) = history.commands.get(step) else {
            return Ok(None);
        };
        let reference = channels.get(channel).ok_or(Error::NotFound)?;
        Ok(Some(serde_json::to_value(objects::read(
            &self.directory,
            reference,
            offset,
            limit,
        )?)?))
    }
}
