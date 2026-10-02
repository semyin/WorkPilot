use super::execution_tests::{queue, setup};
use super::*;
fn req(command: Command) -> Request {
    Request {
        request_id: id(),
        command,
    }
}
fn team(s: &mut Store) -> (String, ProviderProfile) {
    let (t, p) = setup(s);
    let settings = TeamSettings::default();
    s.configure_team(
        &req(Command::ConfigureTeam {
            task_id: t.clone(),
            settings: settings.clone(),
        }),
        &t,
        &settings,
    )
    .unwrap();
    (t, p)
}
fn spec(key: &str, deps: &[&str]) -> MemberSpec {
    MemberSpec {
        key: key.into(),
        role: key.into(),
        goal: format!("Work {key}"),
        profile_id: None,
        depends_on: deps.iter().map(|s| s.to_string()).collect(),
    }
}
fn add(s: &mut Store, t: &str, specs: &[MemberSpec]) -> Vec<TeamMember> {
    s.delegate_members(t, specs, None, None, None).unwrap();
    s.direct_members(t).unwrap()
}
fn finish(s: &mut Store, t: &str, p: &ProviderProfile, state: TaskState) {
    let r = queue(s, t, p);
    s.activate_execution(&r).unwrap();
    s.finish_execution(&r, state, "test", None).unwrap();
    s.team_publish_reports().unwrap();
}

#[test]
fn team_batch_dependency_validation_dedup_and_override_are_atomic() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let (t, p) = team(&mut s);
    assert!(
        s.delegate_members(
            &t,
            &[spec("a", &["b"]), spec("b", &["a"])],
            None,
            None,
            None
        )
        .is_err()
    );
    assert!(s.direct_members(&t).unwrap().is_empty());
    let members = vec![spec("a", &[]), spec("b", &["a"])];
    let request = req(Command::AddTeamMembers {
        task_id: t.clone(),
        members: members.clone(),
    });
    s.delegate_members(&t, &members, None, None, Some(&request))
        .unwrap();
    s.delegate_members(&t, &members, None, None, Some(&request))
        .unwrap();
    assert!(s.cached_receipt(&request).unwrap().unwrap().duplicate);
    let rows = s.direct_members(&t).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1].depends_on, vec![rows[0].task_id.clone()]);
    let mut v = spec("a", &[]);
    v.goal = "changed assignment".into();
    let request = req(Command::OverrideTeamMember {
        task_id: t.clone(),
        member_id: rows[0].task_id.clone(),
        spec: v.clone(),
    });
    s.override_member(&t, &rows[0].task_id, &v, Some(&request))
        .unwrap();
    assert_eq!(
        s.execution_snapshot(&rows[0].task_id).unwrap().config.goal,
        v.goal
    );
    s.team_set_enabled(&t, true, false).unwrap();
    assert_eq!(
        s.team_schedule_candidates().unwrap(),
        vec![rows[0].task_id.clone()]
    );
    finish(&mut s, &rows[0].task_id, &p, TaskState::Completed);
    assert!(
        s.team_schedule_candidates()
            .unwrap()
            .contains(&rows[1].task_id)
    );
    let tasks = s.execution_tasks(64).unwrap();
    assert_eq!(tasks.len(), 1);
    let Response::Tasks { page } = s
        .query(&Query::Tasks {
            before: None,
            limit: 64,
        })
        .unwrap()
    else {
        panic!("task page")
    };
    assert_eq!(page.tasks.len(), 1);
    assert!(
        s.apply(&req(Command::DeleteTask {
            task_id: rows[0].task_id.clone()
        }))
        .is_err()
    );
    assert!(s.apply(&req(Command::DeleteTask { task_id: t })).is_err());
}
#[test]
fn replacement_preserves_failure_redirects_future_edges_and_enforces_limits() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let (t, p) = team(&mut s);
    let rows = add(&mut s, &t, &[spec("a", &[]), spec("b", &["a"])]);
    finish(&mut s, &rows[0].task_id, &p, TaskState::Failed);
    let (v, _) = s
        .replace_member(&t, &rows[0].task_id, None, "new attempt", None, None)
        .unwrap();
    let new = v["members"][0]["task_id"].as_str().unwrap().to_owned();
    assert_eq!(
        s.team_member(&rows[1].task_id).unwrap().depends_on,
        vec![new.clone()]
    );
    let all = add(&mut s, &t, &[spec("c", &["a"])]);
    assert_eq!(all.last().unwrap().depends_on, vec![new.clone()]);
    assert_eq!(s.task(&rows[0].task_id).unwrap().state, TaskState::Failed);
    assert!(
        s.execution_snapshot(&new)
            .unwrap()
            .context
            .goal
            .contains("Previous delivery")
    );
    finish(&mut s, &new, &p, TaskState::Failed);
    let (v, _) = s
        .replace_member(&t, &new, None, "last attempt", None, None)
        .unwrap();
    let last = v["members"][0]["task_id"].as_str().unwrap();
    finish(&mut s, last, &p, TaskState::Failed);
    assert!(
        s.replace_member(&t, last, None, "over limit", None, None)
            .is_err()
    );
}
#[test]
fn member_permissions_never_exceed_parent_or_creation_ceiling() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let (t, _) = team(&mut s);
    let settings = ToolSettings {
        root_path: Some("C:/synthetic".into()),
        permission: Some(PermissionMode::RequestApproval),
        commands_enabled: false,
        ..Default::default()
    };
    let r = req(Command::ConfigureTaskTools {
        task_id: t.clone(),
        settings: settings.clone(),
    });
    s.configure_task_tools(&r, &t, &settings, Some("folder".into()))
        .unwrap();
    let m = add(&mut s, &t, &[spec("a", &[])])[0].clone();
    let before = s.tool_settings(&m.task_id).unwrap();
    let mut expanded = settings.clone();
    expanded.permission = Some(PermissionMode::FullAccess);
    expanded.commands_enabled = true;
    expanded.revision = 1;
    let r = req(Command::ConfigureTaskTools {
        task_id: t.clone(),
        settings: expanded.clone(),
    });
    s.configure_task_tools(&r, &t, &expanded, Some("folder".into()))
        .unwrap();
    let current = s.tool_settings(&m.task_id).unwrap();
    assert_eq!(
        current.effective_permission,
        PermissionMode::RequestApproval
    );
    assert!(!current.settings.commands_enabled);
    assert_ne!(before.epoch, current.epoch);
    let r = req(Command::ConfigureTaskTools {
        task_id: m.task_id.clone(),
        settings: expanded.clone(),
    });
    assert!(
        s.configure_task_tools(&r, &m.task_id, &expanded, Some("folder".into()))
            .is_err()
    );
    expanded.revision = 2;
    expanded.root_path = Some("C:/different".into());
    let r = req(Command::ConfigureTaskTools {
        task_id: t.clone(),
        settings: expanded.clone(),
    });
    s.configure_task_tools(&r, &t, &expanded, Some("other-folder".into()))
        .unwrap();
    assert!(
        s.tool_settings(&m.task_id)
            .unwrap()
            .settings
            .root_path
            .is_none()
    );
}
#[test]
fn exact_report_review_ownership_and_gc_protect_deliveries() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let (t, p) = team(&mut s);
    let (other, _) = team(&mut s);
    let m = add(&mut s, &t, &[spec("a", &[])])[0].clone();
    finish(&mut s, &m.task_id, &p, TaskState::Completed);
    let report = s.team_member(&m.task_id).unwrap().report.unwrap();
    assert!(!s.team_complete(&t).unwrap());
    assert!(s.inspect_member(&other, &m.task_id, None).is_err());
    assert!(
        s.review_member(
            &t,
            &m.task_id,
            &report.object_id,
            true,
            "not inspected",
            None
        )
        .is_err()
    );
    s.inspect_member(&t, &m.task_id, None).unwrap();
    assert!(
        s.review_member(&t, &m.task_id, "wrong-version", true, "wrong", None)
            .is_err()
    );
    s.review_member(&t, &m.task_id, &report.object_id, true, "checked", None)
        .unwrap();
    assert!(s.team_complete(&t).unwrap());
    s.collect_unreferenced_objects().unwrap();
    let delivery: AgentReport = s.read_json(&report).unwrap();
    assert_eq!(delivery.task_id, m.task_id);
    assert_eq!(delivery.usage.input_tokens, None);
}
#[test]
fn stop_and_reopen_disable_entire_tree_without_requeueing_completed_members() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let (t, p) = team(&mut s);
    let ms = add(&mut s, &t, &[spec("a", &[]), spec("b", &[])]);
    s.team_set_enabled(&t, true, true).unwrap();
    finish(&mut s, &ms[0].task_id, &p, TaskState::Completed);
    let run = queue(&mut s, &ms[1].task_id, &p);
    s.activate_execution(&run).unwrap();
    s.cancel_execution(&req(Command::Cancel { task_id: t.clone() }), &t)
        .unwrap();
    assert!(!s.team_enabled(&ms[1].task_id).unwrap());
    assert!(s.team_schedule_candidates().unwrap().is_empty());
    drop(s);
    let mut s = Store::open(dir.path()).unwrap();
    assert!(!s.team_enabled(&t).unwrap());
    s.team_set_enabled(&t, true, true).unwrap();
    assert_eq!(s.task(&ms[0].task_id).unwrap().state, TaskState::Completed);
    assert!(
        s.team_schedule_candidates()
            .unwrap()
            .contains(&ms[1].task_id)
    );
    assert!(
        !s.team_schedule_candidates()
            .unwrap()
            .contains(&ms[0].task_id)
    );
}
#[test]
fn team_size_and_depth_limits_prevent_unbounded_delegation() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let (t, _) = team(&mut s);
    let settings = TeamSettings {
        max_members: 2,
        max_depth: 1,
        revision: 1,
        ..Default::default()
    };
    let r = req(Command::ConfigureTeam {
        task_id: t.clone(),
        settings: settings.clone(),
    });
    s.configure_team(&r, &t, &settings).unwrap();
    let m = add(&mut s, &t, &[spec("a", &[]), spec("b", &[])]);
    assert!(
        s.delegate_members(&t, &[spec("c", &[])], None, None, None)
            .is_err()
    );
    assert!(
        s.delegate_members(&m[0].task_id, &[spec("deep", &[])], None, None, None)
            .is_err()
    );
}
