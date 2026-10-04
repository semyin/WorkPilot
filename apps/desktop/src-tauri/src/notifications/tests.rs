use super::{model::*, persistence};
use std::fs;
use workpilot_contracts::{Event, EventSource, Payload, TaskState};

fn event(sequence: u64, state: TaskState) -> Event {
    Event {
        protocol: "workpilot.v1".into(),
        event_id: format!("event-{sequence}"),
        sequence,
        task_id: Some("task-one".into()),
        task_sequence: Some(sequence),
        agent_id: None,
        source: EventSource::Engine,
        at_ms: 1234,
        request_id: None,
        payload: Payload::TaskStateChanged {
            state,
            reason: Some("private API key and project text must not appear".into()),
        },
    }
}
#[test]
fn only_real_task_transitions_create_notices_without_content() {
    for state in [
        TaskState::Completed,
        TaskState::Failed,
        TaskState::AwaitingInput,
        TaskState::AwaitingApproval,
    ] {
        let notice = Notice::from_event(&event(1, state)).unwrap();
        let json = serde_json::to_string(&notice).unwrap();
        assert!(!json.contains("private"));
        assert!(!json.contains("reason"));
    }
    for state in [
        TaskState::Queued,
        TaskState::Running,
        TaskState::Stopping,
        TaskState::Interrupted,
    ] {
        assert!(Notice::from_event(&event(1, state)).is_none());
    }
    let mut restored = event(1, TaskState::Completed);
    restored.source = EventSource::Recovery;
    assert!(Notice::from_event(&restored).is_none());
    restored.source = EventSource::Engine;
    restored.payload = Payload::ToolApprovalRequested {
        approval_id: "approval-auto-allowed".into(),
        intent: workpilot_contracts::ContentRef {
            object_id: "secret".into(),
            bytes: 20,
            media_type: "application/json".into(),
        },
    };
    assert!(Notice::from_event(&restored).is_none());
}
#[test]
fn automatic_team_wait_is_silent_but_real_input_requirements_remain_visible() {
    let mut waiting = event(1, TaskState::AwaitingInput);
    waiting.payload = Payload::TaskStateChanged {
        state: TaskState::AwaitingInput,
        reason: Some("team_waiting".into()),
    };
    assert!(Notice::from_event(&waiting).is_none());
    for reason in [
        Some("awaiting_input"),
        Some("plan_confirmation"),
        Some("team_results_need_review"),
        Some("future_input_requirement"),
        None,
    ] {
        waiting.payload = Payload::TaskStateChanged {
            state: TaskState::AwaitingInput,
            reason: reason.map(str::to_owned),
        };
        assert_eq!(Notice::from_event(&waiting).unwrap().kind, Kind::Input);
    }
    waiting.payload = Payload::TaskStateChanged {
        state: TaskState::Failed,
        reason: Some("team_waiting".into()),
    };
    assert_eq!(Notice::from_event(&waiting).unwrap().kind, Kind::Failed);
}
#[test]
fn replay_poll_restart_and_out_of_order_delivery_do_not_duplicate() {
    let mut ledger = Ledger::default();
    ledger.floor = 10;
    assert!(!ledger.insert(Notice::from_event(&event(9, TaskState::Failed)).unwrap()));
    assert!(ledger.insert(Notice::from_event(&event(12, TaskState::Completed)).unwrap()));
    assert!(ledger.insert(Notice::from_event(&event(11, TaskState::Failed)).unwrap()));
    for _ in 0..100 {
        assert!(!ledger.insert(Notice::from_event(&event(12, TaskState::Completed)).unwrap()));
    }
    let persisted =
        serde_json::from_slice::<Saved>(&serde_json::to_vec(&ledger.saved).unwrap()).unwrap();
    let mut restarted = Ledger::default();
    restarted.saved = persisted;
    restarted.floor = 20;
    assert!(!restarted.insert(Notice::from_event(&event(12, TaskState::Completed)).unwrap()));
    assert_eq!(restarted.saved.unread(), 2);
    assert!(restarted.insert(Notice::from_event(&event(22, TaskState::Completed)).unwrap()));
}
#[test]
fn channel_preferences_focus_and_bursts_are_predictable() {
    let mut p = Preferences::default();
    assert!(p.in_app && p.system && p.tray && !p.foreground);
    assert_eq!(policy(&p, false, true, false), Delivery::Pending);
    assert_eq!(policy(&p, true, true, false), Delivery::Foreground);
    assert_eq!(policy(&p, false, false, false), Delivery::Startup);
    assert_eq!(policy(&p, false, true, true), Delivery::Batched);
    p.foreground = true;
    assert_eq!(policy(&p, true, true, false), Delivery::Pending);
    p.system = false;
    assert_eq!(policy(&p, false, true, false), Delivery::Off);
}
#[test]
fn inbox_is_bounded_and_keeps_state_when_system_delivery_fails() {
    let mut ledger = Ledger::default();
    for sequence in 1..=200 {
        let mut notice = Notice::from_event(&event(sequence, TaskState::AwaitingInput)).unwrap();
        notice.delivery = Delivery::Failed;
        ledger.insert(notice);
    }
    assert_eq!(ledger.saved.entries.len(), LIMIT);
    assert_eq!(ledger.saved.unread(), LIMIT);
    ledger.saved.entries[0].read = true;
    assert_eq!(ledger.saved.unread(), LIMIT - 1);
    assert!(ledger.saved.validate());
}
#[test]
fn notification_storage_roundtrips_and_refuses_invalid_records() {
    let root = tempfile::tempdir().unwrap();
    let dir = persistence::directory(&root.path().canonicalize().unwrap()).unwrap();
    let mut ledger = Ledger::default();
    ledger.insert(Notice::from_event(&event(1, TaskState::Failed)).unwrap());
    persistence::save(&dir, &ledger.saved).unwrap();
    ledger.saved.preferences.system = false;
    persistence::save(&dir, &ledger.saved).unwrap();
    let saved = persistence::load(&dir).unwrap();
    assert!(!saved.preferences.system);
    assert_eq!(saved.entries[0].task_id, "task-one");
    fs::write(dir.join("state.json"), br#"{"version":999}"#).unwrap();
    assert!(persistence::load(&dir).is_err());
    assert_eq!(
        fs::read(dir.join("state.json")).unwrap(),
        br#"{"version":999}"#
    );
}
#[cfg(windows)]
#[test]
fn readonly_notification_file_preserves_previous_settings() {
    use std::os::windows::fs::MetadataExt;
    let root = tempfile::tempdir().unwrap();
    let dir = persistence::directory(&root.path().canonicalize().unwrap()).unwrap();
    persistence::save(&dir, &Saved::default()).unwrap();
    let path = dir.join("state.json");
    let before = fs::read(&path).unwrap();
    let original = fs::metadata(&path).unwrap().permissions();
    let mut protected = original.clone();
    protected.set_readonly(true);
    fs::set_permissions(&path, protected).unwrap();
    let result = persistence::save(
        &dir,
        &Saved {
            preferences: Preferences {
                system: false,
                ..Default::default()
            },
            ..Default::default()
        },
    );
    let actual = fs::read(&path).unwrap();
    let attributes = fs::metadata(&path).unwrap().file_attributes();
    fs::set_permissions(&path, original).unwrap();
    assert!(result.is_err());
    assert_eq!(before, actual);
    assert_ne!(attributes & 1, 0);
}

#[test]
fn worker_replays_no_history_and_releases_data_lock_before_maintenance() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    fs::create_dir(&data).unwrap();
    let notify = super::Notifications::new();
    let mut ready = event(10, TaskState::Running);
    ready.payload = Payload::Ready {
        pid: 1,
        version: "test".into(),
        data_dir: data.to_string_lossy().into_owned(),
    };
    notify.event(&ready);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while !notify.snapshot().ready && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert!(notify.snapshot().ready);
    assert!(!notify.snapshot().storage_error);
    assert!(workpilot_platform::update::data_update_lock(&data, true).is_err());
    for _ in 0..3 {
        notify.event(&event(11, TaskState::Completed));
    }
    while notify.snapshot().entries.is_empty() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert_eq!(notify.snapshot().entries.len(), 1);
    notify.suspend();
    assert!(!notify.snapshot().active);
    assert!(workpilot_platform::update::data_update_lock(&data, true).is_ok());
    notify.event(&event(12, TaskState::Failed));
    assert!(
        !notify.snapshot().overflow,
        "normal shutdown is not queue overload"
    );
    let directory = data.join("desktop-notifications");
    assert_eq!(persistence::load(&directory).unwrap().entries.len(), 1);
    let next = super::Notifications::new();
    ready.sequence = 20;
    next.event(&ready);
    while !next.snapshot().ready && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert_eq!(next.snapshot().entries.len(), 1);
    assert!(next.snapshot().last_delivery.is_none());
    next.suspend();
}
