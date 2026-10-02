use serde::Deserialize;
use serde_json::{Value, json};
use workpilot_contracts::*;

pub enum Action {
    Lookup { key: String },
    Calculate { operation: String, values: Vec<f64> },
    Read { name: String },
    Write { name: String, content: String },
    Wait { milliseconds: u64 },
    Ask(InputQuestion),
    Plan(Vec<PlanStep>),
    Inspect { step_id: String },
}
fn definition(
    name: &str,
    description: &str,
    properties: Value,
    required: &[&str],
) -> ToolDefinition {
    ToolDefinition {
        name: name.into(),
        description: description.into(),
        parameters: json!({"type":"object","properties":properties,"required":required,"additionalProperties":false}),
    }
}
pub fn definitions(mode: WorkMode, controlled: bool) -> Vec<ToolDefinition> {
    let mut tools = vec![
        definition(
            "ask_user",
            "Ask the user for missing information and pause.",
            json!({"question":{"type":"string"},"choices":{"type":"array","items":{"type":"string"}}}),
            &["question", "choices"],
        ),
        definition(
            "update_plan",
            "Publish or update ordered plan steps. In plan mode this pauses for user confirmation. Status is pending, running or done.",
            json!({"steps":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"text":{"type":"string"},"status":{"type":"string","enum":["pending","running","done"]}},"required":["id","text","status"],"additionalProperties":false}}}),
            &["steps"],
        ),
        definition(
            "inspect_history",
            "Read a complete saved result by the step_id cited in the history summary. Only this task's own history is accessible.",
            json!({"step_id":{"type":"string"}}),
            &["step_id"],
        ),
    ];
    if controlled {
        tools.extend([
            definition("sample_lookup","Read fixed synthetic data. Keys: numbers returns [4,8,12]; words returns [alpha,beta,gamma].",json!({"key":{"type":"string","enum":["numbers","words"]}}),&["key"]),
            definition("sample_calculate","Calculate the sum or product of finite numbers; no file access.",json!({"operation":{"type":"string","enum":["sum","product"]},"values":{"type":"array","items":{"type":"number"}}}),&["operation","values"]),
            definition("sample_read","Read a previously saved synthetic sample in this task only.",json!({"name":{"type":"string"}}),&["name"]),
            definition("sample_wait","Wait up to 30 seconds to exercise stop and steering controls.",json!({"milliseconds":{"type":"integer","minimum":0,"maximum":30000}}),&["milliseconds"]),
        ]);
        if mode == WorkMode::Execute {
            tools.push(definition("sample_write","Save synthetic text in this task's internal test area. Does not create a real project file.",json!({"name":{"type":"string"},"content":{"type":"string"}}),&["name","content"]));
        }
    }
    tools
}
pub fn parse(
    call: &ModelToolCall,
    mode: WorkMode,
    controlled: bool,
) -> Result<Action, &'static str> {
    if !definitions(mode, controlled)
        .iter()
        .any(|t| t.name == call.name)
    {
        return Err("This tool is not permitted in the current work mode.");
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Lookup {
        key: String,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Calc {
        operation: String,
        values: Vec<f64>,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Read {
        name: String,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Write {
        name: String,
        content: String,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Wait {
        milliseconds: u64,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Ask {
        question: String,
        choices: Vec<String>,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Plan {
        steps: Vec<PlanStep>,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Inspect {
        step_id: String,
    }
    let invalid = "Tool arguments do not match the declared shape or size limits.";
    fn decode<T: serde::de::DeserializeOwned>(v: &Value) -> Result<T, &'static str> {
        serde_json::from_value(v.clone())
            .map_err(|_| "Tool arguments do not match the declared shape.")
    }
    Ok(match call.name.as_str() {
        "sample_lookup" => {
            let a: Lookup = decode(&call.arguments)?;
            if !["numbers", "words"].contains(&a.key.as_str()) {
                return Err(invalid);
            }
            Action::Lookup { key: a.key }
        }
        "sample_calculate" => {
            let a: Calc = decode(&call.arguments)?;
            if !["sum", "product"].contains(&a.operation.as_str())
                || a.values.is_empty()
                || a.values.len() > 1024
                || a.values.iter().any(|v| !v.is_finite())
            {
                return Err(invalid);
            }
            Action::Calculate {
                operation: a.operation,
                values: a.values,
            }
        }
        "sample_read" => {
            let a: Read = decode(&call.arguments)?;
            if a.name.is_empty() || a.name.len() > 128 {
                return Err(invalid);
            }
            Action::Read { name: a.name }
        }
        "sample_write" => {
            let a: Write = decode(&call.arguments)?;
            if a.name.is_empty() || a.name.len() > 128 || a.content.len() > 16_384 {
                return Err(invalid);
            }
            Action::Write {
                name: a.name,
                content: a.content,
            }
        }
        "sample_wait" => {
            let a: Wait = decode(&call.arguments)?;
            if a.milliseconds > 30_000 {
                return Err(invalid);
            }
            Action::Wait {
                milliseconds: a.milliseconds,
            }
        }
        "ask_user" => {
            let a: Ask = decode(&call.arguments)?;
            if a.question.is_empty()
                || a.question.len() > 4096
                || a.choices.len() > 8
                || a.choices.iter().any(|s| s.len() > 512)
            {
                return Err(invalid);
            }
            Action::Ask(InputQuestion {
                text: a.question,
                choices: a.choices,
                plan_confirmation: false,
            })
        }
        "update_plan" => {
            let a: Plan = decode(&call.arguments)?;
            let ids: std::collections::HashSet<_> = a.steps.iter().map(|s| &s.id).collect();
            if a.steps.is_empty()
                || a.steps.len() > 32
                || ids.len() != a.steps.len()
                || a.steps
                    .iter()
                    .any(|s| !valid_id(&s.id) || s.text.is_empty() || s.text.len() > 512)
            {
                return Err(invalid);
            }
            Action::Plan(a.steps)
        }
        "inspect_history" => {
            let a: Inspect = decode(&call.arguments)?;
            if !valid_id(&a.step_id) {
                return Err(invalid);
            }
            Action::Inspect { step_id: a.step_id }
        }
        _ => return Err(invalid),
    })
}
