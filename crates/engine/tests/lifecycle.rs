use std::{
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Command, Stdio},
    sync::mpsc,
    time::Duration,
};
use workpilot_contracts::{
    Command as Action, Event, Payload, Query, Request, Response, TaskState, Wire,
};
use workpilot_platform::process::ManagedEngine;
struct Client {
    engine: ManagedEngine,
    receiver: mpsc::Receiver<Wire>,
}
impl Client {
    fn start(root: &Path) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_workpilot-engine"));
        command.args(["--channel", "test", "--data-root"]).arg(root);
        let mut engine = ManagedEngine::spawn(&mut command).unwrap();
        let output = engine.child.stdout.take().unwrap();
        let (tx, receiver) = mpsc::sync_channel(512);
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                if tx
                    .send(serde_json::from_str::<Wire>(&line.unwrap()).unwrap())
                    .is_err()
                {
                    break;
                }
            }
        });
        let client = Self { engine, receiver };
        client.until(|event| matches!(event.payload, Payload::Ready { .. }));
        client
    }
    fn send(&mut self, id: &str, command: Action) {
        let input = self.engine.child.stdin.as_mut().unwrap();
        serde_json::to_writer(
            &mut *input,
            &Request {
                request_id: id.into(),
                command,
            },
        )
        .unwrap();
        writeln!(input).unwrap();
        input.flush().unwrap();
    }
    fn next(&self) -> Wire {
        self.receiver.recv_timeout(Duration::from_secs(10)).unwrap()
    }
    fn until(&self, test: impl Fn(&Event) -> bool) -> Event {
        loop {
            if let Wire::Event { event } = self.next()
                && test(&event)
            {
                return *event;
            }
        }
    }
    fn reply(&self, id: &str) -> Response {
        loop {
            if let Wire::Reply {
                request_id,
                response,
            } = self.next()
                && request_id == id
            {
                return response;
            }
        }
    }
    fn query(&mut self, id: &str, query: Query) -> Response {
        self.send(id, Action::Read { query });
        self.reply(id)
    }
    fn quit(&mut self) {
        self.send("quit", Action::Shutdown);
        self.until(|e| matches!(e.payload, Payload::Bye));
        assert!(self.engine.child.wait().unwrap().success());
    }
}
#[test]
fn stream_cancel_and_shutdown_are_observable_and_persisted() {
    let root = tempfile::tempdir().unwrap();
    let mut client = Client::start(root.path());
    client.send(
        "start",
        Action::StartProbe {
            ticks: 100,
            interval_ms: 10,
        },
    );
    let started = client.until(|e| matches!(e.payload, Payload::ProbeStarted { .. }));
    assert!(started.task_id.is_some());
    client.until(|e| matches!(e.payload, Payload::Progress { .. }));
    let start = std::time::Instant::now();
    client.send("stop", Action::Stop);
    client.until(|e| matches!(&e.payload,Payload::ProbeEnded{reason} if reason=="interrupted"));
    assert!(start.elapsed() < Duration::from_secs(2));
    client.until(|e| matches!(e.payload, Payload::Pong));
    client.quit();
    let inspector = workpilot_storage::Inspector::open(&root.path().join("test")).unwrap();
    let page = inspector.events(0, None, 256).unwrap();
    assert!(
        page.events
            .windows(2)
            .all(|w| w[1].sequence == w[0].sequence + 1)
    );
    assert!(matches!(page.events.last().unwrap().payload, Payload::Bye));
}
#[test]
fn repeated_stop_request_cannot_stop_a_later_probe() {
    let root = tempfile::tempdir().unwrap();
    let mut client = Client::start(root.path());
    client.send(
        "first",
        Action::StartProbe {
            ticks: 100,
            interval_ms: 10,
        },
    );
    client.reply("first");
    client.send("stop-once", Action::Stop);
    client.reply("stop-once");
    client.send(
        "second",
        Action::StartProbe {
            ticks: 100,
            interval_ms: 10,
        },
    );
    client.reply("second");
    client.send("stop-once", Action::Stop);
    let Response::Receipt { receipt } = client.reply("stop-once") else {
        panic!()
    };
    assert!(receipt.duplicate);
    let event = client.until(|e| matches!(e.payload, Payload::Progress { .. }));
    assert_eq!(event.request_id.as_deref(), Some("second"));
    client.quit();
}
#[test]
fn kill_restart_replays_saved_events_and_does_not_restart_accepted_work() {
    let root = tempfile::tempdir().unwrap();
    let mut first = Client::start(root.path());
    first.send(
        "original",
        Action::StartProbe {
            ticks: 10_000,
            interval_ms: 10,
        },
    );
    let Response::Receipt { receipt } = first.reply("original") else {
        panic!()
    };
    let task = receipt.task_id.unwrap();
    let seen = first
        .until(|e| matches!(e.payload, Payload::Progress { .. }))
        .sequence;
    first.engine.terminate().unwrap();
    drop(first);
    let mut second = Client::start(root.path());
    let Response::Tasks { page } = second.query(
        "tasks",
        Query::Tasks {
            before: None,
            limit: 256,
        },
    ) else {
        panic!()
    };
    assert_eq!(page.tasks.len(), 1);
    assert_eq!(page.tasks[0].state, TaskState::Interrupted);
    let Response::Events { page } = second.query(
        "replay",
        Query::Events {
            after: seen,
            task_id: Some(task),
            limit: 256,
        },
    ) else {
        panic!()
    };
    assert!(page.events.iter().all(|e| e.sequence > seen));
    assert!(page.events.iter().any(|e| matches!(
        e.payload,
        Payload::TaskStateChanged {
            state: TaskState::Interrupted,
            ..
        }
    )));
    second.send(
        "original",
        Action::StartProbe {
            ticks: 10_000,
            interval_ms: 10,
        },
    );
    let Response::Receipt { receipt } = second.reply("original") else {
        panic!()
    };
    assert!(receipt.duplicate);
    second.quit();
}
#[test]
fn closing_parent_pipe_exits_without_restarting_work() {
    let root = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_workpilot-engine"))
        .args(["--channel", "test", "--data-root"])
        .arg(root.path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let start = std::time::Instant::now();
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        if start.elapsed() > Duration::from_secs(5) {
            let _ = child.kill();
            panic!("engine did not exit after EOF");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
