use workpilot_contracts::{ModelDiagnostic as Diagnostic, ModelErrorCode as Code};
pub type Result<T> = std::result::Result<T, Diagnostic>;
pub fn error(code: Code) -> Diagnostic {
    let (zh, en) = match code {
        Code::Configuration => (
            "服务配置不完整或参数不合适，请检查设置。",
            "The service configuration or parameters are invalid.",
        ),
        Code::Authentication => (
            "密钥未配置或未被服务接受，请检查密钥。",
            "The API key is missing or was rejected.",
        ),
        Code::Permission => (
            "这个账号没有使用此模型的权限。",
            "This account is not permitted to use this model.",
        ),
        Code::RateLimit => (
            "服务额度不足或请求过于频繁，本次已停止。",
            "The service quota or rate limit was reached. This call stopped.",
        ),
        Code::Server => (
            "模型服务返回错误，本次已停止，没有自动重试。",
            "The model service returned an error. No retry was made.",
        ),
        Code::Timeout => (
            "等待模型服务超时，本次已停止。",
            "The model service timed out. This call stopped.",
        ),
        Code::Network => (
            "无法连接模型服务，或连接中途断开。",
            "The model service could not be reached or the connection broke.",
        ),
        Code::Cancelled => ("本次模型请求已停止。", "This model request was cancelled."),
        Code::MalformedStream => (
            "服务返回的数据不完整或格式不正确，未执行其中的工具请求。",
            "The service returned malformed data. Its tool requests were not executed.",
        ),
        Code::Incomplete => (
            "服务没有完整结束本次回答，已保留收到的内容。",
            "The response did not finish completely. Received content was retained.",
        ),
        Code::Capability => (
            "该模型尚未确认支持此能力，或已标记为不支持。请先测试或修改能力设置。",
            "This capability is unsupported or unverified. Test it or update its setting first.",
        ),
        Code::Unsupported => (
            "服务不支持这项接口或返回了当前未支持的内容。",
            "The service does not support this endpoint or returned unsupported content.",
        ),
        Code::Limit => (
            "本次输入或输出超过当前容量限制，已停止处理。",
            "The input or output exceeded the current size limit.",
        ),
    };
    Diagnostic {
        code,
        message_zh: zh.into(),
        message_en: en.into(),
        detail: None,
        http_status: None,
        provider_request_id: None,
        retryable: false,
    }
}
pub fn detail(code: Code, text: &str) -> Diagnostic {
    let mut e = error(code);
    e.detail = Some(text.into());
    e
}
pub fn sanitized(mut e: Diagnostic, secret: Option<&str>) -> Diagnostic {
    for value in [&mut e.detail, &mut e.provider_request_id]
        .into_iter()
        .flatten()
    {
        if let Some(secret) = secret {
            *value = value.replace(secret, "[REDACTED]");
        }
        let lower = value.to_ascii_lowercase();
        if [
            "authorization",
            "api_key",
            "api-key",
            "x-api-key",
            "bearer ",
            "cookie",
            "password",
        ]
        .iter()
        .any(|x| lower.contains(x))
        {
            *value = "[REDACTED AUTHENTICATION DATA]".into();
        }
        *value = value.chars().take(1024).collect();
    }
    e
}
