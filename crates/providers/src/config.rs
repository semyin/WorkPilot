use crate::diagnostic::{Result, detail, error};
use serde_json::{Value, json};
use url::Url;
use workpilot_contracts::*;

pub const MAX_INPUT_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_TOOL_ARGUMENT_BYTES: usize = 256 * 1024;
pub fn endpoint(profile: &ProviderProfile) -> Result<Url> {
    let mut url = Url::parse(profile.base_url.trim()).map_err(|_| {
        detail(
            ModelErrorCode::Configuration,
            "base_url must be an absolute HTTP(S) URL",
        )
    })?;
    if url.cannot_be_a_base()
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(detail(
            ModelErrorCode::Configuration,
            "地址不能包含用户名、密码、查询参数或 # 片段",
        ));
    }
    let local = url.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if url.scheme() != "https" && !(url.scheme() == "http" && local) {
        return Err(detail(
            ModelErrorCode::Configuration,
            "远程服务使用 https；本机测试地址可使用 http",
        ));
    }
    let suffix = match profile.protocol {
        ProtocolKind::ChatCompletions => "chat/completions",
        ProtocolKind::Responses => "responses",
        ProtocolKind::Messages => "messages",
    };
    let base = url.path().trim_end_matches('/');
    let path = if base.ends_with(&format!("/{suffix}")) {
        base.to_owned()
    } else {
        if ["chat/completions", "responses", "messages"]
            .iter()
            .any(|part| base.ends_with(&format!("/{part}")))
        {
            return Err(detail(
                ModelErrorCode::Configuration,
                "地址末尾的接口与所选协议不一致",
            ));
        }
        if base.is_empty() {
            format!("/v1/{suffix}")
        } else {
            format!("{base}/{suffix}")
        }
    };
    if path.contains("/v1/v1/") || path.contains("//") {
        return Err(detail(
            ModelErrorCode::Configuration,
            "地址包含重复的路径片段",
        ));
    }
    url.set_path(&path);
    Ok(url)
}
pub fn models_endpoint(profile: &ProviderProfile) -> Result<Url> {
    let mut url = endpoint(profile)?;
    let suffix = match profile.protocol {
        ProtocolKind::ChatCompletions => "/chat/completions",
        ProtocolKind::Responses => "/responses",
        ProtocolKind::Messages => "/messages",
    };
    let path = format!("{}/models", url.path().strip_suffix(suffix).unwrap());
    url.set_path(&path);
    Ok(url)
}
pub fn validate_profile(p: &ProviderProfile) -> Result<()> {
    if !valid_id(&p.id)
        || p.label.trim().is_empty()
        || p.label.len() > 256
        || p.model.len() > 256
        || p.base_url.len() > 2048
        || p.revision == 0
    {
        return Err(detail(
            ModelErrorCode::Configuration,
            "请填写服务名称、有效地址和模型名称",
        ));
    }
    endpoint(p)?;
    let opts = &p.options;
    if opts
        .max_output_tokens
        .is_some_and(|n| n == 0 || n > 1_000_000)
        || opts
            .temperature
            .is_some_and(|n| !n.is_finite() || !(0.0..=2.0).contains(&n))
        || !(100..=600_000).contains(&opts.timeout_ms)
        || !(100..=300_000).contains(&opts.idle_timeout_ms)
        || opts.idle_timeout_ms > opts.timeout_ms
    {
        return Err(detail(
            ModelErrorCode::Configuration,
            "输出上限、温度或等待时间超出范围",
        ));
    }
    if let Some(effort) = &opts.reasoning_effort
        && (!["none", "minimal", "low", "medium", "high", "xhigh", "max"]
            .contains(&effort.as_str())
            || p.protocol == ProtocolKind::Messages)
    {
        return Err(detail(
            ModelErrorCode::Configuration,
            "该思考强度参数不适用于当前协议",
        ));
    }
    if opts.anthropic_version.len() != 10
        || !opts
            .anthropic_version
            .bytes()
            .all(|b| b.is_ascii_digit() || b == b'-')
    {
        return Err(detail(
            ModelErrorCode::Configuration,
            "Messages API 版本应为日期格式",
        ));
    }
    if let Some(price) = &p.pricing
        && (price.currency.len() != 3
            || !price.currency.bytes().all(|b| b.is_ascii_uppercase())
            || price.input_microunits_per_million > 1_000_000_000_000
            || price.output_microunits_per_million > 1_000_000_000_000)
    {
        return Err(detail(
            ModelErrorCode::Configuration,
            "价格或币种格式不正确",
        ));
    }
    Ok(())
}
pub fn effective_auth(p: &ProviderProfile) -> AuthMode {
    match p.auth {
        AuthMode::Auto => {
            if p.protocol == ProtocolKind::Messages {
                AuthMode::ApiKey
            } else {
                AuthMode::Bearer
            }
        }
        other => other,
    }
}
pub fn validate_input(p: &ProviderProfile, input: &ModelInput) -> Result<()> {
    if input.history.len() > 1024 {
        return Err(error(ModelErrorCode::Limit));
    }
    for item in &input.history {
        match item {
            ModelHistoryItem::Message { message } => {
                // History messages cannot introduce new system-level policy or unvalidated images.
                if !["user", "assistant"].contains(&message.role.as_str())
                    || message.content.is_empty()
                    || message
                        .content
                        .iter()
                        .any(|c| !matches!(c, ModelContent::Text { .. }))
                {
                    return Err(error(ModelErrorCode::Configuration));
                }
            }
            ModelHistoryItem::Exchange {
                continuation,
                tool_results,
            } => {
                let actual: std::collections::HashSet<_> =
                    tool_results.iter().map(|r| r.call_id.as_str()).collect();
                if continuation.protocol != p.protocol
                    || actual.len() != tool_results.len()
                    || actual != tool_ids(continuation)
                {
                    return Err(detail(
                        ModelErrorCode::Configuration,
                        "历史工具调用和结果不匹配，或更改了协议",
                    ));
                }
            }
        }
    }
    if input.messages.is_empty()
        || input.messages.len() > 512
        || input.tools.len() > 64
        || serde_json::to_vec(input)
            .map_err(|_| error(ModelErrorCode::Configuration))?
            .len()
            > MAX_INPUT_BYTES
    {
        return Err(error(ModelErrorCode::Limit));
    }
    let has_images = input.messages.iter().any(|m| {
        m.content
            .iter()
            .any(|v| matches!(v, ModelContent::Image { .. }))
    });
    for message in &input.messages {
        if !["user", "assistant", "system", "developer"].contains(&message.role.as_str())
            || message.content.is_empty()
        {
            return Err(error(ModelErrorCode::Configuration));
        }
        for content in &message.content {
            if let ModelContent::Image { media_type, base64 } = content
                && (!["image/png", "image/jpeg", "image/webp", "image/gif"]
                    .contains(&media_type.as_str())
                    || base64.len() > 2 * 1024 * 1024
                    || base64.is_empty()
                    || base64.len() % 4 != 0
                    || !base64
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b))
                    || message.role != "user")
            {
                return Err(detail(
                    ModelErrorCode::Configuration,
                    "图片必须是支持格式的用户输入",
                ));
            }
        }
    }
    if p.capabilities.text.supported == Some(false)
        || p.capabilities.streaming.supported == Some(false)
    {
        return Err(error(ModelErrorCode::Capability));
    }
    if has_images
        && p.capabilities.images.supported != Some(true)
        && input.capability_probe != Some(ModelProbeMode::Image)
    {
        return Err(error(ModelErrorCode::Capability));
    }
    if !input.tools.is_empty()
        && p.capabilities.tools.supported != Some(true)
        && input.capability_probe != Some(ModelProbeMode::Tools)
    {
        return Err(error(ModelErrorCode::Capability));
    }
    let mut names = std::collections::HashSet::new();
    for tool in &input.tools {
        if !valid_id(&tool.name)
            || tool.name.len() > 64
            || !names.insert(&tool.name)
            || !tool.parameters.is_object()
            || tool.parameters["type"] != "object"
        {
            return Err(detail(
                ModelErrorCode::Configuration,
                "工具定义必须有唯一名称及对象参数结构",
            ));
        }
    }
    if let Some(previous) = &input.continuation {
        if previous.protocol != p.protocol {
            return Err(detail(
                ModelErrorCode::Configuration,
                "不能跨协议复用上一轮的原始数据",
            ));
        }
        let expected = tool_ids(previous);
        let actual: std::collections::HashSet<_> = input
            .tool_results
            .iter()
            .map(|r| r.call_id.as_str())
            .collect();
        if actual.len() != input.tool_results.len() || expected != actual {
            return Err(detail(
                ModelErrorCode::Configuration,
                "工具结果必须与上一轮的调用编号一一对应",
            ));
        }
    } else if !input.tool_results.is_empty() {
        return Err(detail(
            ModelErrorCode::Configuration,
            "工具结果缺少对应的上一轮响应",
        ));
    }
    Ok(())
}
fn tool_ids(c: &ProviderContinuation) -> std::collections::HashSet<&str> {
    let mut ids = std::collections::HashSet::new();
    for item in &c.items {
        match c.protocol {
            ProtocolKind::ChatCompletions => {
                if let Some(calls) = item["tool_calls"].as_array() {
                    for call in calls {
                        if let Some(id) = call["id"].as_str() {
                            ids.insert(id);
                        }
                    }
                }
            }
            ProtocolKind::Responses => {
                if item["type"] == "function_call"
                    && let Some(id) = item["call_id"].as_str()
                {
                    ids.insert(id);
                }
            }
            ProtocolKind::Messages => {
                if item["type"] == "tool_use"
                    && let Some(id) = item["id"].as_str()
                {
                    ids.insert(id);
                }
            }
        }
    }
    ids
}
pub fn request_body(p: &ProviderProfile, input: &ModelInput) -> Result<Value> {
    validate_profile(p)?;
    validate_input(p, input)?;
    if p.model.trim().is_empty() {
        return Err(detail(
            ModelErrorCode::Configuration,
            "请先填写或选择模型名称",
        ));
    }
    let mut body = json!({"model":p.model,"stream":true});
    match p.protocol {
        ProtocolKind::ChatCompletions => {
            let mut messages: Vec<Value> = input
                .messages
                .iter()
                .map(|m| json!({"role":m.role,"content":content(&m.content,p.protocol)}))
                .collect();
            messages.extend(history_items(&input.history, p.protocol));
            if let Some(c) = &input.continuation {
                messages.extend(c.items.clone());
            }
            messages.extend(
                input
                    .tool_results
                    .iter()
                    .map(|r| json!({"role":"tool","tool_call_id":r.call_id,"content":r.output})),
            );
            body["messages"] = json!(messages);
            if !input.tools.is_empty() {
                body["tools"]=json!(input.tools.iter().map(|t|json!({"type":"function","function":{"name":t.name,"description":t.description,"parameters":t.parameters}})).collect::<Vec<_>>());
            }
            if p.capabilities.usage.supported == Some(true) {
                body["stream_options"] = json!({"include_usage":true});
            }
            if let Some(n) = p.options.max_output_tokens {
                body[match p.options.chat_token_parameter {
                    ChatTokenParameter::MaxCompletionTokens => "max_completion_tokens",
                    ChatTokenParameter::MaxTokens => "max_tokens",
                }] = json!(n);
            }
            if let Some(e) = &p.options.reasoning_effort {
                body["reasoning_effort"] = json!(e);
            }
        }
        ProtocolKind::Responses => {
            let mut items: Vec<Value> = input
                .messages
                .iter()
                .map(|m| json!({"role":m.role,"content":content(&m.content,p.protocol)}))
                .collect();
            items.extend(history_items(&input.history, p.protocol));
            if let Some(c) = &input.continuation {
                items.extend(c.items.clone());
            }
            items.extend(input.tool_results.iter().map(
                |r| json!({"type":"function_call_output","call_id":r.call_id,"output":r.output}),
            ));
            body["input"] = json!(items);
            body["store"] = json!(false);
            body["include"] = json!(["reasoning.encrypted_content"]);
            if !input.tools.is_empty() {
                body["tools"]=json!(input.tools.iter().map(|t|json!({"type":"function","name":t.name,"description":t.description,"parameters":t.parameters,"strict":false})).collect::<Vec<_>>());
            }
            if let Some(n) = p.options.max_output_tokens {
                body["max_output_tokens"] = json!(n);
            }
            if let Some(e) = &p.options.reasoning_effort {
                body["reasoning"] = json!({"effort":e});
            }
        }
        ProtocolKind::Messages => {
            let system: Vec<_> = input
                .messages
                .iter()
                .filter(|m| m.role == "system" || m.role == "developer")
                .map(|m| content(&m.content, p.protocol))
                .collect();
            if !system.is_empty() {
                body["system"] = json!(
                    system
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("\n")
                );
            }
            let mut messages: Vec<Value> = input
                .messages
                .iter()
                .filter(|m| m.role == "user" || m.role == "assistant")
                .map(|m| json!({"role":m.role,"content":content(&m.content,p.protocol)}))
                .collect();
            messages.extend(history_items(&input.history, p.protocol));
            if let Some(c) = &input.continuation {
                messages.push(json!({"role":"assistant","content":c.items}));
            }
            if !input.tool_results.is_empty() {
                messages.push(json!({"role":"user","content":input.tool_results.iter().map(|r|json!({"type":"tool_result","tool_use_id":r.call_id,"content":r.output,"is_error":r.is_error})).collect::<Vec<_>>()}));
            }
            body["messages"] = json!(messages);
            body["max_tokens"] = json!(p.options.max_output_tokens.unwrap_or(1024));
            if !input.tools.is_empty() {
                body["tools"]=json!(input.tools.iter().map(|t|json!({"name":t.name,"description":t.description,"input_schema":t.parameters})).collect::<Vec<_>>());
            }
        }
    }
    if let Some(temp) = p.options.temperature {
        body["temperature"] = json!(temp);
    }
    Ok(body)
}
fn history_items(history: &[ModelHistoryItem], protocol: ProtocolKind) -> Vec<Value> {
    let mut result = vec![];
    for item in history {
        match item {
            ModelHistoryItem::Message { message } => result
                .push(json!({"role":message.role,"content":content(&message.content,protocol)})),
            ModelHistoryItem::Exchange {
                continuation,
                tool_results,
            } => match protocol {
                ProtocolKind::ChatCompletions => {
                    result.extend(continuation.items.clone());
                    result.extend(tool_results.iter().map(
                        |r| json!({"role":"tool","tool_call_id":r.call_id,"content":r.output}),
                    ));
                }
                ProtocolKind::Responses => {
                    result.extend(continuation.items.clone());
                    result.extend(tool_results.iter().map(|r|json!({"type":"function_call_output","call_id":r.call_id,"output":r.output})));
                }
                ProtocolKind::Messages => {
                    result.push(json!({"role":"assistant","content":continuation.items}));
                    if !tool_results.is_empty() {
                        result.push(json!({"role":"user","content":tool_results.iter().map(|r|json!({"type":"tool_result","tool_use_id":r.call_id,"content":r.output,"is_error":r.is_error})).collect::<Vec<_>>()}));
                    }
                }
            },
        }
    }
    result
}
fn content(parts: &[ModelContent], protocol: ProtocolKind) -> Value {
    if parts.iter().all(|p| matches!(p, ModelContent::Text { .. })) {
        return json!(
            parts
                .iter()
                .filter_map(|p| match p {
                    ModelContent::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n")
        );
    }
    json!(parts.iter().map(|part|match part{
        ModelContent::Text{text}=>match protocol{ProtocolKind::Responses=>json!({"type":"input_text","text":text}),_=>json!({"type":"text","text":text})},
        ModelContent::Image{media_type,base64}=>match protocol{
            ProtocolKind::ChatCompletions=>json!({"type":"image_url","image_url":{"url":format!("data:{media_type};base64,{base64}")}}),
            ProtocolKind::Responses=>json!({"type":"input_image","image_url":format!("data:{media_type};base64,{base64}")}),
            ProtocolKind::Messages=>json!({"type":"image","source":{"type":"base64","media_type":media_type,"data":base64}}),
        }
    }).collect::<Vec<_>>())
}
pub fn estimate_usage(mut usage: Usage, pricing: Option<&ModelPricing>) -> Usage {
    if let (Some(price), Some(input), Some(output)) =
        (pricing, usage.input_tokens, usage.output_tokens)
    {
        let amount = (u128::from(input) * u128::from(price.input_microunits_per_million)
            + u128::from(output) * u128::from(price.output_microunits_per_million))
        .div_ceil(1_000_000);
        if amount <= u128::from(MAX_SAFE_SEQUENCE) {
            usage.cost_microunits = Some(amount as u64);
            usage.currency = Some(price.currency.clone());
        }
    }
    usage
}
