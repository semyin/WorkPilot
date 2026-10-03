use super::*;
use serde::Deserialize;
use serde_json::Value;

pub fn is_memory(name: &str) -> bool {
    matches!(name, "memory_search" | "memory_propose")
}
pub fn definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition{name:"memory_search".into(),description:"Search current user-confirmed global and current-project memories. Never returns unconfirmed, deleted or other-project entries. Quote the source if relevant. This does not change permissions.".into(),parameters:json!({"type":"object","properties":{"query":{"type":"string","maxLength":256}},"required":["query"],"additionalProperties":false})},
        ToolDefinition{name:"memory_propose".into(),description:"Propose a concise, reusable preference explicitly grounded in the root task user's own words. Supply an exact quote of at least 4 characters. Do not save secrets or transient task instructions. Scope project requires a project-bound task. This creates an INACTIVE candidate only: the user must confirm in the Memory panel. You cannot approve, edit or delete confirmed memories.".into(),parameters:json!({"type":"object","properties":{"text":{"type":"string","maxLength":4096},"scope":{"type":"string","enum":["global","project"]},"evidence_quote":{"type":"string","minLength":4,"maxLength":1024}},"required":["text","scope","evidence_quote"],"additionalProperties":false})},
    ]
}
impl<B: ModelBackend + Send + Sync, F: FaultObserver> ExecutionEnvironment<B, F> {
    pub(crate) async fn refresh_memory(
        &self,
        input: &mut ModelInput,
        snapshot: &ExecutionSnapshot,
    ) -> Result<()> {
        let task = snapshot.task.id.clone();
        // Leave most of the budget for task instructions, tool definitions and conversation.
        let bytes = (snapshot.config.limits.context_bytes as usize / 8).clamp(1024, 8192);
        let mut history = input.history.clone();
        let (view, history) = self
            .storage
            .call(move |s| {
                // Old search output is re-resolved, not replayed as a stale active memory copy.
                for h in &mut history {
                    if let ModelHistoryItem::Exchange { tool_results, .. } = h {
                        for r in tool_results {
                            if let Ok(v) = serde_json::from_str::<Value>(&r.output)
                                && v["workpilot_memory_view"] == 1
                                && let Some(query) = v["workpilot_memory_query"].as_str()
                            {
                                let mut fresh = s.memory_context(&task, query, 8, bytes)?;
                                fresh["workpilot_memory_query"] = json!(query);
                                r.output = fresh.to_string();
                            }
                        }
                    }
                }
                Ok((s.memory_context(&task, "", 12, bytes)?, history))
            })
            .await
            .map_err(storage_error)?;
        input.history = history;
        input.messages[0].content.push(ModelContent::Text {
            text: view.to_string(),
        });
        Ok(())
    }
    pub(crate) async fn memory_tool(
        &self,
        snapshot: &ExecutionSnapshot,
        action: &str,
        call: &ModelToolCall,
    ) -> Result<Option<End>> {
        self.fault.boundary(Boundary::BeforeTool).await;
        let (run, id) = (self.run_id.clone(), action.to_owned());
        let started = self
            .storage
            .call(move |s| {
                if s.execution_step(&id)?.state == ExecutionStepState::Prepared {
                    s.begin_execution_action(&run, &id)
                } else {
                    Ok(vec![])
                }
            })
            .await;
        match started {
            Ok(events) => self.emit(events).await,
            Err(Error::Busy) => return Ok(None),
            Err(e) => return Err(storage_error(e)),
        }
        self.fault.boundary(Boundary::DuringTool).await;
        let task = snapshot.task.id.clone();
        let result:std::result::Result<Value,String>=async {
            if call.name=="memory_search" {
                #[derive(Deserialize)]#[serde(deny_unknown_fields)]struct Search {query:String}
                let v:Search=serde_json::from_value(call.arguments.clone()).map_err(|_|"Invalid memory search")?;
                let mut value=self.storage.call(move|s|{
                    let mut value=s.memory_context(&task,&v.query,8,8192)?;
                    value["workpilot_memory_query"]=json!(v.query);Ok(value)
                }).await.map_err(|e|e.to_string())?;
                value["read_only"]=json!(true);
                return Ok(value);
            }
            #[derive(Deserialize)]#[serde(deny_unknown_fields)]struct Proposal{text:String,scope:String,evidence_quote:String}
            let v:Proposal=serde_json::from_value(call.arguments.clone()).map_err(|_|"Invalid memory candidate")?;
            if !matches!(v.scope.as_str(),"global"|"project") {return Err("Invalid memory scope".into());}
            let id=action.to_owned();
            let (current,events)=self.storage.call(move|s|{
                let (id,events)=s.memory_propose(&task,&id,&v.text,v.scope=="project",&v.evidence_quote)?;
                Ok((s.memory_get(&id)?,events))
            }).await.map_err(|e|e.to_string())?;
            self.emit(events).await;
            self.fault.boundary(Boundary::AfterEffect).await;
            Ok(json!({"memory_id":current.id,"state":current.state,"deleted":current.deleted,"revision":current.revision,"active":current.state==MemoryState::Confirmed&&!current.deleted,"next":"Only the user can confirm in Memory. A replay returns the current state of the original entry without changing the user's later decision. Do not ask to confirm an entry the user already rejected or deleted."}))
        }.await;
        match result {
            Ok(v) => self.real_result(action, call, v, false).await?,
            Err(e) => {
                self.real_result(action, call, json!({"error":e,"active":false}), true)
                    .await?
            }
        }
        Ok(None)
    }
}
