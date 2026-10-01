//! Independent model protocol adapters; no tool execution, fallback or retries.
pub mod config;
pub mod diagnostic;
mod masking;
mod sse;
mod stream;
#[cfg(test)]
mod tests;
use diagnostic::{Result, error, sanitized};
use futures_util::StreamExt;
use reqwest::{Client, RequestBuilder};
use serde_json::Value;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use workpilot_contracts::*;
use workpilot_platform::credentials::Secret;

/// UI/engine code depends on this boundary; a native/local backend can be added later.
pub trait ModelBackend {
    fn execute(
        &self,
        profile: ProviderProfile,
        input: ModelInput,
        secret: Option<Secret>,
        cancel: CancellationToken,
        updates: mpsc::Sender<ModelUpdate>,
    ) -> impl std::future::Future<Output = Result<ModelOutput>> + Send;
}
#[derive(Clone)]
pub struct HttpBackend {
    client: Client,
}
impl HttpBackend {
    pub fn new() -> Result<Self> {
        let client = Client::builder()
            .retry(reqwest::retry::never())
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .tls_sslkeylogfile(false)
            .build()
            .map_err(|_| error(ModelErrorCode::Configuration))?;
        Ok(Self { client })
    }
    fn authenticate(
        &self,
        builder: RequestBuilder,
        p: &ProviderProfile,
        secret: Option<&Secret>,
    ) -> Result<RequestBuilder> {
        let mut builder = builder.header(reqwest::header::ACCEPT, "text/event-stream");
        let auth = config::effective_auth(p);
        if auth != AuthMode::None {
            let secret = secret
                .ok_or_else(|| error(ModelErrorCode::Authentication))?
                .expose();
            let value = if auth == AuthMode::Bearer {
                format!("Bearer {secret}")
            } else {
                secret.to_owned()
            };
            let mut header = reqwest::header::HeaderValue::from_str(&value)
                .map_err(|_| error(ModelErrorCode::Authentication))?;
            header.set_sensitive(true);
            builder = builder.header(
                if auth == AuthMode::Bearer {
                    "authorization"
                } else {
                    "x-api-key"
                },
                header,
            );
        }
        if p.protocol == ProtocolKind::Messages {
            builder = builder.header("anthropic-version", &p.options.anthropic_version);
        }
        Ok(builder)
    }
    async fn run(
        &self,
        p: &ProviderProfile,
        input: &ModelInput,
        secret: Option<&Secret>,
        cancel: &CancellationToken,
        updates: mpsc::Sender<ModelUpdate>,
    ) -> Result<ModelOutput> {
        let body = config::request_body(p, input)?;
        let request = self.authenticate(
            self.client
                .post(config::endpoint(p)?)
                .json(&body)
                .timeout(Duration::from_millis(p.options.timeout_ms.into())),
            p,
            secret,
        )?;
        let response = tokio::select! {biased;_=cancel.cancelled()=>return Err(error(ModelErrorCode::Cancelled)),r=request.send()=>r.map_err(network_error)?};
        let request_id = response
            .headers()
            .get("x-request-id")
            .or_else(|| response.headers().get("request-id"))
            .and_then(|h| h.to_str().ok())
            .map(str::to_owned);
        if !response.status().is_success() {
            return Err(http_error(response, cancel, request_id).await);
        }
        if !response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.to_ascii_lowercase().starts_with("text/event-stream"))
        {
            return Err(diagnostic::detail(
                ModelErrorCode::MalformedStream,
                "服务没有返回流式事件，请核对协议和接口地址",
            ));
        }
        let mut decoder = sse::Decoder::default();
        let mut parser = stream::Stream::new(p.protocol, &input.tools);
        let mut bytes = response.bytes_stream();
        let mut total = 0_usize;
        let mut text_masker = masking::Masker::default();
        let mut reasoning_masker = masking::Masker::default();
        loop {
            let next = tokio::select! {
                biased;_=cancel.cancelled()=>return Err(error(ModelErrorCode::Cancelled)),
                next=tokio::time::timeout(Duration::from_millis(p.options.idle_timeout_ms.into()),bytes.next())=>next.map_err(|_|error(ModelErrorCode::Timeout))?
            };
            let Some(chunk) = next else {
                return Err(error(ModelErrorCode::Incomplete));
            };
            let chunk = chunk.map_err(network_error)?;
            total += chunk.len();
            if total > 16 * 1024 * 1024 {
                return Err(error(ModelErrorCode::Limit));
            }
            for frame in decoder.push(&chunk)? {
                let parsed = parser.frame(frame)?;
                for event in parsed.updates {
                    let event = match event {
                        ModelUpdate::Text(value) => {
                            ModelUpdate::Text(text_masker.push(&value, secret.map(Secret::expose)))
                        }
                        ModelUpdate::PublicReasoning(value) => ModelUpdate::PublicReasoning(
                            reasoning_masker.push(&value, secret.map(Secret::expose)),
                        ),
                    };
                    tokio::select! {biased;_=cancel.cancelled()=>return Err(error(ModelErrorCode::Cancelled)),r=updates.send(event)=>r.map_err(|_|error(ModelErrorCode::Cancelled))?}
                }
                if let Some(mut output) = parsed.output {
                    if cancel.is_cancelled() {
                        return Err(error(ModelErrorCode::Cancelled));
                    }
                    output.usage = config::estimate_usage(output.usage, p.pricing.as_ref());
                    for event in [
                        ModelUpdate::Text(text_masker.finish()),
                        ModelUpdate::PublicReasoning(reasoning_masker.finish()),
                    ] {
                        if matches!(&event,ModelUpdate::Text(s)|ModelUpdate::PublicReasoning(s) if s.is_empty())
                        {
                            continue;
                        }
                        tokio::select! {biased;_=cancel.cancelled()=>return Err(error(ModelErrorCode::Cancelled)),r=updates.send(event)=>r.map_err(|_|error(ModelErrorCode::Cancelled))?}
                    }
                    return Ok(output);
                }
            }
        }
    }
    pub async fn models(
        &self,
        p: &ProviderProfile,
        secret: Option<&Secret>,
        cancel: &CancellationToken,
    ) -> Result<(Vec<ModelInfo>, bool)> {
        config::validate_profile(p)?;
        let request = self
            .authenticate(
                self.client
                    .get(config::models_endpoint(p)?)
                    .timeout(Duration::from_secs(15)),
                p,
                secret,
            )?
            .header(reqwest::header::ACCEPT, "application/json");
        let response = tokio::select! {biased;_=cancel.cancelled()=>return Err(error(ModelErrorCode::Cancelled)),r=request.send()=>r.map_err(network_error)?};
        if !response.status().is_success() {
            return Err(sanitized(
                http_error(response, cancel, None).await,
                secret.map(Secret::expose),
            ));
        }
        let value: Value =
            serde_json::from_slice(&limited_body(response, cancel, 1024 * 1024).await?)
                .map_err(|_| error(ModelErrorCode::MalformedStream))?;
        let values = value["data"]
            .as_array()
            .ok_or_else(|| error(ModelErrorCode::MalformedStream))?;
        let mut models = vec![];
        for row in values.iter().take(1000) {
            let id = row["id"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 256)
                .ok_or_else(|| error(ModelErrorCode::MalformedStream))?;
            if secret.is_some_and(|s| {
                id.contains(s.expose())
                    || row["display_name"]
                        .as_str()
                        .is_some_and(|v| v.contains(s.expose()))
            }) {
                return Err(error(ModelErrorCode::MalformedStream));
            }
            models.push(ModelInfo {
                id: id.into(),
                display_name: row["display_name"]
                    .as_str()
                    .map(|s| s.chars().take(256).collect()),
            });
        }
        Ok((
            models,
            values.len() > 1000 || value["has_more"].as_bool() == Some(true),
        ))
    }
}
impl ModelBackend for HttpBackend {
    async fn execute(
        &self,
        profile: ProviderProfile,
        input: ModelInput,
        secret: Option<Secret>,
        cancel: CancellationToken,
        updates: mpsc::Sender<ModelUpdate>,
    ) -> Result<ModelOutput> {
        self.run(&profile, &input, secret.as_ref(), &cancel, updates)
            .await
            .map_err(|e| sanitized(e, secret.as_ref().map(Secret::expose)))
    }
}
fn network_error(error_value: reqwest::Error) -> ModelDiagnostic {
    error(if error_value.is_timeout() {
        ModelErrorCode::Timeout
    } else {
        ModelErrorCode::Network
    })
}
async fn limited_body(
    response: reqwest::Response,
    cancel: &CancellationToken,
    limit: usize,
) -> Result<Vec<u8>> {
    let mut chunks = response.bytes_stream();
    let mut body = vec![];
    loop {
        let chunk = tokio::select! {biased;_=cancel.cancelled()=>return Err(error(ModelErrorCode::Cancelled)),c=chunks.next()=>c};
        let Some(chunk) = chunk else {
            break;
        };
        let chunk = chunk.map_err(network_error)?;
        if body.len() + chunk.len() > limit {
            return Err(error(ModelErrorCode::Limit));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}
async fn http_error(
    response: reqwest::Response,
    cancel: &CancellationToken,
    request_id: Option<String>,
) -> ModelDiagnostic {
    let status = response.status().as_u16();
    let code = match status {
        401 => ModelErrorCode::Authentication,
        403 => ModelErrorCode::Permission,
        404 | 405 => ModelErrorCode::Unsupported,
        429 => ModelErrorCode::RateLimit,
        400 | 422 => ModelErrorCode::Configuration,
        _ => ModelErrorCode::Server,
    };
    let mut e = error(code);
    e.http_status = Some(status);
    e.provider_request_id = request_id;
    if let Ok(body) = limited_body(response, cancel, 65_536).await
        && let Ok(value) = serde_json::from_slice::<Value>(&body)
    {
        e.detail = value
            .pointer("/error/message")
            .or_else(|| value.get("message"))
            .and_then(Value::as_str)
            .map(str::to_owned);
    }
    e
}
