use super::*;
use serde_json::{Value, json};
impl<B: ModelBackend + Send + Sync, F: FaultObserver> ExecutionEnvironment<B, F> {
    pub(crate) async fn media_tool(
        &self,
        snapshot: &ExecutionSnapshot,
        action_id: &str,
        call: &ModelToolCall,
    ) -> Result<Option<End>> {
        let task = snapshot.task.id.clone();
        let result:std::result::Result<Value,String>=async{
            let client=self.workbench.as_ref().ok_or("文件成果工作区不可用 / File workspace unavailable")?;
            let delivered=workpilot_workbench::media::model::references(&snapshot.context);
            if call.name=="document_list" {
                #[derive(serde::Deserialize)]#[serde(deny_unknown_fields)]struct Range{start:Option<usize>,limit:Option<usize>}
                let range:Range=serde_json::from_value(call.arguments.clone()).map_err(|_|"Invalid attachment page")?;let start=range.start.unwrap_or(0);let limit=range.limit.unwrap_or(16);if !(1..=32).contains(&limit){return Err("Invalid attachment page size".into());}
                let all=client.media_assets(&task,&delivered).await?;if start>all.len(){return Err("Attachment page out of range".into());}
                let assets=all.iter().skip(start).take(limit).map(|a|json!({"id":a.id,"name":a.name,"media_type":a.media_type,"units":a.units,"image":a.image,"path":a.path,"sha256":a.sha256})).collect::<Vec<_>>();
                return Ok(json!({"assets":assets,"total":all.len(),"next":if start+limit<all.len(){Some(start+limit)}else{None}}));
            }
            if call.name=="image_services" {return client.media(None,MediaAdmin::ImageServices).await;}
            if call.name=="document_read" {
                #[derive(serde::Deserialize)]#[serde(deny_unknown_fields)]struct Input{asset_id:String,start:u32,limit:u32}
                let i:Input=serde_json::from_value(call.arguments.clone()).map_err(|_|"Invalid document range")?;
                let value=client.media(Some(task),MediaAdmin::Read{asset_id:i.asset_id.clone(),start:i.start,limit:i.limit}).await?;
                if matches!(value["asset"]["source"].as_str(),Some("file"|"drop"|"paste"))&&!delivered.contains(&format!("[workpilot-file:{}]",i.asset_id)){return Err("此附件尚未随用户消息交付 / Attachment has not been delivered in a user message".into());}
                return Ok(value);
            }
            if call.name=="document_import" {
                #[derive(serde::Deserialize)]#[serde(deny_unknown_fields)]struct Input{path:String}
                let i:Input=serde_json::from_value(call.arguments.clone()).map_err(|_|"Invalid document path")?;
                let file=client.request(task.clone(),format!("read-{action_id}"),WorkbenchAction::ReadFile{path:i.path.clone()}).await?;
                let expected=serde_json::from_value(file["version"].clone()).map_err(|_|"Missing file version")?;
                return client.request(task,action_id.into(),WorkbenchAction::ReadDocument{path:i.path,expected}).await;
            }
            if snapshot.task.mode!=WorkMode::Execute{return Err("当前模式不能生成文件或图片 / Switch to Execute to generate files or images".into());}
            let mut existing=client.operation(&task,action_id).await.ok();
            if existing.is_none(){
                let effect=if call.name=="document_create" {
                    #[derive(serde::Deserialize)]#[serde(deny_unknown_fields)]struct Input{path:String,expected_sha256:Option<String>,format:String,recipe:Value}
                    let i:Input=serde_json::from_value(call.arguments.clone()).map_err(|_|"Invalid document recipe")?;
                    let file=client.request(task.clone(),format!("read-{action_id}"),WorkbenchAction::ReadFile{path:i.path.clone()}).await?;
                    let expected:FileVersion=serde_json::from_value(file["version"].clone()).map_err(|_|"Missing file version")?;
                    if expected.sha256!=i.expected_sha256||expected.exists!=i.expected_sha256.is_some(){return Err("文件已改变；请读取当前版本再生成 / Output changed; read the current version first".into());}
                    MediaEffect::CreateDocument{path:i.path,format:i.format,expected,recipe:i.recipe}
                } else {
                    #[derive(serde::Deserialize)]#[serde(deny_unknown_fields)]struct Input{service_id:String,service_revision:u32,prompt:String,size:String,quality:Option<String>,format:String,references:Vec<String>,paths:Vec<String>}
                    let i:Input=serde_json::from_value(call.arguments.clone()).map_err(|_|"Invalid image request")?;
                    let assets=client.media_assets(&task,&delivered).await?;
                    if i.references.iter().any(|id|!assets.iter().any(|a|&a.id==id)){return Err("参考图尚未交付给当前任务 / Reference image is not available in this task".into());}
                    let mut expected=vec![];for path in &i.paths{let file=client.request(task.clone(),format!("image-path-{action_id}-{}",expected.len()),WorkbenchAction::ReadFile{path:path.clone()}).await?;let version:FileVersion=serde_json::from_value(file["version"].clone()).map_err(|_|"Missing file version")?;if version.exists{return Err("图片输出路径已存在，请选择新名称 / Image output already exists; choose a new name".into());}expected.push(version);}
                    MediaEffect::GenerateImage{request:ImageRequest{service_id:i.service_id,service_revision:i.service_revision,prompt:i.prompt,size:i.size,quality:i.quality,format:i.format,count:i.paths.len() as u32,references:i.references,paths:i.paths,expected}}
                };
                let v=client.request(task.clone(),action_id.into(),WorkbenchAction::Media{effect}).await?;
                existing=Some(serde_json::from_value(v["operation"].clone()).map_err(|_|"Missing media operation")?);
            }
            let mut op=existing.ok_or("Missing media operation")?;
            if op.state=="awaiting_approval"{return Ok(json!({"awaiting_media_approval":true}));}
            while matches!(op.state.as_str(),"queued"|"running"|"stopping"){
                tokio::select!{_=self.signals.stop.cancelled()=>{let _=client.request(task.clone(),format!("media-stop-{action_id}"),WorkbenchAction::Stop{operation_id:op.id}).await;return Err("文件或图片生成已停止；不会自动重跑 / Generation stopped; no automatic retry".into());},_=tokio::time::sleep(Duration::from_millis(80))=>{}}
                op=client.operation(&task,action_id).await?;
            }
            if op.state!="completed"{return Err(op.error.unwrap_or_else(||"文件或图片生成未完成 / Generation was not completed".into()));}
            client.result(&op).await
        }.await;
        match result {
            Ok(v) if v["awaiting_media_approval"] == true => Ok(Some(End {
                state: TaskState::AwaitingApproval,
                reason: "awaiting_media_approval",
            })),
            Ok(v) => {
                self.real_result(action_id, call, v, false).await?;
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
                if call.name == "image_generate" {
                    Ok(Some(End {
                        state: TaskState::Failed,
                        reason: "image_service_error",
                    }))
                } else {
                    Ok(None)
                }
            }
        }
    }
}
