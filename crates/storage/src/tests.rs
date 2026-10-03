use super::*;
use std::{
    io::{BufReader, Read},
    time::{Duration, Instant},
};
fn request(name: &str, command: Command) -> Request {
    Request {
        request_id: name.into(),
        command,
    }
}
fn create(store: &mut Store, name: &str) -> String {
    store
        .apply(&request(
            name,
            Command::CreateTask {
                title: "A saved task".into(),
                project_id: None,
            },
        ))
        .unwrap()
        .0
        .task_id
        .unwrap()
}
fn page(store: &Store, after: u64, task: Option<&str>, limit: u32) -> EventPage {
    match store
        .query(&Query::Events {
            after,
            task_id: task.map(str::to_owned),
            limit,
        })
        .unwrap()
    {
        Response::Events { page } => page,
        _ => unreachable!(),
    }
}

#[test]
fn commands_deduplicate_by_id_without_swallowing_different_requests() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path()).unwrap();
    let req = request(
        "same",
        Command::CreateTask {
            title: "Same text".into(),
            project_id: None,
        },
    );
    let (first, events) = store.apply(&req).unwrap();
    assert!(!first.duplicate);
    assert!(matches!(events[0].payload, Payload::CommandAccepted { .. }));
    assert!(matches!(
        events.last().unwrap().payload,
        Payload::CommandFinished {
            status: CommandStatus::Completed
        }
    ));
    let (again, events) = store.apply(&req).unwrap();
    assert!(again.duplicate && events.is_empty());
    assert_eq!(again.task_id, first.task_id);
    let another = store
        .apply(&request("different", req.command.clone()))
        .unwrap()
        .0;
    assert_ne!(another.task_id, first.task_id);
    assert!(matches!(
        store.apply(&request("same", Command::Ping)),
        Err(Error::Conflict)
    ));
    drop(store);
    let mut reopened = Store::open(root.path()).unwrap();
    assert!(reopened.apply(&req).unwrap().0.duplicate);
}

#[test]
fn acceptance_does_not_mean_completion_and_crash_does_not_replay() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path()).unwrap();
    let req = request(
        "probe",
        Command::StartProbe {
            ticks: 10,
            interval_ms: 10,
        },
    );
    let (receipt, events) = store.apply(&req).unwrap();
    assert_eq!(receipt.status, CommandStatus::Accepted);
    assert!(
        !events
            .iter()
            .any(|e| matches!(e.payload, Payload::CommandFinished { .. }))
    );
    let task = receipt.task_id.unwrap();
    drop(store);
    let mut reopened = Store::open(root.path()).unwrap();
    assert_eq!(reopened.task(&task).unwrap().state, TaskState::Interrupted);
    let (retry, events) = reopened.apply(&req).unwrap();
    assert_eq!(retry.status, CommandStatus::Interrupted);
    assert!(retry.duplicate && events.is_empty());
    assert!(reopened.running_run(&task).is_err());
}

#[test]
#[ignore = "subprocess helper for abrupt crash injection"]
fn crash_child() {
    let root = std::env::var_os("WORKPILOT_P01_CRASH_TEST_ROOT").expect("test subprocess only");
    let mut store = Store::open(Path::new(&root)).unwrap();
    let receipt = store
        .apply(&request(
            "crash",
            Command::StartProbe {
                ticks: 10,
                interval_ms: 10,
            },
        ))
        .unwrap()
        .0;
    let task = receipt.task_id.unwrap();
    let uncertain = store
        .apply(&request(
            "tool-task",
            Command::StartProbe {
                ticks: 10,
                interval_ms: 10,
            },
        ))
        .unwrap()
        .0
        .task_id
        .unwrap();
    let input = store.text("synthetic tool input").unwrap();
    store
        .start_tool(&ToolCall {
            id: "uncertain-tool".into(),
            task_id: uncertain.clone(),
            run_id: store.running_run(&uncertain).unwrap(),
            agent_id: None,
            name: "synthetic".into(),
            state: ToolState::Started,
            input,
            output: None,
            approval_id: None,
            started_at_ms: now_ms(),
            ended_at_ms: None,
        })
        .unwrap();
    // Actual process termination: no Rust destructors, SQLite rollback or cleanup run.
    store
        .finish_probe_inner(&task, "crash", true, || std::process::exit(86))
        .unwrap();
    panic!("crash hook did not terminate");
}

#[test]
fn abrupt_death_between_state_and_event_writes_rolls_back_and_marks_tool_uncertain() {
    let root = tempfile::tempdir().unwrap();
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "tests::crash_child", "--nocapture"])
        .env("WORKPILOT_P01_CRASH_TEST_ROOT", root.path())
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(86));
    let mut store = Store::open(root.path()).unwrap();
    let task: String = store
        .connection
        .query_row(
            "SELECT task_id FROM commands WHERE request_id='crash'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let uncertain: String = store
        .connection
        .query_row(
            "SELECT task_id FROM commands WHERE request_id='tool-task'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(store.task(&task).unwrap().state, TaskState::Interrupted);
    let events = page(&store, 0, None, 256).events;
    assert!(events.iter().any(|e|matches!(&e.payload,Payload::ToolNeedsReview{tool_call_id} if tool_call_id=="uncertain-tool")));
    assert!(
        !events
            .iter()
            .any(|e| matches!(&e.payload,Payload::ProbeEnded{reason} if reason=="completed"))
    );
    let run: (String, Option<String>) = store
        .connection
        .query_row(
            "SELECT state,result_object_id FROM runs WHERE task_id=?1",
            [&task],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(run, ("interrupted".into(), None));
    assert!(matches!(
        store.apply(&request(
            "delete",
            Command::DeleteTask { task_id: uncertain }
        )),
        Err(Error::Conflict)
    ));
    let count = page(&store, 0, None, 256).events.len();
    drop(store);
    assert_eq!(
        page(&Store::open(root.path()).unwrap(), 0, None, 256)
            .events
            .len(),
        count
    );
}

#[test]
fn queue_steer_and_cancel_survive_restart_without_delivery() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path()).unwrap();
    let task = create(&mut store, "task");
    let (_, events) = store
        .apply(&request(
            "queue1",
            Command::Enqueue {
                task_id: task.clone(),
                text: "first".into(),
            },
        ))
        .unwrap();
    let message = events
        .iter()
        .find_map(|e| {
            if let Payload::MessageQueued { message_id, .. } = &e.payload {
                Some(message_id.clone())
            } else {
                None
            }
        })
        .unwrap();
    store
        .apply(&request(
            "queue2",
            Command::Enqueue {
                task_id: task.clone(),
                text: "second".into(),
            },
        ))
        .unwrap();
    store
        .apply(&request(
            "steer",
            Command::Steer {
                task_id: task.clone(),
                message_id: message,
            },
        ))
        .unwrap();
    store
        .apply(&request(
            "cancel",
            Command::Cancel {
                task_id: task.clone(),
            },
        ))
        .unwrap();
    drop(store);
    let store = Store::open(root.path()).unwrap();
    let mut stmt = store
        .connection
        .prepare("SELECT state,queue_position FROM messages ORDER BY queue_position")
        .unwrap();
    let messages: Vec<(String, u64)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    assert_eq!(
        messages,
        vec![("steer_requested".into(), 1), ("queued".into(), 2)]
    );
    assert_eq!(store.task(&task).unwrap().state, TaskState::Interrupted);
}

#[test]
fn replay_resumes_mid_sequence_including_after_deletion_gaps() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path()).unwrap();
    let a = create(&mut store, "a");
    let b = create(&mut store, "b");
    for i in 0..301 {
        store
            .append(
                Some(&a),
                None,
                Payload::Progress {
                    current: i,
                    total: 301,
                },
            )
            .unwrap();
    }
    store
        .apply(&request("delete", Command::DeleteTask { task_id: b }))
        .unwrap();
    let expected = page(&store, 0, Some(&a), 3);
    let mut after = expected.next_after;
    let mut actual = expected.events;
    loop {
        let p = page(&store, after, Some(&a), 7);
        assert!(p.events.iter().all(|e| e.sequence > after));
        after = p.next_after;
        actual.extend(p.events);
        if !p.has_more {
            break;
        }
    }
    assert_eq!(actual.len(), 304);
    assert!(
        actual
            .windows(2)
            .all(|w| w[0].task_sequence.unwrap() + 1 == w[1].task_sequence.unwrap())
    );
    assert_eq!(page(&store, after, Some(&a), 7).events.len(), 0);
}

#[test]
fn task_deletion_and_gc_protect_project_files_and_keep_retry_tombstones() {
    let root = tempfile::tempdir().unwrap();
    let project_dir = tempfile::tempdir().unwrap();
    let file = project_dir.path().join("important.txt");
    std::fs::write(&file, b"user source stays untouched").unwrap();
    let mut store = Store::open(root.path()).unwrap();
    store
        .save_project(&Project {
            id: "project".into(),
            name: "My folder".into(),
            root_path: project_dir.path().display().to_string(),
            default_profile_id: None,
            permission: PermissionMode::RequestApproval,
            created_at_ms: now_ms(),
        })
        .unwrap();
    let req = request(
        "create",
        Command::CreateTask {
            title: "Work".into(),
            project_id: Some("project".into()),
        },
    );
    let task = store.apply(&req).unwrap().0.task_id.unwrap();
    store
        .apply(&request(
            "message",
            Command::Enqueue {
                task_id: task.clone(),
                text: "remove this task data only".into(),
            },
        ))
        .unwrap();
    store
        .connection
        .execute(
            "INSERT INTO artifacts(id,task_id,path) VALUES('artifact',?1,?2)",
            params![task, file.display().to_string()],
        )
        .unwrap();
    store
        .apply(&request(
            "delete",
            Command::DeleteTask {
                task_id: task.clone(),
            },
        ))
        .unwrap();
    assert!(store.collect_unreferenced_objects().unwrap() > 0);
    assert_eq!(std::fs::read(file).unwrap(), b"user source stays untouched");
    assert!(matches!(store.task(&task), Err(Error::NotFound)));
    assert!(store.apply(&req).unwrap().0.duplicate);
    assert!(matches!(store.task(&task), Err(Error::NotFound)));
}

#[test]
fn registered_credentials_and_auth_fields_are_redacted_before_any_plaintext_write() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path()).unwrap();
    let secret = "synthetic-model-key-should-never-be-saved";
    store.register_secret(secret).unwrap();
    let task = store
        .apply(&request(
            "redacted",
            Command::CreateTask {
                title: format!("Task {secret}"),
                project_id: None,
            },
        ))
        .unwrap()
        .0
        .task_id
        .unwrap();
    store.apply(&request("message",Command::Enqueue{task_id:task.clone(),text:format!("plain {secret}\nAuthorization: Bearer second-unknown-token\napi_key=third-unknown-token")})).unwrap();
    store
        .save_profile(&ProviderProfile {
            id: "profile".into(),
            label: format!("Label {secret}"),
            protocol: ProtocolKind::Responses,
            base_url: "https://example.com/v1".into(),
            model: "synthetic".into(),
            credential: Some(CredentialRef {
                id: "opaque-reference".into(),
            }),
            supports_tools: None,
            supports_images: None,
            revision: 1,
            auth: AuthMode::Auto,
            capabilities: ModelCapabilities::default(),
            options: ModelOptions::default(),
            pricing: None,
        })
        .unwrap();
    store
        .append(
            Some(&task),
            None,
            Payload::Error {
                code: ErrorCode::Internal,
                message: format!("request failed: {secret}"),
            },
        )
        .unwrap();
    let mut exported = vec![];
    store.export_events(&mut exported, None).unwrap();
    assert!(!String::from_utf8(exported).unwrap().contains(secret));
    drop(store);
    fn scan(path: &Path, needles: &[&str]) {
        for entry in std::fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                scan(&path, needles);
            } else {
                let bytes = std::fs::read(path).unwrap();
                for needle in needles {
                    assert!(!bytes.windows(needle.len()).any(|w| w == needle.as_bytes()));
                }
            }
        }
    }
    scan(
        root.path(),
        &[secret, "second-unknown-token", "third-unknown-token"],
    );
}

#[test]
fn failed_migration_keeps_working_database_and_independent_preupgrade_backup() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path()).unwrap();
    let task = create(&mut store, "before-upgrade");
    let error = migrate(
        &mut store.connection,
        &store.directory,
        &[
            (1, include_str!("../migrations/001_initial.sql")),
            (2, include_str!("../migrations/002_providers.sql")),
            (3, include_str!("../migrations/003_execution.sql")),
            (4, include_str!("../migrations/004_tools.sql")),
            (5, include_str!("../migrations/005_teams.sql")),
            (6, include_str!("../migrations/006_workspace.sql")),
            (7, include_str!("../migrations/007_workbench.sql")),
            (
                SCHEMA_VERSION + 1,
                "UPDATE tasks SET title='corrupted'; CREATE TABLE halfway(id INTEGER); INSERT INTO missing_table VALUES(1);",
            ),
        ],
    );
    assert!(error.is_err());
    assert_eq!(store.task(&task).unwrap().title, "A saved task");
    let version: u32 = store
        .connection
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, SCHEMA_VERSION);
    let backup = std::fs::read_dir(root.path().join("backups"))
        .unwrap()
        .map(|r| r.unwrap().path())
        .find(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(&format!("before-v{SCHEMA_VERSION}-"))
        })
        .unwrap();
    let backup_conn = Connection::open(&backup).unwrap();
    let saved: String = backup_conn
        .query_row("SELECT title FROM tasks WHERE id=?1", [&task], |r| r.get(0))
        .unwrap();
    assert_eq!(saved, "A saved task");
    drop(backup_conn);
    // Restore a COPY into a fresh directory and prove it remains usable.
    let restored = tempfile::tempdir().unwrap();
    std::fs::copy(backup, restored.path().join("workpilot.sqlite3")).unwrap();
    assert_eq!(
        Store::open(restored.path())
            .unwrap()
            .task(&task)
            .unwrap()
            .title,
        saved
    );
}

#[test]
fn second_writer_and_newer_database_are_rejected_without_overwriting() {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path()).unwrap();
    assert!(matches!(Store::open(root.path()), Err(Error::Busy)));
    store
        .connection
        .pragma_update(None, "user_version", 999)
        .unwrap();
    drop(store);
    assert!(matches!(
        Store::open(root.path()),
        Err(Error::UnsupportedVersion)
    ));
    let connection = Connection::open(root.path().join("workpilot.sqlite3")).unwrap();
    assert_eq!(
        connection
            .query_row("PRAGMA user_version", [], |r| r.get::<_, u32>(0))
            .unwrap(),
        999
    );
}

/// Reader generates 32 MiB without allocating a 32 MiB input.
struct GeneratedText {
    left: usize,
}
impl Read for GeneratedText {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let n = buffer.len().min(self.left);
        buffer[..n].fill(b'x');
        for i in (0..n).step_by(1024) {
            buffer[i] = b'\n';
        }
        self.left -= n;
        Ok(n)
    }
}
#[test]
fn large_output_streams_to_disk_and_content_pages_handle_unicode() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path()).unwrap();
    let large = store
        .save_text(&mut BufReader::new(GeneratedText {
            left: 32 * 1024 * 1024,
        }))
        .unwrap();
    assert_eq!(large.bytes, 32 * 1024 * 1024);
    objects::verify(&store.directory, &large).unwrap();
    let unicode = store.text("你好，WorkPilot").unwrap();
    let mut offset = 0;
    let mut text = String::new();
    while offset < unicode.bytes {
        let Response::Content { page } = store
            .query(&Query::Content {
                object_id: unicode.object_id.clone(),
                offset,
                limit: 1,
            })
            .unwrap()
        else {
            panic!()
        };
        assert!(page.next_offset > offset);
        offset = page.next_offset;
        text.push_str(&page.text);
    }
    assert_eq!(text, "你好，WorkPilot");
    assert!(matches!(
        store.text(&"x".repeat(65_537)),
        Err(Error::Invalid(_))
    ));
    assert!(
        store
            .query(&Query::Content {
                object_id: "../../escape".into(),
                offset: 0,
                limit: 64
            })
            .is_err()
    );
}

#[test]
fn missing_or_modified_object_fails_reference_check_before_gc() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path()).unwrap();
    let task = create(&mut store, "a");
    let content = store.text("retained content").unwrap();
    store
        .append(
            Some(&task),
            None,
            Payload::TextDelta {
                content: content.clone(),
            },
        )
        .unwrap();
    assert_eq!(store.collect_unreferenced_objects().unwrap(), 0);
    std::fs::write(
        objects::object_path(&store.directory, &content.object_id).unwrap(),
        b"tampered",
    )
    .unwrap();
    assert!(matches!(
        store.collect_unreferenced_objects(),
        Err(Error::Corrupt(_))
    ));
}

#[test]
fn shared_memory_reference_survives_task_deletion_and_gc() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path()).unwrap();
    let task = create(&mut store, "memory-origin");
    let content = store.text("confirmed synthetic preference").unwrap();
    let memory = Memory {
        id: "retained-memory".into(),
        project_id: None,
        source_task_id: Some(task.clone()),
        content: content.clone(),
        state: MemoryState::Confirmed,
        confirmed_at_ms: Some(now_ms()),
    };
    store
        .connection
        .execute(
            "INSERT INTO memories(id,source_task_id,object_id,data_json) VALUES(?1,?2,?3,?4)",
            params![memory.id, task, content.object_id, encode(&memory).unwrap()],
        )
        .unwrap();
    store
        .apply(&request(
            "delete-memory-origin",
            Command::DeleteTask { task_id: task },
        ))
        .unwrap();
    assert_eq!(store.collect_unreferenced_objects().unwrap(), 0);
    objects::verify(&store.directory, &content).unwrap();
    let source: Option<String> = store
        .connection
        .query_row("SELECT source_task_id FROM memories", [], |r| r.get(0))
        .unwrap();
    assert!(source.is_none());
}

#[test]
fn unfinished_tool_prevents_success_and_resolved_tool_has_a_result() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path()).unwrap();
    let task = store
        .apply(&request(
            "start-with-tool",
            Command::StartProbe {
                ticks: 1,
                interval_ms: 1,
            },
        ))
        .unwrap()
        .0
        .task_id
        .unwrap();
    let input = store.text("input").unwrap();
    store
        .start_tool(&ToolCall {
            id: "tool-completion".into(),
            task_id: task.clone(),
            run_id: store.running_run(&task).unwrap(),
            agent_id: None,
            name: "fixture".into(),
            state: ToolState::Started,
            input,
            output: None,
            approval_id: None,
            started_at_ms: now_ms(),
            ended_at_ms: None,
        })
        .unwrap();
    assert!(matches!(
        store.finish_probe(&task, "start-with-tool", true),
        Err(Error::Conflict)
    ));
    assert_eq!(store.task(&task).unwrap().state, TaskState::Running);
    let output = store.text("actual synthetic result").unwrap();
    store
        .finish_tool("tool-completion", ToolState::Succeeded, &output)
        .unwrap();
    assert!(matches!(
        store.finish_tool("tool-completion", ToolState::Succeeded, &output),
        Err(Error::Conflict)
    ));
    store.finish_probe(&task, "start-with-tool", true).unwrap();
    assert_eq!(store.task(&task).unwrap().state, TaskState::Completed);
}

#[tokio::test(flavor = "current_thread")]
async fn blocking_database_work_does_not_block_async_stop_or_heartbeat() {
    let root = tempfile::tempdir().unwrap();
    let storage = Storage::open(root.path().to_path_buf()).await.unwrap();
    let cloned = storage.clone();
    let (started, ready) = tokio::sync::oneshot::channel();
    let work = tokio::spawn(async move {
        cloned
            .call(move |_| {
                let _ = started.send(());
                std::thread::sleep(Duration::from_millis(350));
                Ok(())
            })
            .await
    });
    ready.await.unwrap();
    let started = Instant::now();
    // Same single async thread remains available while DB worker is blocked.
    tokio::time::sleep(Duration::from_millis(15)).await;
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_millis(200),
        "async executor stalled: {elapsed:?}"
    );
    work.await.unwrap().unwrap();
    println!(
        "p01_async_heartbeat_ms={:.2}, worker_queue_capacity={}",
        elapsed.as_secs_f64() * 1000.0,
        WORK_QUEUE_CAPACITY
    );
}

#[test]
fn one_hundred_thousand_events_use_bounded_pages_and_export() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path()).unwrap();
    let task = create(&mut store, "volume");
    let started = Instant::now();
    // 100 events per transaction, as expected for future batched model/tool chunks.
    // No full-history vector is created on the producer or reader.
    for batch in 0..1000 {
        let tx = store.connection.transaction().unwrap();
        for item in 0..100 {
            record(
                &tx,
                &store.redactor,
                Some(&task),
                None,
                EventSource::Engine,
                Payload::Progress {
                    current: batch * 100 + item,
                    total: 100_000,
                },
            )
            .unwrap();
        }
        tx.commit().unwrap();
    }
    let mut after = 0;
    let mut total = 0;
    let mut largest = 0;
    loop {
        let p = page(&store, after, Some(&task), 256);
        total += p.events.len();
        largest = largest.max(p.events.len());
        after = p.next_after;
        if !p.has_more {
            break;
        }
    }
    assert_eq!(total, 100_003);
    assert_eq!(largest, 256);
    assert_eq!(
        store
            .export_events(&mut std::io::sink(), Some(&task))
            .unwrap(),
        total as u64
    );
    let cache: i64 = store
        .connection
        .query_row("PRAGMA cache_size", [], |r| r.get(0))
        .unwrap();
    assert_eq!(cache, -4096);
    let max_payload: u64 = store
        .connection
        .query_row("SELECT MAX(length(payload_json)) FROM events", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(max_payload < 1024);
    println!(
        "p01_events={total}, max_page={largest}, db_cache_kib=4096, elapsed_ms={:.2}, db_bytes={}",
        started.elapsed().as_secs_f64() * 1000.0,
        std::fs::metadata(root.path().join("workpilot.sqlite3"))
            .unwrap()
            .len()
    );
}
