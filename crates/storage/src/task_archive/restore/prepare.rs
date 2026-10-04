use super::*;

impl Store {
    pub(super) fn prepare_task_restore(
        &self,
        archive: &str,
        project: Option<&str>,
        profile: &str,
        stop: &AtomicBool,
    ) -> Result<Prepared> {
        let bundle = self.export_saved_task_archive(archive, stop)?;
        let snapshot = validate_bundle(&bundle.index, &bundle.blobs)?;
        let rows = &snapshot.tables;
        if bundle.index.tasks.len() != 1
            || rows["agents"].len() != 1
            || rows["execution_sessions"].len() != 1
        {
            return Err(Error::Invalid(
                "请使用团队恢复入口为每个助手选择模型 / Use team restoration to select a model for every assistant",
            ));
        }
        self.prepare_archive_task(
            &bundle.index,
            &snapshot,
            &TaskProfileMapping {
                task_id: bundle.index.root_task_id.clone(),
                profile_id: profile.into(),
            },
            project,
            None,
            stop,
        )
    }
    pub(super) fn prepare_archive_task(
        &self,
        index: &TaskArchiveIndex,
        snapshot: &TaskArchiveSnapshot,
        mapping: &TaskProfileMapping,
        project: Option<&str>,
        history_targets: Option<&BTreeMap<String, String>>,
        stop: &AtomicBool,
    ) -> Result<Prepared> {
        let rows = &snapshot.tables;
        if index.excluded_media > 0 {
            return Err(Error::Invalid(
                "旧档案未保存附件原文，请从原任务重新导出；当前只能查阅 / This older archive lacks attachment originals; export it again from the source task",
            ));
        }
        let source = rows["tasks"]
            .iter()
            .find(|r| r["id"] == mapping.task_id)
            .ok_or(Error::NotFound)?;
        let one_row = |table: &str| -> Result<&Value> {
            let mut own = rows[table]
                .iter()
                .filter(|r| r["task_id"] == mapping.task_id);
            let row = own
                .next()
                .ok_or(Error::Invalid("missing task session or agent"))?;
            if own.next().is_some() {
                return Err(Error::Invalid("duplicate task session or agent"));
            }
            Ok(row)
        };
        let session = one_row("execution_sessions")?;
        let agent_row = one_row("agents")?;
        if session["task_id"] != source["id"] || session["agent_id"] != agent_row["id"] {
            return Err(Error::Invalid("archive session ownership mismatch"));
        }
        let read_ref = |value: &Value| -> Result<ContentRef> {
            let r: ContentRef = serde_json::from_value(value.clone())?;
            if !index.objects.contains(&r) {
                return Err(Error::Invalid("archive content ownership mismatch"));
            }
            Ok(r)
        };
        let mut config: ExecutionConfig =
            self.read_json(&read_ref(&session["config_object_id"])?)?;
        let mut context: ExecutionContext =
            self.read_json(&read_ref(&session["context_object_id"])?)?;
        config.validate().map_err(Error::Invalid)?;
        let source_agent: Agent = serde_json::from_value(agent_row["data_json"].clone())?;
        if source_agent.id != agent_row["id"]
            || source_agent.task_id != mapping.task_id
            || source_agent.parent_id
                != serde_json::from_value::<Option<String>>(agent_row["parent_id"].clone())?
        {
            return Err(Error::Invalid("archive agent ownership mismatch"));
        }
        if mapping.task_id == index.root_task_id
            && (source_agent.parent_id.is_some() || source_agent.replaces_id.is_some())
        {
            return Err(Error::Invalid(
                "root agent must not have a parent or replacement",
            ));
        }
        let runs: HashSet<_> = rows["runs"]
            .iter()
            .filter(|r| r["task_id"] == mapping.task_id)
            .filter_map(|r| r["id"].as_str())
            .collect();
        if rows["execution_steps"]
            .iter()
            .any(|step| !rows["runs"].iter().any(|r| r["id"] == step["run_id"]))
        {
            return Err(Error::Invalid("foreign historical step"));
        }
        let own = |r: &&Value| r["task_id"] == mapping.task_id;
        let own_step = |r: &&Value| runs.contains(r["run_id"].as_str().unwrap_or_default());
        let source_state: TaskState = serde_json::from_value(source["state"].clone())?;
        if index
            .tasks
            .iter()
            .find(|t| t.id == mapping.task_id)
            .is_none_or(|t| t.state != source_state)
        {
            return Err(Error::Invalid("archive state index mismatch"));
        }
        if (mapping.task_id == index.root_task_id && context.goal != config.goal)
            || context.constraints != config.constraints
            || context.project_rules != config.project_rules
        {
            return Err(Error::Invalid("archive context and configuration disagree"));
        }
        let profile = self.profile(&mapping.profile_id)?;
        let mut history = HistoricalData {
            profile: None,
            results: BTreeMap::new(),
            started: false,
            team_ids: BTreeMap::new(),
            media_ids: BTreeMap::new(),
            recovery: vec![],
            recovery_acknowledged: false,
            commands: BTreeMap::new(),
        };
        // Earlier restorations publish only a typed, archive-owned lookup index.
        // It contains no executable steps, permissions, or outstanding actions.
        for row in rows["events"].iter().filter(own) {
            if row["payload_json"]["kind"] == "task_restored" {
                let prior: HistoricalData =
                    self.read_json(&read_ref(&row["payload_json"]["history"])?)?;
                for r in prior.results.values() {
                    read_ref(&serde_json::to_value(r)?)?;
                }
                for r in prior.commands.values().flat_map(|c| c.values()) {
                    read_ref(&serde_json::to_value(r)?)?;
                }
                history = prior;
            }
        }
        history.started |= !session["current_run_id"].is_null();
        if !context.history.is_empty() || context.digest.is_some() || context.pending.is_some() {
            if !session["current_run_id"].is_null() {
                let run = rows["execution_runs"]
                    .iter()
                    .find(|r| {
                        r["run_id"] == session["current_run_id"] && r["session_id"] == session["id"]
                    })
                    .ok_or(Error::Invalid("missing source model identity"))?;
                let old: ProviderProfile = serde_json::from_value(run["profile_json"].clone())?;
                history.profile = Some(ModelPin::from_profile(&old));
            }
            if history
                .profile
                .as_ref()
                .is_none_or(|p| !p.matches(&profile))
            {
                return Err(Error::Invalid(
                    "请选择原协议、原模型和原服务地址；可使用本机的新密钥 / Select the original protocol, model and address; use local credentials",
                ));
            }
        }
        let audit = recovery::seal(&mut context, snapshot, &mapping.task_id)?;
        if !audit.is_empty() {
            history.recovery_acknowledged = false;
        }
        history.recovery.extend(audit);
        if !history.recovery.is_empty() {
            // A new destination needs a fresh review even if an earlier migration
            // was reconciled. Prior explanations remain visible in the history.
            history.recovery_acknowledged = false;
        }
        history::validate(&context, profile.protocol)?;
        for step in rows["execution_steps"].iter().filter(own_step) {
            if !step["output_object_id"].is_null() {
                let r = read_ref(&step["output_object_id"])?;
                let step_id = step["id"]
                    .as_str()
                    .filter(|s| valid_id(s))
                    .ok_or(Error::Invalid("invalid historical step"))?;
                if history.results.insert(step_id.into(), r).is_some() {
                    return Err(Error::Invalid("duplicate historical step"));
                }
            }
        }
        history.commands.extend(self.archived_command_outputs(
            index,
            snapshot,
            &mapping.task_id,
        )?);
        for source in context
            .sources
            .iter()
            .chain(context.digest.iter().flat_map(|d| &d.recent_sources))
        {
            if history.results.get(&source.step_id) != Some(&source.output) {
                return Err(Error::Invalid(
                    "historical source does not match its saved result",
                ));
            }
        }
        let mut ids = HashSet::new();
        let mut positions = HashSet::new();
        let mut messages = Vec::new();
        for row in rows["messages"].iter().filter(own) {
            let mut value = row.clone();
            value["content"] = value["object_id"].clone();
            let m: Message = serde_json::from_value(value)?;
            if m.role != "user"
                || !valid_id(&m.id)
                || !ids.insert(m.id.clone())
                || !positions.insert(m.queue_position)
            {
                return Err(Error::Invalid("invalid or duplicated message"));
            }
            read_ref(&serde_json::to_value(&m.content)?)?;
            let text = self.read_text_value(&m.content)?;
            if index.media.is_empty() && text.contains("[workpilot-file:") {
                return Err(Error::Invalid(
                    "附件消息尚需映射 / Attachment messages require mapping",
                ));
            }
            messages.push(m);
        }
        let mut ancestors = HashSet::from([mapping.task_id.as_str()]);
        let mut cursor = mapping.task_id.as_str();
        while let Some(parent) = index
            .tasks
            .iter()
            .find(|t| t.id == cursor)
            .and_then(|t| t.parent_task_id.as_deref())
        {
            if !ancestors.insert(parent) {
                return Err(Error::Invalid("cyclic task ancestry"));
            }
            cursor = parent;
        }
        if context.directions.iter().any(|d| {
            !rows["messages"].iter().any(|m| {
                m["id"] == d.message_id
                    && m["state"] == "delivered"
                    && ancestors.contains(m["task_id"].as_str().unwrap_or_default())
            })
        }) {
            return Err(Error::Invalid("missing delivered direction"));
        }
        messages.sort_by_key(|m| m.queue_position);
        if index.media.is_empty() && serde_json::to_string(&context)?.contains("[workpilot-file:") {
            return Err(Error::Invalid(
                "附件引用尚需映射 / Attachment references require mapping",
            ));
        }
        let project = self.task_restore_target(project)?;
        let history_roots =
            file_history::mapped_targets(index, &mapping.task_id, &project, history_targets)?;
        if !source["project_id"].is_null() && project.is_none() {
            return Err(Error::Invalid(
                "请为原项目选择本机文件夹 / Select a local project for the original project",
            ));
        }
        // Preserve task-specific rules and show the complete resulting rules in preview.
        if let Some((p, _)) = &project
            && !p.settings.rules.is_empty()
            && p.settings.rules != config.project_rules
            && !config
                .project_rules
                .ends_with(&format!("\n\n{}", p.settings.rules))
        {
            config.project_rules = format!("{}\n\n{}", config.project_rules, p.settings.rules)
                .trim()
                .to_owned();
        }
        config.project_id = project.as_ref().map(|p| p.0.id.clone());
        config.profile_id = Some(profile.id.clone());
        let mut title = source["title"]
            .as_str()
            .ok_or(Error::Invalid("invalid source title"))?
            .to_owned();
        while title.len() + " · 恢复".len() > 512 {
            title.pop();
        }
        config.title = format!("{title} · 恢复");
        config.validate().map_err(Error::Invalid)?;
        let mut attachment_texts = vec![serde_json::to_string(&context)?];
        for message in &messages {
            attachment_texts.push(self.read_text_value(&message.content)?);
        }
        attachments::validate_references(
            index,
            snapshot,
            &mapping.task_id,
            &history,
            &attachment_texts,
            self,
        )?;
        context.project_rules = config.project_rules.clone();
        let fingerprint = digest(&serde_json::to_vec(
            &json!({"archive":index,"target":self.directory,"project":project,"profile":profile.without_credential()}),
        )?);
        let mut conversation = Vec::new();
        let mut events: Vec<_> = rows["events"].iter().filter(own).collect();
        events.sort_by_key(|e| e["sequence"].as_u64().unwrap_or_default());
        for row in events {
            let v = &row["payload_json"];
            let at = row["at_ms"]
                .as_u64()
                .ok_or(Error::Invalid("invalid historical timestamp"))?;
            match v["kind"].as_str() {
                Some("message_delivered") => {
                    let m = messages
                        .iter()
                        .find(|m| v["message_id"] == m.id)
                        .ok_or(Error::Invalid("missing conversation message"))?;
                    conversation.push(("user".into(), m.content.clone(), at));
                }
                Some("execution_step_changed")
                    if v["name"] == "model" && v["state"] == "completed" =>
                {
                    conversation.push(("assistant".into(), read_ref(&v["output"])?, at));
                }
                Some("restored_message") => {
                    let role = v["role"]
                        .as_str()
                        .filter(|r| ["user", "assistant"].contains(r))
                        .ok_or(Error::Invalid("invalid historical role"))?;
                    conversation.push((
                        role.into(),
                        read_ref(&v["content"])?,
                        v["original_at_ms"]
                            .as_u64()
                            .ok_or(Error::Invalid("invalid timestamp"))?,
                    ));
                }
                _ => {}
            }
        }
        // A readable archive may contain arbitrary records; reject an invalid
        // conversation body before committing a task that the UI cannot open.
        for (role, reference, _) in &conversation {
            if role == "assistant" {
                self.read_json::<ModelOutput>(reference)?;
            } else {
                self.read_text_value(reference)?;
            }
        }
        let state = if source_state == TaskState::Completed {
            TaskState::Completed
        } else if source_state == TaskState::Failed {
            TaskState::Failed
        } else if context.question.is_some() {
            TaskState::AwaitingInput
        } else {
            TaskState::Interrupted
        };
        check_stop(stop)?;
        Ok(Prepared {
            index: index.clone(),
            config,
            context,
            messages,
            conversation,
            history,
            project,
            profile,
            state,
            fingerprint,
            source_id: mapping.task_id.clone(),
            source_agent,
            history_roots,
        })
    }
}
