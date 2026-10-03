//! Public-client OAuth. Tokens are returned only to the system credential writer.
use crate::{Result, mcp};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::{
    digest,
    rand::{SecureRandom, SystemRandom},
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use zeroize::Zeroizing;

pub(crate) struct Flow {
    pub installation: String,
    pub scope: Option<String>,
    pub stop: Arc<AtomicBool>,
    pub state: Mutex<Value>,
    pub created: std::time::Instant,
}
pub(crate) struct Pending {
    pub authorization_url: String,
    listener: TcpListener,
    redirect: String,
    state: Zeroizing<String>,
    verifier: Zeroizing<String>,
    client_id: String,
    resource: String,
    issuer: String,
    token_url: String,
    require_issuer: bool,
}
fn random() -> Result<Zeroizing<String>> {
    let mut bytes = [0u8; 32];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| "无法生成授权随机值。")?;
    Ok(Zeroizing::new(URL_SAFE_NO_PAD.encode(bytes)))
}
fn endpoint(value: &str, resource: &url::Url) -> Result<url::Url> {
    let url = mcp::endpoint(value)?;
    if resource.scheme() == "https" && url.scheme() != "https" {
        return Err("远程授权不能跳转到本机或不加密地址。".into());
    }
    if resource.scheme() == "http" && url.origin() != resource.origin() {
        return Err("本机授权测试必须使用同一来源地址。".into());
    }
    Ok(url)
}
async fn json_response(response: reqwest::Response) -> Result<Value> {
    if !response.status().is_success() {
        return Err(format!(
            "授权服务返回 HTTP {}。",
            response.status().as_u16()
        ));
    }
    use futures_util::StreamExt;
    let mut bytes = Zeroizing::new(Vec::new());
    let mut stream = response.bytes_stream();
    while let Some(part) = stream.next().await {
        let part = part.map_err(|_| "授权响应中断。")?;
        if bytes.len() + part.len() > 128 * 1024 {
            return Err("授权响应过大。".into());
        }
        bytes.extend(part);
    }
    serde_json::from_slice(&bytes).map_err(|_| "授权服务未返回有效 JSON。".into())
}
async fn metadata(url: url::Url) -> Result<Value> {
    json_response(
        mcp::client()?
            .get(url)
            .send()
            .await
            .map_err(|_| "无法读取授权服务说明。")?,
    )
    .await
}
pub(crate) async fn begin(
    resource: &str,
    client_id: Option<String>,
    scopes: Vec<String>,
) -> Result<Pending> {
    let resource_url = mcp::endpoint(resource)?;
    if scopes.len() > 32
        || scopes.iter().any(|s| {
            s.is_empty() || s.len() > 128 || !s.bytes().all(|c| (0x21..=0x7e).contains(&c))
        })
    {
        return Err("授权范围格式无效。".into());
    }
    let mut discovery = resource_url.clone();
    discovery.set_path(&format!(
        "/.well-known/oauth-protected-resource{}",
        resource_url.path().trim_end_matches('/')
    ));
    // Read a challenge without sending a credential. Unsupported GET falls back to well-known discovery.
    if let Ok(response) = mcp::client()?
        .get(resource_url.clone())
        .header("Accept", "application/json")
        .send()
        .await
        && let Some(challenge) = response
            .headers()
            .get("WWW-Authenticate")
            .and_then(|v| v.to_str().ok())
        && let Some(value) = challenge
            .split("resource_metadata=\"")
            .nth(1)
            .and_then(|v| v.split('"').next())
    {
        discovery = endpoint(value, &resource_url)?;
    }
    let protected = match metadata(discovery).await {
        Ok(v) => v,
        Err(_) => {
            let mut root = resource_url.clone();
            root.set_path("/.well-known/oauth-protected-resource");
            metadata(root).await?
        }
    };
    let canonical = protected["resource"].as_str().ok_or("服务缺少资源标识。")?;
    if canonical.trim_end_matches('/') != resource_url.as_str().trim_end_matches('/') {
        return Err("授权资源与已安装服务地址不一致。".into());
    }
    let issuer = protected["authorization_servers"]
        .as_array()
        .and_then(|v| v.first())
        .and_then(Value::as_str)
        .ok_or("服务未提供授权服务器。")?
        .to_owned();
    let issuer_url = endpoint(&issuer, &resource_url)?;
    let mut discovery = issuer_url.clone();
    discovery.set_path(&format!(
        "/.well-known/oauth-authorization-server{}",
        issuer_url.path().trim_end_matches('/')
    ));
    let auth = match metadata(discovery).await {
        Ok(v) => v,
        Err(_) => {
            let mut oidc = issuer_url.clone();
            oidc.set_path(&format!(
                "{}/.well-known/openid-configuration",
                issuer_url.path().trim_end_matches('/')
            ));
            metadata(oidc).await?
        }
    };
    if auth["issuer"] != issuer
        || !auth["code_challenge_methods_supported"]
            .as_array()
            .is_some_and(|v| v.iter().any(|s| s == "S256"))
    {
        return Err("授权服务身份不匹配，或不支持安全的 PKCE S256 登录。".into());
    }
    let auth_url = endpoint(
        auth["authorization_endpoint"]
            .as_str()
            .ok_or("缺少授权页面。")?,
        &resource_url,
    )?;
    let token_url = endpoint(
        auth["token_endpoint"]
            .as_str()
            .ok_or("缺少凭据交换地址。")?,
        &resource_url,
    )?
    .to_string();
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|_| "无法创建本机授权接收端口。")?;
    let redirect = format!(
        "http://127.0.0.1:{}/callback",
        listener
            .local_addr()
            .map_err(|_| "无法读取本机授权端口。")?
            .port()
    );
    let client_id = if let Some(id) = client_id.filter(|v| !v.trim().is_empty()) {
        if id.len() > 1024 || id.chars().any(char::is_control) {
            return Err("客户端编号无效。".into());
        }
        id
    } else {
        let registration = endpoint(
            auth["registration_endpoint"]
                .as_str()
                .ok_or("该服务需要预先注册客户端。请填写服务提供的公开客户端编号，再登录。")?,
            &resource_url,
        )?;
        let registered=json_response(mcp::client()?.post(registration).json(&json!({"client_name":"WorkPilot","redirect_uris":[redirect],"grant_types":["authorization_code"],"response_types":["code"],"token_endpoint_auth_method":"none"})).send().await.map_err(|_|"公开客户端注册失败。")?).await?;
        if registered["token_endpoint_auth_method"] != "none" {
            return Err("服务注册结果要求客户端密钥，当前仅支持公开客户端登录。".into());
        }
        registered["client_id"]
            .as_str()
            .filter(|v| !v.is_empty() && v.len() <= 1024)
            .ok_or("服务没有返回客户端编号。")?
            .to_owned()
    };
    let state = random()?;
    let verifier = random()?;
    let challenge =
        URL_SAFE_NO_PAD.encode(digest::digest(&digest::SHA256, verifier.as_bytes()).as_ref());
    let mut authorization = auth_url;
    authorization.query_pairs_mut().extend_pairs([
        ("response_type", "code"),
        ("client_id", &client_id),
        ("redirect_uri", &redirect),
        ("state", state.as_str()),
        ("code_challenge", &challenge),
        ("code_challenge_method", "S256"),
        ("resource", canonical),
    ]);
    if !scopes.is_empty() {
        authorization
            .query_pairs_mut()
            .append_pair("scope", &scopes.join(" "));
    }
    Ok(Pending {
        authorization_url: authorization.to_string(),
        listener,
        redirect,
        state,
        verifier,
        client_id,
        resource: canonical.into(),
        issuer,
        token_url,
        require_issuer: auth["authorization_response_iss_parameter_supported"] == true,
    })
}
impl Pending {
    pub async fn complete(self, stop: Arc<AtomicBool>) -> Result<Zeroizing<String>> {
        let future = async {
            let code = loop {
                let (mut socket, peer) = self
                    .listener
                    .accept()
                    .await
                    .map_err(|_| "本机授权接收失败。")?;
                if !peer.ip().is_loopback() {
                    continue;
                }
                let mut bytes = Zeroizing::new(Vec::new());
                let request = tokio::time::timeout(Duration::from_secs(3), async {
                    loop {
                        let mut buf = [0u8; 2048];
                        let n = socket
                            .read(&mut buf)
                            .await
                            .map_err(|_| "授权回调读取失败。")?;
                        if n == 0 {
                            return Err("授权回调提前关闭。");
                        }
                        bytes.extend_from_slice(&buf[..n]);
                        if bytes.len() > 16384 {
                            return Err("授权回调过大。");
                        }
                        if bytes.windows(4).any(|v| v == b"\r\n\r\n") {
                            break;
                        }
                    }
                    Ok::<(), &str>(())
                })
                .await;
                if !matches!(request, Ok(Ok(()))) {
                    continue;
                }
                let text = std::str::from_utf8(&bytes).unwrap_or("");
                let mut request_line = text.lines().next().unwrap_or("").split_whitespace();
                let method = request_line.next();
                let target = request_line.next().unwrap_or("");
                let host = text
                    .lines()
                    .filter_map(|line| line.split_once(':'))
                    .find(|(key, _)| key.eq_ignore_ascii_case("host"))
                    .map(|(_, v)| v.trim());
                let expected_host = self
                    .redirect
                    .strip_prefix("http://")
                    .and_then(|v| v.split('/').next());
                let url = url::Url::parse(&format!("http://127.0.0.1{target}"));
                let mut valid = false;
                let mut code = None;
                let mut denied = false;
                if let Some(url) = url.ok().filter(|u| {
                    u.path() == "/callback" && method == Some("GET") && host == expected_host
                }) {
                    let pairs: Vec<_> = url.query_pairs().collect();
                    let get = |key: &str| -> Option<String> {
                        let mut found = pairs.iter().filter(|(k, _)| k == key);
                        let v = found.next()?.1.to_string();
                        if found.next().is_some() {
                            None
                        } else {
                            Some(v)
                        }
                    };
                    valid = get("state").as_deref() == Some(self.state.as_str())
                        && (!self.require_issuer || get("iss").as_deref() == Some(&self.issuer))
                        && get("iss").is_none_or(|v| v == self.issuer);
                    if valid {
                        denied = get("error").is_some();
                        code = get("code").filter(|v| !v.is_empty() && v.len() <= 8192);
                    }
                }
                let body = if valid {
                    "Authorization received. You can close this tab and return to WorkPilot."
                } else {
                    "Invalid callback. Please return to the original authorization page."
                };
                let reply = format!(
                    "HTTP/1.1 {}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
                    if valid { "200 OK" } else { "400 Bad Request" },
                    body.len(),
                    body
                );
                let _ = socket.write_all(reply.as_bytes()).await;
                if valid && denied {
                    return Err("登录未获授权。".into());
                }
                if let Some(code) = code.filter(|_| valid) {
                    break Zeroizing::new(code);
                }
            };
            let form = [
                ("grant_type", "authorization_code"),
                ("code", code.as_str()),
                ("redirect_uri", &self.redirect),
                ("client_id", &self.client_id),
                ("code_verifier", self.verifier.as_str()),
                ("resource", &self.resource),
            ];
            let form = url::form_urlencoded::Serializer::new(String::new())
                .extend_pairs(form)
                .finish();
            let mut response = json_response(
                mcp::client()?
                    .post(&self.token_url)
                    .header("Content-Type", "application/x-www-form-urlencoded")
                    .body(form)
                    .send()
                    .await
                    .map_err(|_| "登录凭据交换失败；请重新登录。")?,
            )
            .await?;
            if !response["token_type"]
                .as_str()
                .is_some_and(|s| s.eq_ignore_ascii_case("Bearer"))
            {
                return Err("服务返回了不支持的凭据类型。".into());
            }
            let token = response
                .as_object_mut()
                .and_then(|v| v.remove("access_token"))
                .and_then(|v| {
                    if let Value::String(s) = v {
                        Some(s)
                    } else {
                        None
                    }
                })
                .filter(|v| !v.is_empty() && v.len() <= 4096 && !v.chars().any(char::is_control))
                .ok_or("服务未返回有效的访问凭据。")?;
            // Refresh is deliberately explicit: never replay an external tool call after token replacement.
            Ok(Zeroizing::new(token))
        };
        tokio::pin!(future);
        let timeout = tokio::time::sleep(Duration::from_secs(300));
        tokio::pin!(timeout);
        loop {
            tokio::select! {v=&mut future=>return v,_=&mut timeout=>return Err("登录等待已超时，请重新登录。".into()),_=tokio::time::sleep(Duration::from_millis(40))=>{if stop.load(Ordering::SeqCst){return Err("登录已取消。".into());}}}
        }
    }
}
