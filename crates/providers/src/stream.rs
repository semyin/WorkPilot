use crate::{
    config::{MAX_OUTPUT_BYTES, MAX_TOOL_ARGUMENT_BYTES},
    diagnostic::{Result, detail, error},
    sse::Frame,
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};
use workpilot_contracts::*;

#[derive(Default)]
struct Call {
    id: String,
    name: String,
    args: String,
    item_id: Option<String>,
    extra: Option<Value>,
}
pub struct Stream {
    protocol: ProtocolKind,
    text: String,
    response_id: Option<String>,
    model: Option<String>,
    reason: Option<String>,
    usage: Option<Value>,
    calls: BTreeMap<u64, Call>,
    items: BTreeMap<u64, Value>,
    open: HashSet<u64>,
    allowed: HashSet<String>,
    started: bool,
    ended: bool,
    reasoning: String,
}
pub struct Parsed {
    pub updates: Vec<ModelUpdate>,
    pub output: Option<ModelOutput>,
}
impl Stream {
    pub fn new(protocol: ProtocolKind, tools: &[ToolDefinition]) -> Self {
        Self {
            protocol,
            text: String::new(),
            response_id: None,
            model: None,
            reason: None,
            usage: None,
            calls: BTreeMap::new(),
            items: BTreeMap::new(),
            open: HashSet::new(),
            allowed: tools.iter().map(|t| t.name.clone()).collect(),
            started: false,
            ended: false,
            reasoning: String::new(),
        }
    }
    pub fn frame(&mut self, frame: Frame) -> Result<Parsed> {
        if self.ended {
            return Err(error(ModelErrorCode::MalformedStream));
        }
        if frame.data == "[DONE]" {
            if self.protocol != ProtocolKind::ChatCompletions {
                return Err(error(ModelErrorCode::MalformedStream));
            }
            return Ok(Parsed {
                updates: vec![],
                output: Some(self.complete(None)?),
            });
        }
        let value: Value = serde_json::from_str(&frame.data)
            .map_err(|_| error(ModelErrorCode::MalformedStream))?;
        if !frame.event.is_empty()
            && value["type"]
                .as_str()
                .is_some_and(|kind| kind != frame.event)
        {
            return Err(error(ModelErrorCode::MalformedStream));
        }
        if value.get("error").is_some_and(|e| !e.is_null())
            || value["type"] == "error"
            || value["type"] == "response.failed"
        {
            let message = value
                .pointer("/error/message")
                .or_else(|| value.pointer("/response/error/message"))
                .and_then(Value::as_str)
                .unwrap_or("provider stream error");
            return Err(detail(ModelErrorCode::Server, message));
        }
        let mut updates = vec![];
        let output = match self.protocol {
            ProtocolKind::ChatCompletions => {
                self.chat(&value, &mut updates)?;
                None
            }
            ProtocolKind::Responses => self.responses(&value, &mut updates)?,
            ProtocolKind::Messages => self.messages(&value, &mut updates)?,
        };
        Ok(Parsed { updates, output })
    }
    fn text(&mut self, text: &str, updates: &mut Vec<ModelUpdate>) -> Result<()> {
        if self.text.len() + text.len() > MAX_OUTPUT_BYTES {
            return Err(error(ModelErrorCode::Limit));
        }
        self.text.push_str(text);
        if !text.is_empty() {
            updates.push(ModelUpdate::Text(text.into()));
        }
        Ok(())
    }
    fn id(&mut self, value: Option<&str>) -> Result<()> {
        if let Some(value) = value {
            if value.is_empty() || value.len() > 512 {
                return Err(error(ModelErrorCode::MalformedStream));
            }
            if self.response_id.as_deref().is_some_and(|old| old != value) {
                return Err(error(ModelErrorCode::MalformedStream));
            }
            self.response_id = Some(value.into());
        }
        Ok(())
    }
    fn call(&mut self, index: u64) -> Result<&mut Call> {
        if self.calls.len() >= 64 && !self.calls.contains_key(&index) {
            return Err(error(ModelErrorCode::Limit));
        }
        Ok(self.calls.entry(index).or_default())
    }
    fn usage(&mut self, usage: &Value) -> Result<()> {
        if usage.is_null() {
            return Ok(());
        }
        if !usage.is_object() {
            return Err(error(ModelErrorCode::MalformedStream));
        }
        if self.usage.is_none() {
            self.usage = Some(json!({}));
        }
        for (key, value) in usage.as_object().unwrap() {
            self.usage.as_mut().unwrap()[key] = value.clone();
        }
        Ok(())
    }
    fn chat(&mut self, v: &Value, updates: &mut Vec<ModelUpdate>) -> Result<()> {
        self.started = true;
        self.id(v["id"].as_str())?;
        if let Some(model) = v["model"].as_str() {
            self.model = Some(model.into());
        }
        self.usage(&v["usage"])?;
        let choices = v["choices"]
            .as_array()
            .ok_or_else(|| error(ModelErrorCode::MalformedStream))?;
        if choices.len() > 1 {
            return Err(error(ModelErrorCode::Unsupported));
        }
        for choice in choices {
            if choice["index"].as_u64() != Some(0) {
                return Err(error(ModelErrorCode::Unsupported));
            }
            let delta = &choice["delta"];
            if self.reason.is_some() && delta.as_object().is_some_and(|m| !m.is_empty()) {
                return Err(detail(
                    ModelErrorCode::MalformedStream,
                    "Chat stream contained a delta after its finish marker",
                ));
            }
            if let Some(text) = delta["content"].as_str() {
                self.text(text, updates)?;
            }
            if let Some(text) = delta["refusal"].as_str() {
                self.text(text, updates)?;
            }
            if let Some(text) = delta["reasoning_content"].as_str() {
                if self.reasoning.len() + text.len() > MAX_OUTPUT_BYTES {
                    return Err(error(ModelErrorCode::Limit));
                }
                self.reasoning.push_str(text);
                updates.push(ModelUpdate::PublicReasoning(text.into()));
            }
            if let Some(calls) = delta["tool_calls"].as_array() {
                for value in calls {
                    let index = value["index"]
                        .as_u64()
                        .ok_or_else(|| error(ModelErrorCode::MalformedStream))?;
                    let call = self.call(index)?;
                    // Some compatible services emit empty identity placeholders
                    // on argument-only deltas. They do not replace a known ID.
                    if let Some(id) = value["id"].as_str().filter(|s| !s.is_empty()) {
                        set_identity(&mut call.id, id)?;
                    }
                    if let Some(name) = value
                        .pointer("/function/name")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                    {
                        set_identity(&mut call.name, name)?;
                    }
                    if let Some(args) = value.pointer("/function/arguments").and_then(Value::as_str)
                    {
                        append_args(call, args)?;
                    }
                    if let Some(extra) = value.get("extra_content") {
                        call.extra = Some(extra.clone());
                    }
                }
            }
            if let Some(reason) = choice["finish_reason"].as_str() {
                if self.reason.as_deref().is_some_and(|r| r != reason) {
                    return Err(error(ModelErrorCode::MalformedStream));
                }
                self.reason = Some(reason.into());
                if !["stop", "tool_calls"].contains(&reason) {
                    return Err(error(ModelErrorCode::Incomplete));
                }
            }
        }
        Ok(())
    }
    fn responses(
        &mut self,
        v: &Value,
        updates: &mut Vec<ModelUpdate>,
    ) -> Result<Option<ModelOutput>> {
        let kind = v["type"]
            .as_str()
            .ok_or_else(|| error(ModelErrorCode::MalformedStream))?;
        match kind {
            "response.created" => {
                if self.started {
                    return Err(error(ModelErrorCode::MalformedStream));
                }
                self.started = true;
                self.id(v.pointer("/response/id").and_then(Value::as_str))?;
            }
            "response.output_item.added" | "response.output_item.done" => {
                let index = index(v, "output_index")?;
                if self.items.len() >= 128 && !self.items.contains_key(&index) {
                    return Err(error(ModelErrorCode::Limit));
                }
                let item = &v["item"];
                if item["type"] == "function_call" {
                    let call = self.call(index)?;
                    set_identity(&mut call.id, string(item, "call_id")?)?;
                    set_identity(&mut call.name, string(item, "name")?)?;
                    call.item_id = item["id"].as_str().map(str::to_owned);
                    if kind.ends_with(".done") {
                        final_args(call, string(item, "arguments")?)?;
                    }
                }
                self.items.insert(index, item.clone());
            }
            "response.output_text.delta" => {
                self.text(string(v, "delta")?, updates)?;
            }
            "response.refusal.delta" => {
                self.text(string(v, "delta")?, updates)?;
            }
            "response.reasoning_summary_text.delta" => {
                updates.push(ModelUpdate::PublicReasoning(string(v, "delta")?.into()));
            }
            "response.function_call_arguments.delta" => {
                let call = self.call(index(v, "output_index")?)?;
                if call.id.is_empty() {
                    return Err(error(ModelErrorCode::MalformedStream));
                }
                if v["item_id"]
                    .as_str()
                    .is_some_and(|id| call.item_id.as_deref() != Some(id))
                {
                    return Err(error(ModelErrorCode::MalformedStream));
                }
                append_args(call, string(v, "delta")?)?;
            }
            "response.function_call_arguments.done" => {
                let call = self.call(index(v, "output_index")?)?;
                final_args(call, string(v, "arguments")?)?;
            }
            "response.incomplete" | "response.cancelled" => {
                return Err(error(ModelErrorCode::Incomplete));
            }
            "response.completed" => {
                if !self.started
                    || v.pointer("/response/status").and_then(Value::as_str) != Some("completed")
                {
                    return Err(error(ModelErrorCode::Incomplete));
                }
                let response = &v["response"];
                self.id(response["id"].as_str())?;
                self.model = response["model"].as_str().map(str::to_owned);
                self.usage(&response["usage"])?;
                let items = response["output"]
                    .as_array()
                    .ok_or_else(|| error(ModelErrorCode::MalformedStream))?;
                if items.len() > 128 {
                    return Err(error(ModelErrorCode::Limit));
                }
                let mut full_text = String::new();
                let mut present_calls = HashSet::new();
                for (index, item) in items.iter().enumerate() {
                    if item["type"] == "function_call" {
                        let call = self.call(index as u64)?;
                        set_identity(&mut call.id, string(item, "call_id")?)?;
                        set_identity(&mut call.name, string(item, "name")?)?;
                        call.item_id = item["id"].as_str().map(str::to_owned);
                        final_args(call, string(item, "arguments")?)?;
                        present_calls.insert(index as u64);
                    }
                    if let Some(parts) = item["content"].as_array() {
                        for part in parts {
                            if let Some(text) =
                                part["text"].as_str().or_else(|| part["refusal"].as_str())
                            {
                                full_text.push_str(text);
                            }
                        }
                    }
                }
                if self.calls.keys().any(|key| !present_calls.contains(key)) {
                    return Err(error(ModelErrorCode::MalformedStream));
                }
                if self.text.is_empty() {
                    self.text(&full_text, updates)?;
                } else if !full_text.is_empty() && self.text != full_text {
                    return Err(error(ModelErrorCode::MalformedStream));
                }
                self.reason = Some(
                    if self.calls.is_empty() {
                        "stop"
                    } else {
                        "tool_calls"
                    }
                    .into(),
                );
                return Ok(Some(self.complete(Some(items.clone()))?));
            }
            _ => {} // Forward-compatible lifecycle events do not imply completion.
        }
        Ok(None)
    }
    fn messages(
        &mut self,
        v: &Value,
        updates: &mut Vec<ModelUpdate>,
    ) -> Result<Option<ModelOutput>> {
        match string(v, "type")? {
            "message_start" => {
                if self.started {
                    return Err(error(ModelErrorCode::MalformedStream));
                }
                self.started = true;
                self.id(v.pointer("/message/id").and_then(Value::as_str))?;
                self.model = v
                    .pointer("/message/model")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                self.usage(&v["message"]["usage"])?;
            }
            "content_block_start" => {
                if !self.started {
                    return Err(error(ModelErrorCode::MalformedStream));
                }
                let index = index(v, "index")?;
                if self.items.contains_key(&index) || self.items.len() >= 128 {
                    return Err(error(ModelErrorCode::MalformedStream));
                }
                let block = &v["content_block"];
                match block["type"].as_str() {
                    Some("text") => {
                        if let Some(text) = block["text"].as_str() {
                            self.text(text, updates)?;
                        }
                    }
                    Some("tool_use") => {
                        let call = self.call(index)?;
                        set_identity(&mut call.id, string(block, "id")?)?;
                        set_identity(&mut call.name, string(block, "name")?)?;
                        if block["input"].as_object().is_some_and(|m| !m.is_empty()) {
                            call.args = block["input"].to_string();
                        }
                    }
                    Some("fallback") => {
                        return Err(detail(
                            ModelErrorCode::Unsupported,
                            "server-side model fallback was not requested",
                        ));
                    }
                    _ => {}
                }
                self.items.insert(index, block.clone());
                self.open.insert(index);
            }
            "content_block_delta" => {
                let index = index(v, "index")?;
                if !self.open.contains(&index) {
                    return Err(error(ModelErrorCode::MalformedStream));
                }
                let delta = &v["delta"];
                match string(delta, "type")? {
                    "text_delta" => {
                        let text = string(delta, "text")?;
                        let item = self.items.get_mut(&index).unwrap();
                        if item["type"] != "text" {
                            return Err(error(ModelErrorCode::MalformedStream));
                        }
                        add_string(item, "text", text)?;
                        self.text(text, updates)?;
                    }
                    "input_json_delta" => {
                        if !self.calls.contains_key(&index) {
                            return Err(error(ModelErrorCode::MalformedStream));
                        }
                        append_args(
                            self.calls.get_mut(&index).unwrap(),
                            string(delta, "partial_json")?,
                        )?;
                    }
                    "thinking_delta" => {
                        let text = string(delta, "thinking")?;
                        add_string(self.items.get_mut(&index).unwrap(), "thinking", text)?;
                        updates.push(ModelUpdate::PublicReasoning(text.into()));
                    }
                    "signature_delta" => add_string(
                        self.items.get_mut(&index).unwrap(),
                        "signature",
                        string(delta, "signature")?,
                    )?,
                    _ => {}
                }
            }
            "content_block_stop" => {
                let index = index(v, "index")?;
                if !self.open.remove(&index) {
                    return Err(error(ModelErrorCode::MalformedStream));
                }
                if let Some(call) = self.calls.get(&index) {
                    let args = arguments(call, &self.allowed)?;
                    self.items.get_mut(&index).unwrap()["input"] = args;
                }
            }
            "message_delta" => {
                if let Some(reason) = v["delta"]["stop_reason"].as_str() {
                    self.reason = Some(reason.into());
                }
                self.usage(&v["usage"])?;
            }
            "message_stop" => {
                if !self.started || !self.open.is_empty() {
                    return Err(error(ModelErrorCode::Incomplete));
                }
                if !self
                    .reason
                    .as_deref()
                    .is_some_and(|r| ["end_turn", "stop_sequence", "tool_use"].contains(&r))
                {
                    return Err(error(ModelErrorCode::Incomplete));
                }
                let items = self.items.values().cloned().collect();
                return Ok(Some(self.complete(Some(items))?));
            }
            "ping" => {}
            _ => {}
        }
        Ok(None)
    }
    fn complete(&mut self, items: Option<Vec<Value>>) -> Result<ModelOutput> {
        if !self.started || self.response_id.is_none() || self.reason.is_none() {
            return Err(error(ModelErrorCode::Incomplete));
        }
        let reason = self.reason.clone().unwrap();
        let tools_reason = ["tool_calls", "tool_use"].contains(&reason.as_str());
        if tools_reason == self.calls.is_empty() {
            return Err(detail(
                ModelErrorCode::MalformedStream,
                "Tool calls do not match the model finish reason",
            ));
        }
        let mut calls = vec![];
        let mut ids = HashSet::new();
        for call in self.calls.values() {
            if !ids.insert(&call.id) {
                return Err(error(ModelErrorCode::MalformedStream));
            }
            calls.push(ModelToolCall {
                id: call.id.clone(),
                name: call.name.clone(),
                arguments: arguments(call, &self.allowed)?,
                provider_item_id: call.item_id.clone(),
            });
        }
        let items=items.unwrap_or_else(||{
            let mut item=json!({"role":"assistant","content":if self.text.is_empty(){Value::Null}else{json!(self.text)}});
            if !self.reasoning.is_empty(){item["reasoning_content"]=json!(self.reasoning);}
            if !calls.is_empty(){item["tool_calls"]=json!(self.calls.values().map(|c|{
                let mut raw=json!({"id":c.id,"type":"function","function":{"name":c.name,"arguments":if c.args.is_empty(){"{}"}else{&c.args}}});
                if let Some(extra)=&c.extra{raw["extra_content"]=extra.clone();}raw
            }).collect::<Vec<_>>());}
            vec![item]
        });
        let raw = self.usage.clone();
        let input = count(
            raw.as_ref(),
            if self.protocol == ProtocolKind::ChatCompletions {
                "prompt_tokens"
            } else {
                "input_tokens"
            },
        )?;
        let output = count(
            raw.as_ref(),
            if self.protocol == ProtocolKind::ChatCompletions {
                "completion_tokens"
            } else {
                "output_tokens"
            },
        )?;
        self.ended = true;
        Ok(ModelOutput {
            text: self.text.clone(),
            tool_calls: calls,
            continuation: ProviderContinuation {
                protocol: self.protocol,
                response_id: self.response_id.clone(),
                items,
            },
            finish_reason: reason,
            actual_model: self.model.clone(),
            usage: Usage {
                input_tokens: input,
                output_tokens: output,
                cost_microunits: None,
                currency: None,
            },
            raw_usage: raw,
        })
    }
}
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .ok_or_else(|| error(ModelErrorCode::MalformedStream))
}
fn index(value: &Value, key: &str) -> Result<u64> {
    value[key]
        .as_u64()
        .filter(|n| *n < 1024)
        .ok_or_else(|| error(ModelErrorCode::MalformedStream))
}
fn set_identity(current: &mut String, value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 512 {
        return Err(error(ModelErrorCode::MalformedStream));
    }
    if !current.is_empty() && current != value {
        return Err(detail(
            ModelErrorCode::MalformedStream,
            "A streamed tool identity changed during the response",
        ));
    }
    *current = value.into();
    Ok(())
}
fn append_args(call: &mut Call, delta: &str) -> Result<()> {
    if call.args.len() + delta.len() > MAX_TOOL_ARGUMENT_BYTES {
        return Err(error(ModelErrorCode::Limit));
    }
    call.args.push_str(delta);
    Ok(())
}
fn final_args(call: &mut Call, full: &str) -> Result<()> {
    if call.args.is_empty() {
        append_args(call, full)
    } else if call.args != full {
        Err(error(ModelErrorCode::MalformedStream))
    } else {
        Ok(())
    }
}
fn arguments(call: &Call, allowed: &HashSet<String>) -> Result<Value> {
    if call.id.is_empty() {
        return Err(detail(
            ModelErrorCode::MalformedStream,
            "The tool call has no identifier",
        ));
    }
    if !allowed.contains(&call.name) {
        return Err(detail(
            ModelErrorCode::MalformedStream,
            "The model requested a tool that was not advertised",
        ));
    }
    let args = serde_json::from_str::<Value>(if call.args.is_empty() {
        "{}"
    } else {
        &call.args
    })
    .map_err(|_| {
        detail(
            ModelErrorCode::MalformedStream,
            "The streamed tool arguments are not complete JSON",
        )
    })?;
    if !args.is_object() {
        return Err(error(ModelErrorCode::MalformedStream));
    }
    Ok(args)
}
fn add_string(item: &mut Value, key: &str, text: &str) -> Result<()> {
    let old = item[key].as_str().unwrap_or_default();
    if old.len() + text.len() > MAX_OUTPUT_BYTES {
        return Err(error(ModelErrorCode::Limit));
    }
    item[key] = json!(format!("{old}{text}"));
    Ok(())
}
fn count(raw: Option<&Value>, key: &str) -> Result<Option<u64>> {
    match raw.and_then(|v| v.get(key)) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .filter(|n| *n <= MAX_SAFE_SEQUENCE)
            .map(Some)
            .ok_or_else(|| error(ModelErrorCode::MalformedStream)),
    }
}
