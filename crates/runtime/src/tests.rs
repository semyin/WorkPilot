use super::*;
use serde_json::Value;
use std::{collections::VecDeque, sync::Mutex};
type ScriptQueue = Arc<Mutex<VecDeque<(u64, Result<ModelOutput>)>>>;
#[derive(Clone)]
struct Script {
    steps: ScriptQueue,
    seen: Arc<Mutex<Vec<ModelInput>>>,
}
impl Script {
    fn new(outputs: Vec<ModelOutput>) -> Self {
        Self {
            steps: Arc::new(Mutex::new(
                outputs.into_iter().map(|o| (0, Ok(o))).collect(),
            )),
            seen: Arc::default(),
        }
    }
    fn count(&self) -> usize {
        self.seen.lock().unwrap().len()
    }
}
impl ModelBackend for Script {
    async fn execute(
        &self,
        _: ProviderProfile,
        input: ModelInput,
        _: Option<Secret>,
        cancel: CancellationToken,
        updates: mpsc::Sender<ModelUpdate>,
    ) -> Result<ModelOutput> {
        self.seen.lock().unwrap().push(input);
        let (delay, result) = self
            .steps
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected extra model request");
        if delay > 0 {
            updates
                .send(ModelUpdate::Text("partial response".into()))
                .await
                .unwrap();
            tokio::select! {_=cancel.cancelled()=>return Err(diagnostic::error(ModelErrorCode::Cancelled)),_=tokio::time::sleep(Duration::from_millis(delay))=>{}}
        }
        if let Ok(output) = &result
            && !output.text.is_empty()
        {
            let _ = updates.send(ModelUpdate::Text(output.text.clone())).await;
        }
        result
    }
}
fn uid() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn req(command: Command) -> Request {
    Request {
        request_id: uid(),
        command,
    }
}
fn output(text: &str, calls: Vec<(&str, Value)>) -> ModelOutput {
    let mut items = vec![
        json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":text}],"id":uid(),"status":"completed"}),
    ];
    let calls:Vec<_>=calls.into_iter().map(|(name,args)|{
        let call=ModelToolCall{id:uid(),name:name.into(),arguments:args,provider_item_id:Some(uid())};
        items.push(json!({"type":"function_call","id":call.provider_item_id,"call_id":call.id,"name":call.name,"arguments":call.arguments.to_string(),"status":"completed"}));call
    }).collect();
    ModelOutput {
        text: text.into(),
        finish_reason: if calls.is_empty() {
            "stop"
        } else {
            "tool_calls"
        }
        .into(),
        tool_calls: calls,
        continuation: ProviderContinuation {
            protocol: ProtocolKind::Responses,
            response_id: Some(uid()),
            items,
        },
        actual_model: Some("synthetic".into()),
        usage: Usage {
            input_tokens: Some(10),
            output_tokens: Some(8),
            cost_microunits: None,
            currency: None,
        },
        raw_usage: None,
    }
}
struct Harness {
    _root: tempfile::TempDir,
    storage: Storage,
    profile: ProviderProfile,
    task: String,
}
impl Harness {
    async fn new(mode: WorkMode, limits: ExecutionLimits) -> Self {
        let root = tempfile::tempdir().unwrap();
        let storage = Storage::open(root.path().to_owned()).await.unwrap();
        let mut profile = ProviderProfile::new(
            "test-profile".into(),
            ProtocolKind::Responses,
            "http://127.0.0.1:1".into(),
            "synthetic".into(),
        );
        profile.auth = AuthMode::None;
        profile.capabilities.tools = Capability {
            source: CapabilitySource::User,
            supported: Some(true),
            checked_at_ms: None,
        };
        let p = profile.clone();
        let task = storage
            .call(move |s| {
                s.commit_profile(
                    &req(Command::SaveProvider {
                        profile: Box::new(p.clone()),
                        secret: None,
                        clear_credential: false,
                    }),
                    p,
                )?;
                let config = ExecutionConfig {
                    title: "Runtime test".into(),
                    goal: "Preserve ORIGINAL_GOAL".into(),
                    constraints: vec!["Never lose CONSTRAINT".into()],
                    project_rules: "PROJECT_RULE".into(),
                    project_id: None,
                    profile_id: Some("test-profile".into()),
                    mode,
                    controlled_tools: true,
                    limits,
                };
                Ok(s.create_execution(
                    &req(Command::CreateExecution {
                        config: Box::new(config.clone()),
                    }),
                    &config,
                )?
                .0
                .task_id
                .unwrap())
            })
            .await
            .unwrap();
        Self {
            _root: root,
            storage,
            profile,
            task,
        }
    }
    async fn queue(&self) -> String {
        let (task, p) = (self.task.clone(), self.profile.clone());
        self.storage
            .call(move |s| {
                s.queue_execution(
                    &req(Command::StartExecution {
                        task_id: task.clone(),
                    }),
                    &task,
                    &p,
                )?;
                Ok(s.execution_snapshot(&task)?.latest_run.unwrap().run.id)
            })
            .await
            .unwrap()
    }
    async fn snapshot(&self) -> ExecutionSnapshot {
        let task = self.task.clone();
        self.storage
            .call(move |s| s.execution_snapshot(&task))
            .await
            .unwrap()
    }
    async fn message(&self, text: &str, steer: bool) -> String {
        let (task, text) = (self.task.clone(), text.to_owned());
        self.storage
            .call(move |s| {
                let (_, events) = s.apply(&req(Command::Enqueue {
                    task_id: task.clone(),
                    text,
                }))?;
                let id = events
                    .iter()
                    .find_map(|e| {
                        if let Payload::MessageQueued { message_id, .. } = &e.payload {
                            Some(message_id.clone())
                        } else {
                            None
                        }
                    })
                    .unwrap();
                if steer {
                    s.apply(&req(Command::Steer {
                        task_id: task,
                        message_id: id.clone(),
                    }))?;
                }
                Ok(id)
            })
            .await
            .unwrap()
    }
    async fn execute<F: FaultObserver + Send + 'static>(
        &self,
        backend: Script,
        fault: F,
    ) -> (
        tokio::task::JoinHandle<()>,
        Signals,
        tokio::task::JoinHandle<Vec<Event>>,
    ) {
        let run = self.queue().await;
        let (tx, mut rx) = mpsc::channel(32);
        let reader = tokio::spawn(async move {
            let mut events = vec![];
            while let Some(wire) = rx.recv().await {
                if let Wire::Event { event } = wire {
                    events.push(*event);
                }
            }
            events
        });
        let signals = Signals::default();
        let env = ExecutionEnvironment {
            reviewer: None,
            tool_ledger: self._root.path().join("tool-ledger"),
            storage: self.storage.clone(),
            events: tx,
            backend,
            run_id: run,
            profile: self.profile.clone(),
            secret: None,
            signals: signals.clone(),
            fault,
        };
        (tokio::spawn(env.execute()), signals, reader)
    }
}
async fn join(
    job: tokio::task::JoinHandle<()>,
    reader: tokio::task::JoinHandle<Vec<Event>>,
) -> Vec<Event> {
    tokio::time::timeout(Duration::from_secs(10), job)
        .await
        .unwrap()
        .unwrap();
    reader.await.unwrap()
}
async fn wait_seen(script: &Script, count: usize) {
    for _ in 0..200 {
        if script.count() >= count {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("model was not called");
}
#[tokio::test]
async fn one_runtime_drives_three_different_tool_combinations() {
    let scenarios = vec![
        vec![
            output("", vec![("sample_lookup", json!({"key":"numbers"}))]),
            output(
                "",
                vec![(
                    "sample_calculate",
                    json!({"operation":"sum","values":[4,8,12]}),
                )],
            ),
            output(
                "",
                vec![("sample_write", json!({"name":"sum","content":"24"}))],
            ),
            output("sum is 24", vec![]),
        ],
        vec![
            output("", vec![("sample_lookup", json!({"key":"words"}))]),
            output(
                "",
                vec![(
                    "sample_write",
                    json!({"name":"words","content":"alpha beta gamma"}),
                )],
            ),
            output("", vec![("sample_read", json!({"name":"words"}))]),
            output("words inspected", vec![]),
        ],
        vec![
            output(
                "",
                vec![(
                    "sample_calculate",
                    json!({"operation":"product","values":[4,8]}),
                )],
            ),
            output("", vec![("sample_wait", json!({"milliseconds":1}))]),
            output(
                "",
                vec![("sample_write", json!({"name":"product","content":"32"}))],
            ),
            output("product is 32", vec![]),
        ],
    ];
    for scenario in scenarios {
        let harness = Harness::new(WorkMode::Execute, ExecutionLimits::default()).await;
        let script = Script::new(scenario);
        let (job, _, reader) = harness.execute(script.clone(), NoFault).await;
        let events = join(job, reader).await;
        let snapshot = harness.snapshot().await;
        assert_eq!(snapshot.task.state, TaskState::Completed);
        assert_eq!(script.count(), 4);
        assert_eq!(
            snapshot
                .steps
                .iter()
                .filter(|s| s.kind == ExecutionStepKind::Tool
                    && s.state == ExecutionStepState::Completed)
                .count(),
            3
        );
        for input in script.seen.lock().unwrap().iter() {
            workpilot_providers::config::request_body(&harness.profile, input).unwrap();
        }
        assert!(
            events
                .iter()
                .all(|e| e.task_id.as_deref() == Some(&harness.task))
        );
        assert!(
            events
                .iter()
                .filter(|e| matches!(
                    e.payload,
                    Payload::ExecutionStarted { .. } | Payload::ToolStarted { .. }
                ))
                .all(|e| e.agent_id.is_some())
        );
    }
}
#[tokio::test]
async fn queue_is_delivered_after_current_answer_and_steer_cancels_old_model() {
    let harness = Harness::new(WorkMode::Execute, ExecutionLimits::default()).await;
    let script = Script::new(vec![
        output("old answer", vec![]),
        output("guided answer", vec![]),
        output("queued answer", vec![]),
    ]);
    script.steps.lock().unwrap()[0].0 = 3000;
    let (job, signals, reader) = harness.execute(script.clone(), NoFault).await;
    wait_seen(&script, 1).await;
    let queued = harness.message("NORMAL_QUEUE", false).await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(script.count(), 1);
    let guided = harness.message("USER_GUIDE", true).await;
    signals.steer.notify_one();
    let events = join(job, reader).await;
    let snapshot = harness.snapshot().await;
    assert_eq!(snapshot.task.state, TaskState::Completed);
    assert_eq!(script.count(), 3);
    let delivered: Vec<_> = events
        .iter()
        .filter_map(|e| {
            if let Payload::MessageDelivered { message_id, .. } = &e.payload {
                Some(message_id.as_str())
            } else {
                None
            }
        })
        .collect();
    assert_eq!(delivered, vec![guided.as_str(), queued.as_str()]);
    assert!(
        snapshot
            .steps
            .iter()
            .any(|s| s.state == ExecutionStepState::Cancelled)
    );
    let seen = script.seen.lock().unwrap();
    assert!(
        serde_json::to_string(&seen[1])
            .unwrap()
            .contains("USER_GUIDE")
    );
    assert!(
        !serde_json::to_string(&seen[1])
            .unwrap()
            .contains("NORMAL_QUEUE")
    );
    assert!(
        serde_json::to_string(&seen[2])
            .unwrap()
            .contains("NORMAL_QUEUE")
    );
}
#[derive(Clone)]
struct Gate {
    point: Boundary,
    entered: Arc<Notify>,
    release: Arc<Notify>,
    hit: Arc<std::sync::atomic::AtomicBool>,
}
impl Gate {
    fn new(point: Boundary) -> Self {
        Self {
            point,
            entered: Arc::default(),
            release: Arc::default(),
            hit: Arc::default(),
        }
    }
}
impl FaultObserver for Gate {
    async fn boundary(&self, point: Boundary) {
        if self.point == point && !self.hit.swap(true, std::sync::atomic::Ordering::SeqCst) {
            self.entered.notify_one();
            self.release.notified().await;
        }
    }
}
#[tokio::test]
async fn steering_between_preparation_and_start_skips_obsolete_actions() {
    let harness = Harness::new(WorkMode::Execute, ExecutionLimits::default()).await;
    let script = Script::new(vec![
        output(
            "",
            vec![(
                "sample_write",
                json!({"name":"obsolete","content":"must not happen"}),
            )],
        ),
        output("new direction handled", vec![]),
    ]);
    let gate = Gate::new(Boundary::BeforeTool);
    let (job, signals, reader) = harness.execute(script.clone(), gate.clone()).await;
    gate.entered.notified().await;
    harness.message("Do not save obsolete data", true).await;
    signals.steer.notify_one();
    gate.release.notify_one();
    join(job, reader).await;
    let snapshot = harness.snapshot().await;
    assert_eq!(snapshot.task.state, TaskState::Completed);
    assert!(
        snapshot
            .steps
            .iter()
            .any(|s| s.state == ExecutionStepState::Skipped)
    );
    let action = snapshot
        .steps
        .iter()
        .find(|s| s.kind == ExecutionStepKind::Tool)
        .unwrap()
        .id
        .clone();
    assert!(
        harness
            .storage
            .call(move |s| s.controlled_effect(&action))
            .await
            .unwrap()
            .is_none()
    );
}
#[tokio::test]
async fn stopping_at_three_tool_boundaries_requires_different_recovery() {
    for point in [
        Boundary::BeforeTool,
        Boundary::DuringTool,
        Boundary::AfterEffect,
    ] {
        let harness = Harness::new(WorkMode::Execute, ExecutionLimits::default()).await;
        let script = Script::new(vec![
            output(
                "",
                vec![(
                    "sample_write",
                    json!({"name":"once","content":"saved exactly once"}),
                )],
            ),
            output("recovered", vec![]),
        ]);
        let gate = Gate::new(point);
        let (job, signals, reader) = harness.execute(script.clone(), gate.clone()).await;
        gate.entered.notified().await;
        signals.stop.cancel();
        join(job, reader).await;
        let snapshot = harness.snapshot().await;
        assert_eq!(snapshot.task.state, TaskState::Interrupted);
        let action = snapshot.context.pending.as_ref().unwrap().action_ids[0].clone();
        if point == Boundary::DuringTool {
            let (job, _, reader) = harness.execute(script.clone(), NoFault).await;
            join(job, reader).await;
            assert_eq!(
                harness
                    .snapshot()
                    .await
                    .latest_run
                    .unwrap()
                    .reason
                    .as_deref(),
                Some("tool_result_needs_review")
            );
            assert_eq!(script.count(), 1);
            let (task, id) = (harness.task.clone(), action.clone());
            harness
                .storage
                .call(move |s| {
                    s.resolve_execution_action(
                        &req(Command::ResolveExecutionAction {
                            task_id: task.clone(),
                            action_id: id.clone(),
                            resolution: ActionResolution::NotApplied,
                        }),
                        &task,
                        &id,
                        &ActionResolution::NotApplied,
                    )
                })
                .await
                .unwrap();
        }
        let (job, _, reader) = harness.execute(script.clone(), NoFault).await;
        let events = join(job, reader).await;
        let final_state = harness.snapshot().await;
        assert_eq!(final_state.task.state, TaskState::Completed);
        assert_eq!(script.count(), 2);
        assert!(final_state.latest_run.unwrap().predecessor_id.is_some());
        assert!(
            harness
                .storage
                .call(move |s| s.controlled_effect(&action))
                .await
                .unwrap()
                .is_some()
        );
        if point == Boundary::AfterEffect {
            assert!(events.iter().any(
                |e| matches!(&e.payload,Payload::ActionReconciled{resolution_source,..} if resolution_source=="receipt")
            ));
        }
    }
}
#[tokio::test]
async fn model_failure_is_one_request_and_manual_continue_preserves_queue() {
    let harness = Harness::new(WorkMode::Execute, ExecutionLimits::default()).await;
    let script = Script::new(vec![]);
    script
        .steps
        .lock()
        .unwrap()
        .push_back((80, Err(diagnostic::error(ModelErrorCode::RateLimit))));
    let (job, _, reader) = harness.execute(script.clone(), NoFault).await;
    wait_seen(&script, 1).await;
    let message = harness.message("keep this queued", false).await;
    join(job, reader).await;
    let snapshot = harness.snapshot().await;
    assert_eq!(snapshot.task.state, TaskState::Failed);
    assert_eq!(script.count(), 1);
    assert!(
        snapshot
            .steps
            .iter()
            .any(|s| s.state == ExecutionStepState::Failed)
    );
    assert!(
        snapshot
            .messages
            .iter()
            .any(|m| m.id == message && m.state == MessageState::Queued)
    );
    script
        .steps
        .lock()
        .unwrap()
        .push_back((0, Ok(output("continued by user", vec![]))));
    let (job, _, reader) = harness.execute(script.clone(), NoFault).await;
    join(job, reader).await;
    assert_eq!(harness.snapshot().await.task.state, TaskState::Completed);
    assert_eq!(script.count(), 2);
}
#[tokio::test]
async fn chat_and_plan_cannot_write_and_plan_needs_explicit_mode_change() {
    for mode in [WorkMode::Chat, WorkMode::Plan] {
        assert!(
            tools::parse(
                &ModelToolCall {
                    id: "call".into(),
                    name: "sample_write".into(),
                    arguments: json!({"name":"x","content":"x"}),
                    provider_item_id: None
                },
                mode,
                true
            )
            .is_err()
        );
        assert!(
            !tools::definitions(mode, true)
                .iter()
                .any(|t| t.name == "sample_write")
        );
    }
    let harness = Harness::new(WorkMode::Plan, ExecutionLimits::default()).await;
    let script = Script::new(vec![
        output(
            "",
            vec![(
                "update_plan",
                json!({"steps":[{"id":"one","text":"save test value","status":"pending"}]}),
            )],
        ),
        output(
            "",
            vec![("sample_write", json!({"name":"plan","content":"approved"}))],
        ),
        output(
            "",
            vec![(
                "update_plan",
                json!({"steps":[{"id":"one","text":"save test value","status":"done"}]}),
            )],
        ),
        output("plan completed", vec![]),
    ]);
    let (job, _, reader) = harness.execute(script.clone(), NoFault).await;
    join(job, reader).await;
    let snap = harness.snapshot().await;
    assert_eq!(snap.task.state, TaskState::AwaitingInput);
    assert_eq!(script.count(), 1);
    let (task, limits) = (harness.task.clone(), ExecutionLimits::default());
    harness
        .storage
        .call(move |s| {
            s.configure_execution(
                &req(Command::ConfigureExecution {
                    task_id: task.clone(),
                    mode: WorkMode::Execute,
                    profile_id: Some("test-profile".into()),
                    limits: limits.clone(),
                }),
                &task,
                WorkMode::Execute,
                Some("test-profile"),
                &limits,
            )
        })
        .await
        .unwrap();
    let (job, _, reader) = harness.execute(script.clone(), NoFault).await;
    join(job, reader).await;
    assert_eq!(harness.snapshot().await.task.state, TaskState::Completed);
    assert_eq!(script.count(), 4);
}
#[tokio::test]
async fn ask_user_pauses_and_the_answer_enters_a_new_run() {
    let harness = Harness::new(WorkMode::Chat, ExecutionLimits::default()).await;
    let script = Script::new(vec![
        output(
            "",
            vec![(
                "ask_user",
                json!({"question":"Which color?","choices":["blue","red"]}),
            )],
        ),
        output("using blue", vec![]),
    ]);
    let (job, _, reader) = harness.execute(script.clone(), NoFault).await;
    join(job, reader).await;
    assert_eq!(
        harness.snapshot().await.task.state,
        TaskState::AwaitingInput
    );
    harness.message("blue", false).await;
    let (job, _, reader) = harness.execute(script.clone(), NoFault).await;
    join(job, reader).await;
    let snap = harness.snapshot().await;
    assert_eq!(snap.task.state, TaskState::Completed);
    assert!(snap.context.question.is_none());
    assert!(
        serde_json::to_string(&script.seen.lock().unwrap()[1])
            .unwrap()
            .contains("blue")
    );
}
#[tokio::test]
async fn context_compaction_keeps_pins_and_retrievable_tool_associations() {
    let limits = ExecutionLimits {
        context_bytes: 8192,
        max_steps: 64,
        ..ExecutionLimits::default()
    };
    let harness = Harness::new(WorkMode::Execute, limits).await;
    let mut outputs = vec![];
    for _ in 0..8 {
        outputs.push(output(
            &"long factual output ".repeat(80),
            vec![(
                "sample_calculate",
                json!({"operation":"sum","values":[1,2]}),
            )],
        ));
    }
    outputs.push(output("finished", vec![]));
    let script = Script::new(outputs);
    harness.message("PINNED_ADJUSTMENT", false).await;
    let (job, _, reader) = harness.execute(script.clone(), NoFault).await;
    let events = join(job, reader).await;
    let snap = harness.snapshot().await;
    assert_eq!(snap.task.state, TaskState::Completed);
    assert!(snap.context.digest.is_some());
    assert!(
        events
            .iter()
            .any(|e| matches!(e.payload, Payload::ContextCompacted { .. }))
    );
    for input in script.seen.lock().unwrap().iter() {
        let json = serde_json::to_string(input).unwrap();
        for required in [
            "ORIGINAL_GOAL",
            "CONSTRAINT",
            "PROJECT_RULE",
            "PINNED_ADJUSTMENT",
        ] {
            assert!(json.contains(required));
        }
        workpilot_providers::config::request_body(&harness.profile, input).unwrap();
    }
    let first = snap
        .steps
        .iter()
        .find(|s| s.kind == ExecutionStepKind::Tool)
        .unwrap()
        .id
        .clone();
    let run = snap.latest_run.unwrap().run.id;
    let result = harness
        .storage
        .call(move |s| {
            s.collect_unreferenced_objects()?;
            s.read_execution_step_result(&run, &first)
        })
        .await
        .unwrap();
    assert!(result["output"].as_str().unwrap().contains("3.0"));
}
#[tokio::test]
async fn step_and_time_limits_pause_without_fake_completion() {
    for time in [false, true] {
        let limits = if time {
            ExecutionLimits {
                max_duration_ms: 1000,
                ..ExecutionLimits::default()
            }
        } else {
            ExecutionLimits {
                max_steps: 1,
                ..ExecutionLimits::default()
            }
        };
        let harness = Harness::new(WorkMode::Execute, limits).await;
        let script = Script::new(vec![
            output("", vec![("sample_wait", json!({"milliseconds":2000}))]),
            output("unused", vec![]),
        ]);
        let (job, _, reader) = harness.execute(script.clone(), NoFault).await;
        join(job, reader).await;
        let snap = harness.snapshot().await;
        assert_eq!(snap.task.state, TaskState::Interrupted);
        assert_eq!(script.count(), 1);
        assert_eq!(
            snap.latest_run.unwrap().reason.as_deref(),
            Some(if time { "time_limit" } else { "step_limit" })
        );
    }
}
#[test]
fn controlled_tool_arguments_reject_unknown_keys_and_nonfinite_inputs() {
    let call = ModelToolCall {
        id: "x".into(),
        name: "sample_write".into(),
        arguments: json!({"name":"x","content":"y","path":"outside"}),
        provider_item_id: None,
    };
    assert!(tools::parse(&call, WorkMode::Execute, true).is_err());
    assert!(tools::parse(&call, WorkMode::Execute, false).is_err());
}
