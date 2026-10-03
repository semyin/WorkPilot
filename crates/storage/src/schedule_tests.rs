use super::*;
use chrono::DateTime;
fn at(s: &str) -> u64 {
    DateTime::parse_from_rfc3339(s).unwrap().timestamp_millis() as u64
}
fn req(a: ScheduleAction) -> Request {
    Request {
        request_id: id(),
        command: Command::Schedules { action: a },
    }
}
fn spec(profile: &ProviderProfile) -> ScheduleSpec {
    ScheduleSpec {
        title: "日报".into(),
        goal: "Read project and report".into(),
        project_id: None,
        profile_id: profile.id.clone(),
        mode: WorkMode::Chat,
        permission: PermissionMode::RequestApproval,
        review_profile_id: None,
        commands_enabled: false,
        timezone: "Asia/Shanghai".into(),
        rule: ScheduleRule::Interval { minutes: 1 },
        enabled: true,
    }
}
fn save(s: &mut Store, v: ScheduleSpec, now: u64) -> String {
    let (ScheduleData::Updated { schedule_id }, _) = s
        .schedule_action(
            &req(ScheduleAction::Save {
                schedule_id: None,
                revision: 0,
                spec: v,
            }),
            now,
        )
        .unwrap()
    else {
        panic!()
    };
    schedule_id
}
#[test]
fn timezone_rules_skip_gap_choose_first_fold_and_preserve_wall_hour() {
    let rule = ScheduleRule::Daily {
        hour: 2,
        minute: 30,
    };
    let n = schedule_time::next(&rule, "America/New_York", at("2026-03-08T06:00:00Z"), 0)
        .unwrap()
        .unwrap();
    assert_eq!(n, at("2026-03-09T06:30:00Z"));
    let rule = ScheduleRule::Daily {
        hour: 1,
        minute: 30,
    };
    let first = schedule_time::next(&rule, "America/New_York", at("2026-11-01T04:00:00Z"), 0)
        .unwrap()
        .unwrap();
    assert_eq!(first, at("2026-11-01T05:30:00Z"));
    let next = schedule_time::next(&rule, "America/New_York", first, 0)
        .unwrap()
        .unwrap();
    assert_eq!(next, at("2026-11-02T06:30:00Z"));
    assert!(
        schedule_time::next(
            &ScheduleRule::Once {
                local: "2026-03-08T02:30".into()
            },
            "America/New_York",
            0,
            0
        )
        .is_err()
    );
    assert!(schedule_time::next(&rule, "Madeup/Timezone", first, 0).is_err());
    let weekly = ScheduleRule::Weekly {
        weekdays: vec![1, 5],
        hour: 9,
        minute: 0,
    };
    assert_eq!(
        schedule_time::next(&weekly, "Asia/Shanghai", at("2026-10-02T01:00:00Z"), 0).unwrap(),
        Some(at("2026-10-05T01:00:00Z"))
    );
}
#[test]
fn timer_claims_are_unique_overdue_is_coalesced_and_rollback_never_repeats() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let (_, profile) = super::execution_tests::setup(&mut s);
    let now = now_ms();
    let p = save(&mut s, spec(&profile), now);
    let due = s.schedule_plan(&p).unwrap().next_at_ms.unwrap();
    assert!(s.schedule_tick(due - 1, None).unwrap().0.is_empty());
    let (ids, _) = s.schedule_tick(due, None).unwrap();
    assert_eq!(ids.len(), 1);
    assert!(s.schedule_tick(due, None).unwrap().1.is_empty());
    assert!(s.schedule_tick(due - 50000, None).unwrap().1.is_empty());
    let (ids, _) = s.schedule_tick(due + 60000, None).unwrap();
    assert!(ids.is_empty());
    let (ScheduleData::History { items, .. }, _) = s
        .schedule_action(
            &req(ScheduleAction::History {
                schedule_id: p.clone(),
                before: None,
                limit: 10,
            }),
            now,
        )
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(items[0].state, "overlap");
    let jump = due + 60000 * 1000;
    s.schedule_tick(jump, Some("clock_jump_or_resume")).unwrap();
    let (ScheduleData::History { items, .. }, _) = s
        .schedule_action(
            &req(ScheduleAction::History {
                schedule_id: p.clone(),
                before: None,
                limit: 10,
            }),
            now,
        )
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(items.len(), 3);
    assert_eq!(items[0].state, "missed");
    assert_eq!(items[0].missed_count, Some(999));
    assert!(s.schedule_plan(&p).unwrap().next_at_ms.unwrap() > jump);
    assert!(s.schedule_tick(due, None).unwrap().1.is_empty());
}
#[test]
fn save_toggle_conflicts_and_retry_receipts_preserve_plans_and_old_occurrence_specs() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let (_, p) = super::execution_tests::setup(&mut s);
    let now = now_ms();
    let r = req(ScheduleAction::Save {
        schedule_id: None,
        revision: 0,
        spec: spec(&p),
    });
    let (ScheduleData::Updated { schedule_id: id }, _) = s.schedule_action(&r, now).unwrap() else {
        panic!()
    };
    assert!(s.schedule_action(&r, now).unwrap().1.is_empty());
    let run = req(ScheduleAction::RunNow {
        schedule_id: id.clone(),
        revision: 1,
    });
    let (ScheduleData::Run { occurrence }, _) = s.schedule_action(&run, now).unwrap() else {
        panic!()
    };
    assert!(s.schedule_action(&run, now).unwrap().1.is_empty());
    s.schedule_finish_dispatch(&occurrence.id, Some("synthetic failure"))
        .unwrap();
    s.schedule_action(
        &req(ScheduleAction::SetEnabled {
            schedule_id: id.clone(),
            revision: 1,
            enabled: false,
        }),
        now,
    )
    .unwrap();
    assert!(matches!(
        s.schedule_action(
            &req(ScheduleAction::Delete {
                schedule_id: id.clone(),
                revision: 1
            }),
            now
        ),
        Err(Error::Conflict)
    ));
    s.schedule_action(
        &req(ScheduleAction::Delete {
            schedule_id: id.clone(),
            revision: 2,
        }),
        now,
    )
    .unwrap();
    assert!(s.schedule_plan(&id).unwrap().deleted);
    s.collect_unreferenced_objects().unwrap();
    let old: SchedulePlan = s.read_json(&occurrence.plan).unwrap();
    assert!(old.spec.enabled);
    assert_eq!(old.revision, 1);
}
#[test]
fn re_open_marks_claimed_interrupted_and_past_due_missed_without_dispatch() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let (_, p) = super::execution_tests::setup(&mut s);
    let now = now_ms();
    let id = save(&mut s, spec(&p), now - 120000);
    let due = s.schedule_plan(&id).unwrap().next_at_ms.unwrap();
    let (claims, _) = s.schedule_tick(due, None).unwrap();
    assert_eq!(claims.len(), 1);
    drop(s);
    let mut s = Store::open(dir.path()).unwrap();
    assert_eq!(
        s.schedule_occurrence(&claims[0]).unwrap().state,
        "interrupted"
    );
    let (ScheduleData::History { items, .. }, _) = s
        .schedule_action(
            &req(ScheduleAction::History {
                schedule_id: id.clone(),
                before: None,
                limit: 10,
            }),
            now,
        )
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(items.len(), 2);
    assert_eq!(items[0].state, "missed");
    assert!(items.iter().all(|o| o.task_id.is_none()));
    assert!(s.schedule_plan(&id).unwrap().next_at_ms.unwrap() > now);
}
#[test]
fn changed_model_is_recorded_without_dispatch_and_manual_run_requires_current_bindings() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let (_, p) = super::execution_tests::setup(&mut s);
    let now = now_ms();
    let id = save(&mut s, spec(&p), now);
    let due = s.schedule_plan(&id).unwrap().next_at_ms.unwrap();
    s.connection
        .execute(
            "UPDATE provider_profiles SET data_json=json_set(data_json,'$.revision',5) WHERE id=?1",
            [&p.id],
        )
        .unwrap();
    let (claims, _) = s.schedule_tick(due, None).unwrap();
    assert!(claims.is_empty());
    let (ScheduleData::History { items, .. }, _) = s
        .schedule_action(
            &req(ScheduleAction::History {
                schedule_id: id.clone(),
                before: None,
                limit: 10,
            }),
            now,
        )
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(items[0].state, "failed");
    assert!(items[0].reason.as_ref().unwrap().contains("模型配置已变化"));
    assert!(
        s.schedule_action(
            &req(ScheduleAction::RunNow {
                schedule_id: id,
                revision: 1
            }),
            now
        )
        .is_err()
    );
}
#[test]
fn recovery_finds_task_created_before_link_and_human_resume_cannot_overlap() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let (template, p) = super::execution_tests::setup(&mut s);
    let now = now_ms();
    let id = save(&mut s, spec(&p), now);
    let (ScheduleData::Run { occurrence }, _) = s
        .schedule_action(
            &req(ScheduleAction::RunNow {
                schedule_id: id.clone(),
                revision: 1,
            }),
            now,
        )
        .unwrap()
    else {
        panic!()
    };
    let mut config = s.execution_snapshot(&template).unwrap().config;
    config.profile_id = Some(p.id.clone());
    let r = Request {
        request_id: format!("schedule-create-{}", occurrence.id),
        command: Command::CreateExecution {
            config: Box::new(config.clone()),
        },
    };
    let task = s
        .create_scheduled_execution(&r, &config, &occurrence.id)
        .unwrap()
        .0
        .task_id
        .unwrap();
    let authority: String = s
        .connection
        .query_row(
            "SELECT data_json FROM task_tool_settings WHERE task_id=?1",
            [&task],
            |r| r.get(0),
        )
        .unwrap();
    let settings: ToolSettings = serde_json::from_str(&authority).unwrap();
    assert_eq!(settings.permission, Some(PermissionMode::RequestApproval));
    drop(s);
    let mut s = Store::open(dir.path()).unwrap();
    let recovered = s.schedule_occurrence(&occurrence.id).unwrap();
    assert_eq!(recovered.task_id, Some(task.clone()));
    assert_eq!(s.task(&task).unwrap().state, TaskState::Interrupted);
    let (ScheduleData::Run { occurrence: second }, _) = s
        .schedule_action(
            &req(ScheduleAction::RunNow {
                schedule_id: id,
                revision: 1,
            }),
            now,
        )
        .unwrap()
    else {
        panic!()
    };
    assert!(s.schedule_can_start(&task, &p).is_err());
    s.schedule_finish_dispatch(&second.id, Some("synthetic failure"))
        .unwrap();
    s.schedule_can_start(&task, &p).unwrap();
}

#[test]
fn disabled_plans_never_fire_and_large_resume_batches_are_recorded_once() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let (_, p) = super::execution_tests::setup(&mut s);
    let now = now_ms();
    let mut disabled = spec(&p);
    disabled.enabled = false;
    let paused = save(&mut s, disabled, now);
    for _ in 0..17 {
        save(&mut s, spec(&p), now);
    }
    let resumed = now + 125000;
    let mut recorded = 0;
    loop {
        let (claimed, events) = s
            .schedule_tick(resumed, Some("clock_jump_or_resume"))
            .unwrap();
        assert!(claimed.is_empty());
        if events.is_empty() {
            break;
        }
        recorded += events.len();
    }
    assert_eq!(recorded, 17);
    assert!(s.schedule_tick(resumed, None).unwrap().1.is_empty());
    assert!(s.schedule_plan(&paused).unwrap().next_at_ms.is_none());
    assert_eq!(
        s.connection
            .query_row(
                "SELECT count(*) FROM schedule_occurrences WHERE state='missed' AND missed_count=2",
                [],
                |r| r.get::<_, u32>(0)
            )
            .unwrap(),
        17
    );
    let (ScheduleData::List { items, total }, _) = s
        .schedule_action(
            &req(ScheduleAction::List {
                include_deleted: true,
                offset: 16,
                limit: 16,
            }),
            now,
        )
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(total, 18);
    assert_eq!(items.len(), 2);
}

#[test]
fn finished_parent_does_not_hide_waiting_descendant_or_workbench_operation() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let (task, p) = super::execution_tests::setup(&mut s);
    let (child, _) = super::execution_tests::setup(&mut s);
    let now = now_ms();
    let plan = save(&mut s, spec(&p), now);
    let (ScheduleData::Run { occurrence }, _) = s
        .schedule_action(
            &req(ScheduleAction::RunNow {
                schedule_id: plan.clone(),
                revision: 1,
            }),
            now,
        )
        .unwrap()
    else {
        panic!()
    };
    s.schedule_attach(&occurrence.id, &task).unwrap();
    s.schedule_finish_dispatch(&occurrence.id, None).unwrap();
    s.connection
        .execute("UPDATE tasks SET state='completed' WHERE id=?1", [&task])
        .unwrap();
    s.connection.execute("INSERT INTO team_members(task_id,parent_task_id,root_task_id,member_key,data_json) VALUES(?1,?2,?2,'child','{}')", params![child,task]).unwrap();
    s.connection
        .execute(
            "UPDATE tasks SET state='awaiting_approval' WHERE id=?1",
            [&child],
        )
        .unwrap();
    assert!(s.schedule_active(&plan, None).unwrap());
    assert!(s.schedule_occurrence(&occurrence.id).unwrap().active);
    s.connection
        .execute("UPDATE tasks SET state='completed' WHERE id=?1", [&child])
        .unwrap();
    assert!(!s.schedule_active(&plan, None).unwrap());
    s.connection.execute("INSERT INTO workbench_operations(id,task_id,fingerprint,data_json) VALUES('scheduled-operation',?1,'fixture','{\"state\":\"running\"}')", [&child]).unwrap();
    assert!(s.schedule_active(&plan, None).unwrap());
    assert!(s.schedule_occurrence(&occurrence.id).unwrap().active);
}

#[test]
fn schema_ten_upgrade_preserves_memory_and_inert_legacy_schedule() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path()).unwrap();
    let request = Request {
        request_id: id(),
        command: Command::Memory {
            action: MemoryAction::Save {
                memory_id: None,
                revision: 0,
                project_id: None,
                text: "保留旧版已确认记忆".into(),
            },
        },
    };
    s.memory_action(&request).unwrap();
    let object = s.save_json(serde_json::json!({"legacy":true})).unwrap();
    s.connection.execute("INSERT INTO schedules(id,object_id,data_json) VALUES('legacy-plan',?1,'{\"legacy\":true}')", [&object.object_id]).unwrap();
    s.connection.execute_batch("DROP TABLE schedule_commands; DROP TABLE schedule_occurrences; DROP TABLE schedule_cursor; PRAGMA user_version=10;").unwrap();
    drop(s);
    let mut s = Store::open(dir.path()).unwrap();
    assert_eq!(s.memory_active(None, "", 64).unwrap().len(), 1);
    assert!(s.schedule_tick(now_ms(), None).unwrap().1.is_empty());
    assert_eq!(
        s.connection
            .query_row(
                "SELECT count(*) FROM schedules WHERE id='legacy-plan'",
                [],
                |r| r.get::<_, u32>(0)
            )
            .unwrap(),
        1
    );
    assert!(
        std::fs::read_dir(dir.path().join("backups"))
            .unwrap()
            .any(|v| v
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("before-v10-"))
    );
}
