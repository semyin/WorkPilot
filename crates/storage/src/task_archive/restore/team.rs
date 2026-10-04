use super::*;
use team_graph::Graph;

pub(super) struct Group {
    pub nodes: Vec<Prepared>,
    pub graph: Option<Graph>,
    pub fingerprint: String,
    pub media: Vec<TaskRestoreMedia>,
}
impl Store {
    pub fn task_group_restore_options(&self, archive: &str, stop: &AtomicBool) -> Result<Value> {
        if let Some(mut receipt) = self.restoration_receipt(archive)? {
            receipt["already_restored"] = json!(true);
            return Ok(receipt);
        }
        let bundle = self.export_saved_task_archive(archive, stop)?;
        let snapshot = validate_bundle(&bundle.index, &bundle.blobs)?;
        let mut tasks = vec![];
        for t in &bundle.index.tasks {
            let session = snapshot.tables["execution_sessions"]
                .iter()
                .find(|r| r["task_id"] == t.id)
                .ok_or(Error::Invalid("missing task session"))?;
            let mut pin = None;
            if let Some(run) = snapshot.tables["execution_runs"].iter().find(|r| {
                r["run_id"] == session["current_run_id"] && r["session_id"] == session["id"]
            }) {
                pin = Some(ModelPin::from_profile(&serde_json::from_value::<
                    ProviderProfile,
                >(
                    run["profile_json"].clone()
                )?));
            } else {
                for row in &snapshot.tables["events"] {
                    if row["task_id"] == t.id && row["payload_json"]["kind"] == "task_restored" {
                        let r: ContentRef =
                            serde_json::from_value(row["payload_json"]["history"].clone())?;
                        if !bundle.index.objects.contains(&r) {
                            return Err(Error::Invalid("foreign history index"));
                        }
                        pin = self.read_json::<HistoricalData>(&r)?.profile;
                    }
                }
            }
            tasks.push(json!({"task_id":t.id,"title":t.title,"state":t.state,"parent_task_id":t.parent_task_id,"project_id":snapshot.tables["tasks"].iter().find(|r|r["id"]==t.id).map(|r|r["project_id"].clone()),"model":pin}));
        }
        Ok(
            json!({"already_restored":false,"tasks":tasks,"excluded_media":bundle.index.excluded_media,"history_roots":bundle.index.file_history.iter().map(|h|h.root_identity.clone()).collect::<std::collections::BTreeSet<_>>()}),
        )
    }
    fn prepare_task_group(
        &self,
        archive: &str,
        project: Option<&str>,
        profiles: &[TaskProfileMapping],
        stop: &AtomicBool,
    ) -> Result<Group> {
        let bundle = self.export_saved_task_archive(archive, stop)?;
        let snapshot = validate_bundle(&bundle.index, &bundle.blobs)?;
        let mut seen = HashSet::new();
        if snapshot.tables["agents"].len() != bundle.index.tasks.len()
            || snapshot.tables["execution_sessions"].len() != bundle.index.tasks.len()
        {
            return Err(Error::Invalid("archive session or agent count mismatch"));
        }
        for (table, column) in [("agents", "id"), ("execution_sessions", "id")] {
            let mut identities = HashSet::new();
            if snapshot.tables[table].iter().any(|r| {
                r[column]
                    .as_str()
                    .is_none_or(|id| !valid_id(id) || !identities.insert(id))
            }) {
                return Err(Error::Invalid("duplicate or invalid archive identity"));
            }
        }
        if profiles.len() != bundle.index.tasks.len()
            || profiles.iter().any(|p| {
                !seen.insert(&p.task_id) || !bundle.index.tasks.iter().any(|t| t.id == p.task_id)
            })
        {
            return Err(Error::Invalid(
                "每个主任务和助手都需要一个模型配置 / Select one model configuration for every task and assistant",
            ));
        }
        let root_project = &snapshot.tables["tasks"][0]["project_id"];
        if snapshot.tables["tasks"]
            .iter()
            .any(|r| &r["project_id"] != root_project)
        {
            return Err(Error::Invalid(
                "跨项目团队尚需分别映射 / Cross-project teams require separate project mapping",
            ));
        }
        let mut nodes = vec![];
        for task in &bundle.index.tasks {
            check_stop(stop)?;
            let mapping = profiles
                .iter()
                .find(|p| p.task_id == task.id)
                .ok_or(Error::NotFound)?;
            nodes.push(self.prepare_archive_task(
                &bundle.index,
                &snapshot,
                mapping,
                project,
                None,
                stop,
            )?);
        }
        if nodes[0].source_agent.parent_id.is_some() {
            return Err(Error::Invalid("root agent must not have a parent"));
        }
        let mut messages = HashSet::new();
        if nodes
            .iter()
            .flat_map(|n| &n.messages)
            .any(|m| !messages.insert(&m.id))
        {
            return Err(Error::Invalid("duplicate group message"));
        }
        let graph = self.restoration_graph(&bundle.index, &snapshot, &nodes)?;
        let fingerprint = digest(&serde_json::to_vec(
            &json!({"kind":"team_restore_v1","node_fingerprints":nodes.iter().map(|p|(&p.source_id,&p.fingerprint)).collect::<Vec<_>>()}),
        )?);
        Ok(Group {
            nodes,
            graph: Some(graph),
            fingerprint,
            media: vec![],
        })
    }
    pub fn task_group_restore_preview(
        &self,
        archive: &str,
        project: Option<&str>,
        profiles: &[TaskProfileMapping],
        stop: &AtomicBool,
    ) -> Result<Value> {
        if let Some(mut receipt) = self.restoration_receipt(archive)? {
            receipt["already_restored"] = json!(true);
            return Ok(receipt);
        }
        let group = self.prepare_task_group(archive, project, profiles, stop)?;
        let graph = group.graph.as_ref().ok_or(Error::NotFound)?;
        let tasks = group.nodes.iter().map(|n| {
            let m = graph.members.get(&n.source_id).map(|r|&r.member);
            json!({"task_id":n.source_id,"title":n.config.title,"state":n.state,"mode":n.config.mode,"goal":n.context.goal,"profile_id":n.profile.id,"model":n.profile.model,"protocol":n.profile.protocol,"base_url":n.profile.base_url,"parent_task_id":m.map(|m|&m.parent_task_id),"depends_on":m.map(|m|&m.depends_on),"review":m.map(|m|&m.review),"replaces_id":m.and_then(|m|m.replaces_id.as_ref()),"superseded_by":m.and_then(|m|m.superseded_by.as_ref()),"messages":n.messages.len(),"queued":n.messages.iter().filter(|m|matches!(m.state,MessageState::Queued|MessageState::SteerRequested)).count(),"has_report":m.is_some_and(|m|m.report.is_some()),"project_rules":n.config.project_rules,"recovery":n.history.recovery})
        }).collect::<Vec<_>>();
        Ok(
            json!({"already_restored":false,"fingerprint":group.fingerprint,"tasks":tasks,"settings":graph.settings,"project":group.nodes[0].project.as_ref().map(|p|&p.0),"file_history":file_history::summary(&group.nodes[0].index),"file_history_included":group.nodes[0].index.version>=3}),
        )
    }
    pub fn restore_task_group(
        &mut self,
        archive: &str,
        project: Option<&str>,
        profiles: &[TaskProfileMapping],
        fingerprint: &str,
        stop: &AtomicBool,
    ) -> Result<(Value, Vec<Event>)> {
        self.restore_task_group_with_media(archive, project, profiles, fingerprint, &[], stop)
    }
    pub fn restore_task_group_with_media(
        &mut self,
        archive: &str,
        project: Option<&str>,
        profiles: &[TaskProfileMapping],
        fingerprint: &str,
        media: &[TaskRestoreMedia],
        stop: &AtomicBool,
    ) -> Result<(Value, Vec<Event>)> {
        check_stop(stop)?;
        if let Some(mut receipt) = self.restoration_receipt(archive)? {
            receipt["duplicate"] = json!(true);
            return Ok((receipt, vec![]));
        }
        let mut group = self.prepare_task_group(archive, project, profiles, stop)?;
        group.fingerprint =
            self.restore_media_fingerprint(&group.nodes[0].index, &group.fingerprint, media)?;
        group.media = media.to_vec();
        if group.fingerprint != fingerprint {
            return Err(Error::Conflict);
        }
        self.commit_restored_group(archive, group, stop)
    }
}
