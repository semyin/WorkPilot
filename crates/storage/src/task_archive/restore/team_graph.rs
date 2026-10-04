use super::*;

pub(super) struct MemberRecord {
    pub member: TeamMember,
    pub report: Option<AgentReport>,
}
pub(super) struct Graph {
    pub settings: TeamSettings,
    pub members: BTreeMap<String, MemberRecord>,
}
fn invalid() -> Error {
    Error::Invalid(
        "助手关系或交付记录不完整，请重新备份 / Inconsistent assistant relationships or reports; create a new archive",
    )
}

impl Store {
    pub(super) fn restoration_graph(
        &self,
        index: &TaskArchiveIndex,
        snapshot: &TaskArchiveSnapshot,
        nodes: &[Prepared],
    ) -> Result<Graph> {
        let rows = &snapshot.tables;
        let root = &index.root_task_id;
        let get = |id: &str| nodes.iter().find(|p| p.source_id == id).ok_or_else(invalid);
        if rows["team_members"].len() + 1 != nodes.len() {
            return Err(invalid());
        }
        let settings = if rows["team_settings"].is_empty() {
            TeamSettings {
                enabled: !get(root)?.config.controlled_tools,
                ..Default::default()
            }
        } else if rows["team_settings"].len() == 1 && rows["team_settings"][0]["task_id"] == *root {
            serde_json::from_value::<TeamSettings>(rows["team_settings"][0]["data_json"].clone())?
        } else {
            return Err(invalid());
        };
        settings.validate().map_err(Error::Invalid)?;
        let mut members = BTreeMap::new();
        let mut names = HashSet::new();
        for row in &rows["team_members"] {
            let task = row["task_id"].as_str().ok_or_else(invalid)?;
            let node = get(task)?;
            let mut m: TeamMember = serde_json::from_value(row["data_json"].clone())?;
            let declared = index
                .tasks
                .iter()
                .find(|t| t.id == task)
                .ok_or_else(invalid)?;
            if m.task_id != task
                || row["root_task_id"] != *root
                || m.root_task_id != *root
                || row["parent_task_id"] != m.parent_task_id
                || declared.parent_task_id.as_deref() != Some(&m.parent_task_id)
                || m.agent_id != node.source_agent.id
                || row["member_key"] != m.key
                || node.source_agent.parent_id.as_deref()
                    != Some(&get(&m.parent_task_id)?.source_agent.id)
                || !names.insert((m.parent_task_id.clone(), m.key.clone()))
                || m.attempt > 5
            {
                return Err(invalid());
            }
            MemberSpec {
                key: m.key.clone(),
                role: m.role.clone(),
                goal: m.goal.clone(),
                profile_id: None,
                depends_on: vec![],
            }
            .validate()
            .map_err(Error::Invalid)?;
            let mut parent = m.parent_task_id.as_str();
            let mut depth = 1;
            while parent != root {
                parent = index
                    .tasks
                    .iter()
                    .find(|t| t.id == parent)
                    .and_then(|t| t.parent_task_id.as_deref())
                    .ok_or_else(invalid)?;
                depth += 1;
                if depth > 3 {
                    return Err(invalid());
                }
            }
            if depth != m.depth {
                return Err(invalid());
            }
            m.state = node.state;
            m.profile_id = node.profile.id.clone();
            m.pending_start = false;
            m.review = row["review"].as_str().ok_or_else(invalid)?.into();
            m.review_reason = serde_json::from_value(row["review_reason"].clone())?;
            m.superseded_by = serde_json::from_value(row["superseded_by"].clone())?;
            m.depends_on = rows["team_dependencies"]
                .iter()
                .filter(|r| r["member_id"] == task)
                .map(|r| {
                    r["dependency_id"]
                        .as_str()
                        .map(str::to_owned)
                        .ok_or_else(invalid)
                })
                .collect::<Result<_>>()?;
            if !["pending", "accepted", "abandoned"].contains(&m.review.as_str())
                || (m.review == "accepted" && m.state != TaskState::Completed)
                || m.depends_on.len() > 32
            {
                return Err(invalid());
            }
            m.report = if row["report_object_id"].is_null() {
                None
            } else {
                Some(serde_json::from_value(row["report_object_id"].clone())?)
            };
            let report = m
                .report
                .as_ref()
                .map(|r| -> Result<AgentReport> {
                    if !index.objects.contains(r) {
                        return Err(invalid());
                    }
                    let report: AgentReport = self.read_json(r)?;
                    if report.task_id != task
                        || report.agent_id != m.agent_id
                        || report.state != declared.state
                    {
                        return Err(invalid());
                    }
                    for step in &report.steps {
                        if let Some(output) = &step.output
                            && node.history.results.get(&step.id) != Some(output)
                        {
                            return Err(invalid());
                        }
                    }
                    if report
                        .result
                        .as_ref()
                        .is_some_and(|r| !index.objects.contains(r))
                        || report
                            .artifacts
                            .iter()
                            .any(|a| !index.objects.contains(&a.content))
                    {
                        return Err(invalid());
                    }
                    Ok(report)
                })
                .transpose()?;
            if m.review == "accepted" && report.is_none() {
                return Err(invalid());
            }
            if matches!(m.state, TaskState::Completed | TaskState::Failed) && report.is_none() {
                return Err(invalid());
            }
            m.diagnostic = report
                .as_ref()
                .and_then(|r| r.diagnostic.clone())
                .or(m.diagnostic);
            if members
                .insert(task.to_owned(), MemberRecord { member: m, report })
                .is_some()
            {
                return Err(invalid());
            }
        }
        if rows["team_dependencies"]
            .iter()
            .any(|r| !members.contains_key(r["member_id"].as_str().unwrap_or_default()))
        {
            return Err(invalid());
        }
        for (task, record) in &members {
            let m = &record.member;
            let mut seen = HashSet::new();
            for dep in &m.depends_on {
                if dep == task
                    || !seen.insert(dep)
                    || members.get(dep).is_none_or(|d| {
                        d.member.parent_task_id != m.parent_task_id
                            || d.member.superseded_by.is_some()
                    })
                {
                    return Err(invalid());
                }
            }
            if let Some(next) = &m.superseded_by {
                let replacement = &members.get(next).ok_or_else(invalid)?.member;
                if replacement.parent_task_id != m.parent_task_id
                    || replacement.replaces_id.as_ref() != Some(task)
                    || replacement.attempt != m.attempt + 1
                {
                    return Err(invalid());
                }
            }
            if let Some(old) = &m.replaces_id {
                let replaced = &members.get(old).ok_or_else(invalid)?.member;
                if replaced.superseded_by.as_ref() != Some(task)
                    || replaced.parent_task_id != m.parent_task_id
                    || m.attempt != replaced.attempt + 1
                    || node_replacement_agent(nodes, task).as_deref()
                        != Some(&get(old)?.source_agent.id)
                {
                    return Err(invalid());
                }
            } else if m.attempt != 0 || get(task)?.source_agent.replaces_id.is_some() {
                return Err(invalid());
            }
        }
        fn visit(
            id: &str,
            members: &BTreeMap<String, MemberRecord>,
            stack: &mut HashSet<String>,
            done: &mut HashSet<String>,
        ) -> Result<()> {
            if done.contains(id) {
                return Ok(());
            }
            if !stack.insert(id.into()) {
                return Err(invalid());
            }
            for dep in &members.get(id).ok_or_else(invalid)?.member.depends_on {
                visit(dep, members, stack, done)?;
            }
            stack.remove(id);
            done.insert(id.into());
            Ok(())
        }
        let mut done = HashSet::new();
        for id in members.keys() {
            visit(id, &members, &mut HashSet::new(), &mut done)?;
        }
        Ok(Graph { settings, members })
    }
}
fn node_replacement_agent(nodes: &[Prepared], task: &str) -> Option<String> {
    nodes
        .iter()
        .find(|p| p.source_id == task)
        .and_then(|p| p.source_agent.replaces_id.clone())
}
