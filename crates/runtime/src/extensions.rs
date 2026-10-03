use super::*;
use serde_json::Value;
impl<B: ModelBackend + Send + Sync, F: FaultObserver> ExecutionEnvironment<B, F> {
    pub(crate) async fn extension_tool(
        &self,
        snapshot: &ExecutionSnapshot,
        action_id: &str,
        call: &ModelToolCall,
    ) -> Result<Option<End>> {
        let task = snapshot.task.id.clone();
        let result:std::result::Result<Value,String>=async {
            let client=self.workbench.as_ref().ok_or("扩展工作区不可用。")?;
            match call.name.as_str(){
                "skill_search"=>{
                    #[derive(serde::Deserialize)] #[serde(deny_unknown_fields)] struct Input{query:Option<String>}
                    let input:Input=serde_json::from_value(call.arguments.clone()).map_err(|_|"搜索参数无效。")?;
                    let mut v=client.extensions(Some(task.clone()),ExtensionAdmin::Catalog{query:input.query}).await?;
                    v.as_object_mut().ok_or("无效目录。")?.remove("previews"); v.as_object_mut().unwrap().remove("history");
                    if let Some(items)=v["items"].as_array_mut(){items.retain(|i|i["installation"]["enabled"]==true);for i in items{ i["version"].as_object_mut().unwrap().remove("files"); }}
                    return Ok(v);
                }
                "skill_read"=>{
                    #[derive(serde::Deserialize)] #[serde(deny_unknown_fields)] struct Input{installation_id:String,revision:u32,path:String}
                    let i:Input=serde_json::from_value(call.arguments.clone()).map_err(|_|"资源参数无效。")?;
                    let v=client.extensions(Some(task.clone()),ExtensionAdmin::ReadResource{installation_id:i.installation_id,revision:i.revision,path:i.path}).await?;
                    if v["enabled"]==false{return Err("技能已停用。".into());}return Ok(v);
                }
                "skill_draft"=>{
                    if snapshot.task.mode==WorkMode::Chat{return Err("切换到规划或执行模式后再创建草稿。".into());}
                    #[derive(serde::Deserialize)] #[serde(deny_unknown_fields)] struct Input{project:bool,files:Vec<SkillDraftFile>}
                    let i:Input=serde_json::from_value(call.arguments.clone()).map_err(|_|"草稿参数无效。")?;
                    return client.skill_draft(&task,action_id,i.project,i.files).await;
                }
                _=>{}
            }
            if snapshot.task.mode!=WorkMode::Execute{return Err("当前模式不允许调用外部工具。".into());}
            let mut existing=client.operation(&task,action_id).await.ok();
            if existing.is_none(){
                let effect=client.extension_input(&task,&call.name,call.arguments.clone()).await?;
                let v=client.request(task.clone(),action_id.into(),WorkbenchAction::Extension{effect}).await?;
                existing=Some(serde_json::from_value(v["operation"].clone()).map_err(|_|"扩展操作记录不可用。")?);
            }
            let mut op=existing.ok_or("扩展记录不可用。")?;
            if op.state=="awaiting_approval"{return Ok(json!({"awaiting_extension_approval":true}));}
            while matches!(op.state.as_str(),"queued"|"running"|"stopping") {
                tokio::select!{_=self.signals.stop.cancelled()=>{let _=client.request(task.clone(),format!("extension-stop-{action_id}"),WorkbenchAction::Stop{operation_id:op.id}).await;return Err("扩展操作已停止，不会自动重跑。".into());},_=tokio::time::sleep(Duration::from_millis(80))=>{}}
                op=client.operation(&task,action_id).await?;
            }
            if op.state=="failed"&&op.output.is_some(){return client.result(&op).await;}
            if op.state!="completed"{return Err(op.error.unwrap_or_else(||"扩展操作未完成；不会自动重跑。".into()));}
            client.result(&op).await
        }.await;
        match result {
            Ok(v) if v["awaiting_extension_approval"] == true => Ok(Some(End {
                state: TaskState::AwaitingApproval,
                reason: "awaiting_extension_approval",
            })),
            Ok(v) => {
                let failed = v["failed"] == true;
                self.real_result(action_id, call, v, failed).await?;
                Ok(None)
            }
            Err(message) => {
                self.real_result(
                    action_id,
                    call,
                    json!({"error":message,"automatic_retry":false}),
                    true,
                )
                .await?;
                Ok(None)
            }
        }
    }
}
