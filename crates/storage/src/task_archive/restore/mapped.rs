use super::*;
use team::Group;

impl Store {
    fn prepare_mapped_group(
        &self,
        archive: &str,
        profiles: &[TaskProfileMapping],
        projects: &[TaskProjectMapping],
        history_roots: &[HistoryRootMapping],
        stop: &AtomicBool,
    ) -> Result<Group> {
        let bundle = self.export_saved_task_archive(archive, stop)?;
        let snapshot = validate_bundle(&bundle.index, &bundle.blobs)?;
        let mut destinations = BTreeMap::new();
        for m in projects {
            if destinations
                .insert(m.source_project_id.clone(), m.project_id.clone())
                .is_some()
            {
                return Err(Error::Invalid("duplicate project mapping"));
            }
        }
        let required = snapshot.tables["tasks"]
            .iter()
            .map(|t| serde_json::from_value::<Option<String>>(t["project_id"].clone()))
            .collect::<std::result::Result<std::collections::BTreeSet<_>, _>>()?;
        if destinations
            .keys()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>()
            != required
        {
            return Err(Error::Invalid(
                "请为每个原项目明确选择目标 / Map every source project explicitly",
            ));
        }
        let roots = bundle
            .index
            .file_history
            .iter()
            .map(|h| h.root_identity.clone())
            .collect::<std::collections::BTreeSet<_>>();
        let mut mapped_roots = BTreeMap::new();
        let mut root_projects = vec![];
        for m in history_roots {
            let p = self
                .task_restore_target(Some(&m.project_id))?
                .ok_or(Error::NotFound)?;
            let root =
                p.1.as_ref()
                    .ok_or(Error::Invalid("target project has no folder"))?;
            if !roots.contains(&m.source_root)
                || mapped_roots
                    .insert(m.source_root.clone(), root.clone())
                    .is_some()
            {
                return Err(Error::Invalid(
                    "duplicate or foreign history folder mapping",
                ));
            }
            root_projects.push(p);
        }
        if mapped_roots.len() != roots.len() {
            return Err(Error::Invalid(
                "请映射所有历史文件夹 / Map every historical folder",
            ));
        }
        let mut seen = HashSet::new();
        if profiles.len() != bundle.index.tasks.len()
            || profiles.iter().any(|p| {
                !seen.insert(&p.task_id) || !bundle.index.tasks.iter().any(|t| t.id == p.task_id)
            })
        {
            return Err(Error::Invalid("select one model for every task"));
        }
        let mut nodes = vec![];
        for t in &bundle.index.tasks {
            let source = snapshot.tables["tasks"]
                .iter()
                .find(|r| r["id"] == t.id)
                .ok_or(Error::NotFound)?;
            let source_project: Option<String> =
                serde_json::from_value(source["project_id"].clone())?;
            let project = destinations.get(&source_project).ok_or(Error::NotFound)?;
            let profile = profiles
                .iter()
                .find(|p| p.task_id == t.id)
                .ok_or(Error::NotFound)?;
            nodes.push(self.prepare_archive_task(
                &bundle.index,
                &snapshot,
                profile,
                project.as_deref(),
                Some(&mapped_roots),
                stop,
            )?);
        }
        let graph = if nodes.len() > 1 {
            Some(self.restoration_graph(&bundle.index, &snapshot, &nodes)?)
        } else {
            if !snapshot.tables["team_members"].is_empty()
                || snapshot.tables["agents"].len() != 1
                || snapshot.tables["execution_sessions"].len() != 1
            {
                return Err(Error::Invalid("invalid single task identity"));
            }
            None
        };
        let fingerprint = digest(&serde_json::to_vec(&json!([
            "mapped_restore_v1",
            nodes.iter().map(|n| &n.fingerprint).collect::<Vec<_>>(),
            root_projects,
            mapped_roots
        ]))?);
        Ok(Group {
            nodes,
            graph,
            fingerprint,
            media: vec![],
        })
    }
    pub fn mapped_task_restore_preview(
        &self,
        archive: &str,
        profiles: &[TaskProfileMapping],
        projects: &[TaskProjectMapping],
        history_roots: &[HistoryRootMapping],
        stop: &AtomicBool,
    ) -> Result<Value> {
        if let Some(mut r) = self.restoration_receipt(archive)? {
            r["already_restored"] = json!(true);
            return Ok(r);
        }
        let group = self.prepare_mapped_group(archive, profiles, projects, history_roots, stop)?;
        Ok(
            json!({"already_restored":false,"fingerprint":group.fingerprint,
            "tasks":group.nodes.iter().map(|n|json!({
                "task_id":n.source_id,"title":n.config.title,"state":n.state,"mode":n.config.mode,
                "model":n.profile.model,"profile_id":n.profile.id,"protocol":n.profile.protocol,
                "base_url":n.profile.base_url,"project":n.project.as_ref().map(|p|&p.0),
                "messages":n.messages.len(),"recovery":n.history.recovery,
                "project_rules":n.config.project_rules
            })).collect::<Vec<_>>(),
            "history_roots":history_roots,
            "file_history":file_history::summary(&group.nodes[0].index),
            "file_history_included":group.nodes[0].index.version>=3}),
        )
    }
    #[allow(clippy::too_many_arguments)]
    pub fn restore_mapped_task_group(
        &mut self,
        archive: &str,
        profiles: &[TaskProfileMapping],
        projects: &[TaskProjectMapping],
        history_roots: &[HistoryRootMapping],
        fingerprint: &str,
        media: &[TaskRestoreMedia],
        stop: &AtomicBool,
    ) -> Result<(Value, Vec<Event>)> {
        check_stop(stop)?;
        if let Some(mut r) = self.restoration_receipt(archive)? {
            r["duplicate"] = json!(true);
            return Ok((r, vec![]));
        }
        let mut group =
            self.prepare_mapped_group(archive, profiles, projects, history_roots, stop)?;
        group.fingerprint =
            self.restore_media_fingerprint(&group.nodes[0].index, &group.fingerprint, media)?;
        if group.fingerprint != fingerprint {
            return Err(Error::Conflict);
        }
        group.media = media.to_vec();
        self.commit_restored_group(archive, group, stop)
    }
}
