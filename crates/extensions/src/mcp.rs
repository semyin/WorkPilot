use crate::{Result, digest};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};
use workpilot_platform::tool_process::{
    self, ProcessInput, ProcessObserver, ProcessProgress, ProcessResult, ProcessSpec,
};
use zeroize::Zeroizing;
pub const PROTOCOL: &str = "2025-11-25";
const MAX_MESSAGE: usize = 2 * 1024 * 1024;
pub fn endpoint(value: &str) -> Result<url::Url> {
    let u = url::Url::parse(value).map_err(|_| "地址须为完整的 HTTP(S) URL。")?;
    let local = u.host_str().is_some_and(|h| {
        h == "localhost"
            || h.trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if u.cannot_be_a_base()
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || !(u.scheme() == "https" || (local && u.scheme() == "http"))
    {
        return Err("远程地址使用 HTTPS，本机可用 HTTP；不能含凭据、查询参数或片段。".into());
    }
    Ok(u)
}
pub fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(40))
        .tls_sslkeylogfile(false)
        .build()
        .map_err(|_| "网络客户端初始化失败。".into())
}
pub async fn download(url: &str) -> Result<Vec<u8>> {
    let response = client()?
        .get(endpoint(url)?)
        .send()
        .await
        .map_err(|_| "无法下载扩展包。")?;
    if !response.status().is_success() {
        return Err(format!(
            "下载失败：HTTP {}。地址须直接返回 ZIP，不自动跟随重定向。",
            response.status().as_u16()
        ));
    }
    body(response, crate::package::MAX_PACKAGE).await
}
pub async fn body(response: reqwest::Response, limit: usize) -> Result<Vec<u8>> {
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err("服务返回内容超过容量上限。".into());
    }
    let mut bytes = vec![];
    let mut stream = response.bytes_stream();
    while let Some(part) = stream.next().await {
        let part = part.map_err(|_| "服务连接中断；不会自动重试。")?;
        if bytes.len() + part.len() > limit {
            return Err("服务返回内容超过容量上限。".into());
        }
        bytes.extend(part);
    }
    Ok(bytes)
}
pub struct LocalSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub package: PathBuf,
    pub sandboxed: bool,
    pub ledger: PathBuf,
    pub environment: Vec<(String, Zeroizing<String>)>,
}
enum LocalEvent {
    Output(Vec<u8>),
    Ended(String),
}
struct Local {
    input: Option<mpsc::SyncSender<Vec<u8>>>,
    output: mpsc::Receiver<LocalEvent>,
    buffer: Vec<u8>,
    stopped: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<std::io::Result<ProcessResult>>>,
}
impl Local {
    fn start(
        spec: LocalSpec,
        observer: Option<ProcessObserver>,
        parent_stop: Arc<AtomicBool>,
    ) -> Result<Self> {
        if parent_stop.load(Ordering::SeqCst) {
            return Err("扩展操作已停止。".into());
        }
        let (input, receiver) = mpsc::sync_channel(16);
        let (tx, output) = mpsc::sync_channel(128);
        let stopped = Arc::new(AtomicBool::new(false));
        let flag = stopped.clone();
        let sender = tx.clone();
        let capture: ProcessObserver = Arc::new(move |event| match event {
            ProcessProgress::Stdout(bytes) => {
                if sender.try_send(LocalEvent::Output(bytes)).is_err() {
                    flag.store(true, Ordering::SeqCst);
                }
            }
            ProcessProgress::Started(pid) => {
                if let Some(f) = &observer {
                    f(ProcessProgress::Started(pid));
                }
            }
            ProcessProgress::OwnedProcesses(pids) => {
                if let Some(f) = &observer {
                    f(ProcessProgress::OwnedProcesses(pids));
                }
            }
            // Workbench redacts registered credentials before showing or persisting this stream.
            ProcessProgress::Stderr(bytes) => {
                if let Some(f) = &observer {
                    f(ProcessProgress::Stderr(bytes));
                }
            }
        });
        let flag = stopped.clone();
        let worker = std::thread::spawn(move || {
            let finished = Arc::new(AtomicBool::new(false));
            let done = finished.clone();
            let signal = flag.clone();
            let watcher = std::thread::spawn(move || {
                while !done.load(Ordering::SeqCst) {
                    if parent_stop.load(Ordering::SeqCst) {
                        signal.store(true, Ordering::SeqCst);
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
            });
            let result = tool_process::run_interactive(
                ProcessSpec {
                    program: spec.program,
                    args: spec.args,
                    cwd: spec.cwd,
                    sandboxed: spec.sandboxed,
                    timeout_ms: 120000,
                    output_limit: 8 * 1024 * 1024,
                    ledger_dir: spec.ledger,
                },
                flag,
                Some(capture),
                ProcessInput {
                    messages: receiver,
                    read_roots: vec![spec.package],
                    environment: spec.environment,
                },
            );
            finished.store(true, Ordering::SeqCst);
            let _ = watcher.join();
            let message = match &result {
                Ok(p) => format!(
                    "本地 MCP 程序已经退出（{}）：{}",
                    p.exit_code,
                    p.stderr.chars().take(4000).collect::<String>()
                ),
                Err(e) => format!("本地 MCP 程序无法启动：{e}"),
            };
            let _ = tx.try_send(LocalEvent::Ended(message));
            result
        });
        Ok(Self {
            input: Some(input),
            output,
            buffer: vec![],
            stopped,
            worker: Some(worker),
        })
    }
    fn send(&self, value: &Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(value).map_err(|_| "MCP 请求编码失败。")?;
        bytes.push(b'\n');
        if bytes.len() > 1024 * 1024 {
            return Err("MCP 请求超过 1 MiB。".into());
        }
        self.input
            .as_ref()
            .ok_or("MCP 连接已关闭。")?
            .try_send(bytes)
            .map_err(|_| "MCP 输入繁忙或已关闭。".into())
    }
    fn next(&mut self) -> Result<Option<Value>> {
        while let Ok(event) = self.output.try_recv() {
            match event {
                LocalEvent::Output(bytes) => {
                    if self.buffer.len() + bytes.len() > MAX_MESSAGE {
                        return Err("MCP 单条消息过大。".into());
                    }
                    self.buffer.extend(bytes);
                }
                LocalEvent::Ended(message) => {
                    if self.buffer.is_empty() {
                        return Err(message);
                    }
                }
            }
        }
        if let Some(n) = self.buffer.iter().position(|b| *b == b'\n') {
            let raw: Vec<_> = self.buffer.drain(..=n).collect();
            let value =
                serde_json::from_slice(&raw).map_err(|_| "本地 MCP 标准输出不是有效 JSON-RPC。")?;
            Ok(Some(value))
        } else if self.worker.as_ref().is_some_and(|j| j.is_finished()) {
            Err("本地 MCP 程序退出或输出了未结束消息。".into())
        } else {
            Ok(None)
        }
    }
    async fn close(&mut self) -> Result<()> {
        self.input.take();
        let start = Instant::now();
        while self.worker.as_ref().is_some_and(|w| !w.is_finished())
            && start.elapsed() < Duration::from_millis(300)
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        self.stopped.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let result = worker
                .join()
                .map_err(|_| "本地 MCP 进程回收失败。")?
                .map_err(|_| "无法启动或回收本地 MCP 进程。")?;
            if !result.cleanup_errors.is_empty() {
                return Err("MCP 目录访问权限清理未完成，请检查本机诊断。".into());
            }
        }
        Ok(())
    }
}
impl Drop for Local {
    fn drop(&mut self) {
        self.input.take();
        self.stopped.store(true, Ordering::SeqCst);
    }
}
struct Http {
    client: reqwest::Client,
    url: url::Url,
    token: Option<Zeroizing<String>>,
    session: Option<String>,
    version: String,
}
impl Http {
    fn request(&self, method: reqwest::Method) -> reqwest::RequestBuilder {
        let mut r = self
            .client
            .request(method, self.url.clone())
            .header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", &self.version);
        if let Some(token) = &self.token {
            let mut value =
                reqwest::header::HeaderValue::from_str(&format!("Bearer {}", token.as_str()))
                    .expect("validated credential");
            value.set_sensitive(true);
            r = r.header("Authorization", value);
        }
        if let Some(s) = &self.session {
            r = r.header("MCP-Session-Id", s);
        }
        r
    }
    async fn post(&mut self, value: &Value) -> Result<Vec<Value>> {
        let response = self
            .request(reqwest::Method::POST)
            .json(value)
            .send()
            .await
            .map_err(|_| "MCP 连接失败；未自动重试。")?;
        let status = response.status();
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err("MCP 需要登录或凭据权限不足；请在扩展设置中处理后再继续。".into());
        }
        if status.as_u16() == 404 {
            return Err("MCP 会话已失效，请重新检查连接；原调用不会重放。".into());
        }
        if !status.is_success() {
            return Err(format!(
                "MCP 服务返回 HTTP {}；不会自动重试。",
                status.as_u16()
            ));
        }
        if let Some(s) = response.headers().get("MCP-Session-Id") {
            let s = s.to_str().map_err(|_| "MCP 会话编号无效。")?;
            if s.is_empty() || s.len() > 256 || !s.bytes().all(|c| (0x21..=0x7e).contains(&c)) {
                return Err("MCP 会话编号无效。".into());
            }
            if value["method"] != "initialize" && self.session.as_deref() != Some(s) {
                return Err("MCP 服务在调用中更换了会话编号。".into());
            }
            self.session = Some(s.into());
        }
        if status.as_u16() == 202 {
            return if value.get("id").is_none() || value.get("method").is_none() {
                Ok(vec![])
            } else {
                Err("MCP 请求未返回可对应的结果。".into())
            };
        }
        let kind = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_owned();
        if kind == "application/json" {
            let bytes = body(response, MAX_MESSAGE).await?;
            let v = serde_json::from_slice(&bytes).map_err(|_| "MCP 响应不是有效 JSON。")?;
            return Ok(vec![v]);
        }
        if kind != "text/event-stream" {
            return Err("MCP 响应须为 JSON 或事件流。".into());
        }
        let mut stream = response.bytes_stream();
        let mut buffer = vec![];
        let mut data = String::new();
        let mut messages = vec![];
        let mut total = 0;
        while let Some(part) = stream.next().await {
            let part = part.map_err(|_| "MCP 事件流中断；请核对原调用结果。")?;
            total += part.len();
            if total > 8 * 1024 * 1024 || buffer.len() + part.len() > MAX_MESSAGE {
                return Err("MCP 事件流超过容量上限。".into());
            }
            buffer.extend(part);
            while let Some(n) = buffer.iter().position(|b| *b == b'\n') {
                let raw: Vec<_> = buffer.drain(..=n).collect();
                let line = std::str::from_utf8(&raw)
                    .map_err(|_| "MCP 事件流不是 UTF-8。")?
                    .trim_end_matches(['\r', '\n']);
                if line.is_empty() {
                    if !data.trim().is_empty() {
                        let m: Value = serde_json::from_str(data.trim_end())
                            .map_err(|_| "MCP 事件流 JSON 无效。")?;
                        let final_reply =
                            m.get("id") == value.get("id") && m.get("method").is_none();
                        if let Some(id) = m.get("id").filter(|_| m.get("method").is_some()) {
                            // The server may wait for this response before producing its tool result.
                            let reply = if m["method"] == "ping" {
                                json!({"jsonrpc":"2.0","id":id,"result":{}})
                            } else {
                                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Client capability not enabled"}})
                            };
                            let response = self
                                .request(reqwest::Method::POST)
                                .json(&reply)
                                .send()
                                .await
                                .map_err(|_| "无法回应 MCP 服务请求。")?;
                            if !response.status().is_success() {
                                return Err("MCP 服务没有接受客户端响应。".into());
                            }
                        } else {
                            messages.push(m);
                        }
                        if messages.len() > 128 {
                            return Err("MCP 事件过多。".into());
                        }
                        if final_reply {
                            return Ok(messages);
                        }
                    }
                    data.clear();
                } else if let Some(text) = line.strip_prefix("data:") {
                    data.push_str(text.strip_prefix(' ').unwrap_or(text));
                    data.push('\n');
                    if data.len() > MAX_MESSAGE {
                        return Err("MCP 事件过大。".into());
                    }
                }
            }
        }
        Err("MCP 事件流未提供完整结果；不会重放请求。".into())
    }
}
enum Transport {
    Local(Local),
    Http(Http),
}
pub struct Session {
    transport: Transport,
    next: u64,
    stop: Arc<AtomicBool>,
    pub changed: bool,
    pub version: String,
    pub info: Value,
}
impl Session {
    pub fn local(
        spec: LocalSpec,
        stop: Arc<AtomicBool>,
        observer: Option<ProcessObserver>,
    ) -> Result<Self> {
        Ok(Self {
            transport: Transport::Local(Local::start(spec, observer, stop.clone())?),
            next: 0,
            stop,
            changed: false,
            version: PROTOCOL.into(),
            info: Value::Null,
        })
    }
    pub fn http(
        url: &str,
        token: Option<Zeroizing<String>>,
        stop: Arc<AtomicBool>,
    ) -> Result<Self> {
        if let Some(token) = &token {
            reqwest::header::HeaderValue::from_str(&format!("Bearer {}", token.as_str()))
                .map_err(|_| "服务凭据含无效字符，请重新配置。")?;
        }
        Ok(Self {
            transport: Transport::Http(Http {
                client: client()?,
                url: endpoint(url)?,
                token,
                session: None,
                version: PROTOCOL.into(),
            }),
            next: 0,
            stop,
            changed: false,
            version: PROTOCOL.into(),
            info: Value::Null,
        })
    }
    async fn notify(&mut self, value: Value) -> Result<()> {
        match &mut self.transport {
            Transport::Local(l) => l.send(&value),
            Transport::Http(h) => h.post(&value).await.map(|_| ()),
        }
    }
    async fn next_reply(&mut self, id: u64, method: &str, params: Value) -> Result<Value> {
        if self.stop.load(Ordering::SeqCst) {
            return Err("MCP 操作已停止，未发送新请求。".into());
        }
        let request = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        let mut pending = VecDeque::new();
        match &mut self.transport {
            Transport::Local(l) => l.send(&request)?,
            Transport::Http(h) => {
                let stop = self.stop.clone();
                let future = h.post(&request);
                tokio::pin!(future);
                loop {
                    tokio::select! {value=&mut future=>{pending.extend(value?);break;},_=tokio::time::sleep(Duration::from_millis(20))=>{if stop.load(Ordering::SeqCst){return Err("MCP 调用已取消；远端可能已经执行，请先核对结果。".into());}}}
                }
            }
        }
        let until = Instant::now() + Duration::from_secs(40);
        loop {
            if self.stop.load(Ordering::SeqCst) {
                return Err("MCP 调用已停止。".into());
            }
            let message = if let Some(v) = pending.pop_front() {
                Some(v)
            } else {
                match &mut self.transport {
                    Transport::Local(l) => l.next()?,
                    Transport::Http(_) => return Err("MCP 没有返回当前请求的结果。".into()),
                }
            };
            if let Some(m) = message {
                if m["jsonrpc"] != "2.0" || !m.is_object() {
                    return Err("MCP 消息不是 JSON-RPC 2.0。".into());
                }
                if m["method"] == "notifications/tools/list_changed" {
                    self.changed = true;
                    continue;
                }
                if let Some(server_id) = m.get("id").filter(|_| m.get("method").is_some()) {
                    let reply = if m["method"] == "ping" {
                        json!({"jsonrpc":"2.0","id":server_id,"result":{}})
                    } else {
                        json!({"jsonrpc":"2.0","id":server_id,"error":{"code":-32601,"message":"Client capability not enabled"}})
                    };
                    self.notify(reply).await?;
                    continue;
                }
                if m.get("method").is_some() {
                    continue;
                }
                if m["id"] != json!(id) {
                    return Err("MCP 响应编号与当前请求不一致。".into());
                }
                if let Some(error) = m.get("error") {
                    return Err(format!(
                        "MCP 协议错误（{}）：{}",
                        error["code"],
                        error["message"]
                            .as_str()
                            .unwrap_or("服务未说明原因")
                            .chars()
                            .take(1000)
                            .collect::<String>()
                    ));
                }
                return m
                    .get("result")
                    .cloned()
                    .ok_or("MCP 响应缺少 result。".into());
            }
            if Instant::now() > until {
                return Err("MCP 回复超时；不会自动重试。".into());
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
    pub async fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        if self.stop.load(Ordering::SeqCst) {
            return Err("MCP 请求已停止。".into());
        }
        self.next += 1;
        let id = self.next;
        let result = self.next_reply(id, method, params).await;
        if result.is_err() && method != "initialize" {
            let _=tokio::time::timeout(Duration::from_secs(2),self.notify(json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":id,"reason":"WorkPilot stopped or lost the operation"}}))).await;
        }
        result
    }
    pub async fn initialize(&mut self) -> Result<()> {
        let result=self.call("initialize",json!({"protocolVersion":PROTOCOL,"capabilities":{},"clientInfo":{"name":"WorkPilot","version":"0.1.0-alpha.0"}})).await?;
        let version = result["protocolVersion"]
            .as_str()
            .ok_or("MCP 服务未协商协议版本。")?;
        if ![PROTOCOL, "2025-06-18", "2025-03-26"].contains(&version) {
            return Err("当前支持 MCP 2025-03-26、2025-06-18、2025-11-25 的初始化协议。".into());
        }
        if !result["capabilities"]["tools"].is_object() {
            return Err("MCP 服务未声明工具能力。".into());
        }
        self.version = version.into();
        self.info = result["serverInfo"].clone();
        if let Transport::Http(h) = &mut self.transport {
            h.version = self.version.clone();
        }
        self.notify(json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
            .await
    }
    pub async fn tools(&mut self) -> Result<Vec<Value>> {
        let mut all = vec![];
        let mut cursor = None;
        let mut seen = std::collections::HashSet::new();
        for _ in 0..8 {
            let result = self
                .call(
                    "tools/list",
                    if let Some(cursor) = cursor {
                        json!({"cursor":cursor})
                    } else {
                        json!({})
                    },
                )
                .await?;
            let tools = result["tools"].as_array().ok_or("MCP 工具列表无效。")?;
            for tool in tools {
                let name = tool["name"].as_str().ok_or("MCP 工具名称无效。")?;
                if name.is_empty()
                    || name.len() > 128
                    || !seen.insert(name.to_owned())
                    || !tool["inputSchema"].is_object()
                    || serde_json::to_vec(tool)
                        .map_err(|_| "MCP 工具描述无效。")?
                        .len()
                        > 32768
                {
                    return Err("MCP 工具说明重复、过大或缺少参数结构。".into());
                }
                validate_schema(&tool["inputSchema"])?;
                all.push(tool.clone());
                if all.len() > 64 {
                    return Err("单个 MCP 服务最多加载 64 个工具。".into());
                }
            }
            cursor = result["nextCursor"].as_str().map(str::to_owned);
            if cursor.is_none() {
                self.changed = false;
                return Ok(all);
            }
        }
        Err("MCP 工具分页超过 8 页。".into())
    }
    pub async fn close(&mut self) -> Result<()> {
        match &mut self.transport {
            Transport::Local(l) => l.close().await,
            Transport::Http(h) => {
                if h.session.is_some() {
                    let _ = tokio::time::timeout(
                        Duration::from_secs(2),
                        h.request(reqwest::Method::DELETE).send(),
                    )
                    .await;
                }
                Ok(())
            }
        }
    }
}
pub fn tool_digest(tool: &Value) -> Result<String> {
    Ok(digest(
        &serde_json::to_vec(tool).map_err(|_| "工具说明无法计算摘要。")?,
    ))
}
fn validate_schema(schema: &Value) -> Result<()> {
    fn walk(v: &Value) -> bool {
        match v {
            Value::Object(map) => map.iter().all(|(k, v)| {
                if k == "$ref" || k == "$dynamicRef" || k == "$recursiveRef" {
                    v.as_str().is_some_and(|s| s.starts_with('#'))
                } else {
                    walk(v)
                }
            }),
            Value::Array(v) => v.iter().all(walk),
            _ => true,
        }
    }
    if !walk(schema) {
        return Err("工具参数结构不能引用外部文件或网络资源。".into());
    }
    jsonschema::validator_for(schema).map_err(|_| "MCP 参数结构无法安全验证。")?;
    Ok(())
}
pub fn validate_arguments(tool: &Value, args: &Value) -> Result<()> {
    if !args.is_object()
        || serde_json::to_vec(args)
            .map_err(|_| "参数编码失败。")?
            .len()
            > 128 * 1024
    {
        return Err("MCP 参数须为不超过 128 KiB 的对象。".into());
    }
    validate_schema(&tool["inputSchema"])?;
    let validator =
        jsonschema::validator_for(&tool["inputSchema"]).map_err(|_| "MCP 参数结构无效。")?;
    if !validator.is_valid(args) {
        return Err("MCP 参数不符合该工具公布的结构，尚未执行。".into());
    }
    Ok(())
}
