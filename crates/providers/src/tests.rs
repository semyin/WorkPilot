use super::*;
use serde_json::json;
use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
};
const KEY: &str = "workpilot-synthetic-key-only";
struct Fixture {
    child: Child,
    url: String,
}
impl Fixture {
    fn start() -> Self {
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../services/provider-fixtures/server.mjs");
        let mut child = Command::new("node")
            .arg(script)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let value: Value = serde_json::from_str(&line).unwrap();
        Self {
            child,
            url: value["url"].as_str().unwrap().into(),
        }
    }
    async fn records(&self) -> Vec<Value> {
        reqwest::get(format!("{}/stats", self.url))
            .await
            .unwrap()
            .json()
            .await
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn profile(protocol: ProtocolKind, url: &str, model: &str) -> ProviderProfile {
    ProviderProfile::new("service".into(), protocol, url.into(), model.into())
}
fn input(tools: bool) -> ModelInput {
    ModelInput {
        messages: vec![ModelMessage {
            role: "user".into(),
            content: vec![ModelContent::Text {
                text: "测试中文".into(),
            }],
        }],
        tools: if tools {
            vec![ToolDefinition {
                name: "workpilot_echo".into(),
                description: "Synthetic".into(),
                parameters: json!({"type":"object","properties":{"message":{"type":"string"}},"required":["message"]}),
            }]
        } else {
            vec![]
        },
        tool_results: vec![],
        continuation: None,
        capability_probe: Some(if tools {
            ModelProbeMode::Tools
        } else {
            ModelProbeMode::Text
        }),
    }
}
async fn run(p: ProviderProfile, i: ModelInput, token: CancellationToken) -> Result<ModelOutput> {
    let backend = HttpBackend::new().unwrap();
    let (tx, mut rx) = mpsc::channel(32);
    let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
    let result = backend
        .execute(p, i, Some(Secret::new(KEY.into()).unwrap()), token, tx)
        .await;
    drain.await.unwrap();
    result
}
const PROTOCOLS: [ProtocolKind; 3] = [
    ProtocolKind::ChatCompletions,
    ProtocolKind::Responses,
    ProtocolKind::Messages,
];

#[tokio::test]
async fn real_http_three_protocols_text_tools_continuation_and_auth() {
    let fixture = Fixture::start();
    for protocol in PROTOCOLS {
        let mut p = profile(protocol, &fixture.url, "fixture-text");
        p.pricing = Some(ModelPricing {
            currency: "USD".into(),
            input_microunits_per_million: 1_000_000,
            output_microunits_per_million: 2_000_000,
        });
        let output = run(p.clone(), input(false), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(output.text, "你好，WorkPilot");
        assert_eq!(output.usage.input_tokens, Some(12));
        assert_eq!(output.usage.output_tokens, Some(7));
        assert_eq!(output.usage.cost_microunits, Some(26));
        let mut tools = input(true);
        let output = run(p.clone(), tools.clone(), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(output.tool_calls.len(), 1);
        assert_eq!(
            output.tool_calls[0].arguments,
            json!({"message":"你好 WorkPilot"})
        );
        tools.tool_results.push(ModelToolResult {
            call_id: output.tool_calls[0].id.clone(),
            output: "SYNTHETIC_TOOL_RESULT".into(),
            is_error: false,
        });
        tools.continuation = Some(output.continuation);
        let result = run(p, tools, CancellationToken::new()).await.unwrap();
        assert_eq!(result.text, "工具结果已收到");
        assert!(result.tool_calls.is_empty());
    }
    let records = fixture.records().await;
    assert_eq!(records.len(), 9);
    assert!(records.iter().all(|r| r["authValid"] == true
        && r["versionValid"] == true
        && r["streaming"] == true
        && r["correlation"] == true
        && r["opaquePreserved"] == true));
}
#[tokio::test]
async fn every_failure_makes_one_request_and_never_redirects_or_falls_back() {
    let fixture = Fixture::start();
    let cases = [
        ("fixture-401", ModelErrorCode::Authentication),
        ("fixture-403", ModelErrorCode::Permission),
        ("fixture-429", ModelErrorCode::RateLimit),
        ("fixture-500", ModelErrorCode::Server),
        ("fixture-503", ModelErrorCode::Server),
        ("fixture-streamerror", ModelErrorCode::Server),
        ("fixture-cut", ModelErrorCode::Incomplete),
        ("fixture-cut-text", ModelErrorCode::Incomplete),
        ("fixture-cut-tools", ModelErrorCode::Incomplete),
        ("fixture-length", ModelErrorCode::Incomplete),
        ("fixture-malformed", ModelErrorCode::MalformedStream),
        ("fixture-badargs", ModelErrorCode::MalformedStream),
        ("fixture-redirect", ModelErrorCode::Server),
    ];
    let mut count = 0;
    for protocol in PROTOCOLS {
        for (model, expected) in cases {
            let e = run(
                profile(protocol, &fixture.url, model),
                input(model.contains("badargs") || model.contains("cut-tools")),
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
            assert_eq!(e.code, expected, "{protocol:?} {model}");
            assert!(!e.retryable);
            assert!(!serde_json::to_string(&e).unwrap().contains(KEY));
            count += 1;
            assert_eq!(fixture.records().await.len(), count);
        }
    }
}
#[tokio::test]
async fn timeout_cancel_drop_connections_without_extra_requests() {
    let fixture = Fixture::start();
    for protocol in PROTOCOLS {
        let mut p = profile(protocol, &fixture.url, "fixture-slow");
        p.options.timeout_ms = 500;
        p.options.idle_timeout_ms = 100;
        assert_eq!(
            run(p.clone(), input(false), CancellationToken::new())
                .await
                .unwrap_err()
                .code,
            ModelErrorCode::Timeout
        );
        p.options.timeout_ms = 3000;
        p.options.idle_timeout_ms = 3000;
        let token = CancellationToken::new();
        let cancel = token.clone();
        let future = tokio::spawn(run(p, input(false), token));
        tokio::time::sleep(Duration::from_millis(100)).await;
        cancel.cancel();
        assert_eq!(
            future.await.unwrap().unwrap_err().code,
            ModelErrorCode::Cancelled
        );
        let mut deadline = profile(protocol, &fixture.url, "fixture-trickle");
        deadline.options.timeout_ms = 300;
        deadline.options.idle_timeout_ms = 200;
        assert_eq!(
            run(deadline, input(false), CancellationToken::new())
                .await
                .unwrap_err()
                .code,
            ModelErrorCode::Timeout
        );
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    let records = fixture.records().await;
    assert_eq!(records.len(), 9);
    assert!(records.iter().all(|r| r["disconnected"] == true));
}
#[tokio::test]
async fn unknown_usage_stays_unknown_and_model_list_is_separate() {
    let fixture = Fixture::start();
    let backend = HttpBackend::new().unwrap();
    for protocol in PROTOCOLS {
        let p = profile(protocol, &fixture.url, "fixture-unknown");
        let output = run(p.clone(), input(false), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(output.usage.input_tokens, None);
        assert_eq!(output.usage.output_tokens, None);
        assert_eq!(output.usage.cost_microunits, None);
        let mut blank = p;
        blank.model = String::new();
        let (models, more) = backend
            .models(
                &blank,
                Some(&Secret::new(KEY.into()).unwrap()),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(models.len(), 5);
        assert!(!more);
        assert!(config::request_body(&blank, &input(false)).is_err());
    }
    assert_eq!(fixture.records().await.len(), 6);
}
#[test]
fn urls_and_request_shapes_are_protocol_specific() {
    for protocol in PROTOCOLS {
        let suffix = match protocol {
            ProtocolKind::ChatCompletions => "chat/completions",
            ProtocolKind::Responses => "responses",
            ProtocolKind::Messages => "messages",
        };
        for base in [
            "https://example.com",
            "https://example.com/",
            "https://example.com/v1/",
        ] {
            assert_eq!(
                config::endpoint(&profile(protocol, base, "m"))
                    .unwrap()
                    .as_str(),
                format!("https://example.com/v1/{suffix}")
            );
        }
        let full = format!("https://example.com/proxy/v1/{suffix}");
        assert_eq!(
            config::endpoint(&profile(protocol, &full, "m"))
                .unwrap()
                .as_str(),
            full
        );
        let p = profile(protocol, "https://example.com/api", "m");
        let body = config::request_body(&p, &input(true)).unwrap();
        assert_eq!(body["stream"], true);
        match protocol {
            ProtocolKind::ChatCompletions => {
                assert_eq!(body["tools"][0]["function"]["name"], "workpilot_echo");
                assert_eq!(body["max_completion_tokens"], 1024);
                assert!(body.get("stream_options").is_none());
            }
            ProtocolKind::Responses => {
                assert_eq!(body["tools"][0]["name"], "workpilot_echo");
                assert_eq!(body["store"], false);
                assert_eq!(body["max_output_tokens"], 1024);
            }
            ProtocolKind::Messages => {
                assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
                assert_eq!(body["max_tokens"], 1024);
            }
        }
    }
    for url in [
        "http://example.com",
        "https://user:password@example.com",
        "https://example.com?key=x",
        "https://example.com/#x",
        "https://example.com/v1/v1",
        "file:///tmp/x",
    ] {
        assert!(
            config::endpoint(&profile(ProtocolKind::Responses, url, "m")).is_err(),
            "{url}"
        );
    }
    assert!(
        config::endpoint(&profile(
            ProtocolKind::Messages,
            "https://example.com/v1/responses",
            "m"
        ))
        .is_err()
    );
}
#[test]
fn images_and_tool_results_cannot_be_silently_dropped() {
    for protocol in PROTOCOLS {
        let mut p = profile(protocol, "https://example.com", "m");
        let mut i = input(false);
        i.messages[0].content.push(ModelContent::Image {
            media_type: "image/png".into(),
            base64: "aGVsbG8=".into(),
        });
        assert_eq!(
            config::request_body(&p, &i).unwrap_err().code,
            ModelErrorCode::Capability
        );
        p.capabilities.images.supported = Some(false);
        assert_eq!(
            config::request_body(&p, &i).unwrap_err().code,
            ModelErrorCode::Capability
        );
        i.capability_probe = Some(ModelProbeMode::Image);
        let body = config::request_body(&p, &i).unwrap();
        assert!(body.to_string().contains("aGVsbG8="));
        i.tool_results.push(ModelToolResult {
            call_id: "missing".into(),
            output: "x".into(),
            is_error: false,
        });
        assert!(config::request_body(&p, &i).is_err());
    }
}
#[test]
fn decoder_handles_single_bytes_utf8_multiline_and_all_newlines() {
    let mut decoder = crate::sse::Decoder::default();
    let mut frames = vec![];
    for b in "\u{feff}: comment\r\nevent: sample\r\ndata: 你\r\ndata: 好\r\n\r\n".as_bytes() {
        frames.extend(decoder.push(&[*b]).unwrap());
    }
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].event, "sample");
    assert_eq!(frames[0].data, "你\n好");
    let mut decoder = crate::sse::Decoder::default();
    assert!(decoder.push(b"data: unfinished").unwrap().is_empty());
    assert!(decoder.push(&vec![b'x'; 600_000]).is_err());
}
#[test]
fn truncating_an_error_cannot_leave_a_secret_prefix() {
    let mut e = diagnostic::detail(
        ModelErrorCode::Server,
        &format!("{}{}", "x".repeat(1020), KEY),
    );
    e.provider_request_id = Some(KEY.into());
    let e = diagnostic::sanitized(e, Some(KEY));
    assert!(!e.detail.unwrap().contains("work"));
    assert!(!e.provider_request_id.unwrap().contains(KEY));
}
