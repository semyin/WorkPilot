use sha2::{Digest, Sha256};
use std::collections::HashMap;
use tokio::{sync::mpsc, task::JoinHandle};
use tokio_util::sync::CancellationToken;
use workpilot_contracts::*;
use workpilot_platform::credentials::{CredentialStore, Secret, SystemCredentials};
use workpilot_providers::{HttpBackend, ModelBackend, config, diagnostic};
use workpilot_storage::{Error as StorageError, Storage};
use zeroize::Zeroizing;

pub enum Handled {
    No,
    Deferred,
    Reply(Box<Response>),
}
struct Job {
    cancel: CancellationToken,
    handle: JoinHandle<()>,
}
pub struct Models {
    storage: Storage,
    out: mpsc::Sender<Wire>,
    backend: HttpBackend,
    namespace: String,
    jobs: HashMap<String, Job>,
}
impl Models {
    pub fn new(
        storage: Storage,
        out: mpsc::Sender<Wire>,
        directory: &std::path::Path,
    ) -> Result<Self, &'static str> {
        Ok(Self {
            storage,
            out,
            backend: HttpBackend::new().map_err(|_| "HTTP client could not start")?,
            namespace: format!(
                "models-{:x}",
                Sha256::digest(directory.to_string_lossy().as_bytes())
            ),
            jobs: HashMap::new(),
        })
    }
    pub async fn dispatch(&mut self, request: &Request) -> Handled {
        self.jobs.retain(|_, job| !job.handle.is_finished());
        let result = match &request.command {
            Command::Read {
                query: Query::Profiles,
            } => Some(self.catalog().await),
            Command::Read {
                query: Query::ExportProfiles,
            } => Some(
                self.storage
                    .call(|s| s.export_profiles())
                    .await
                    .map(|bundle| Response::ProfileBundle { bundle })
                    .map_err(storage_error),
            ),
            Command::SaveProvider {
                profile,
                secret,
                clear_credential,
            } => Some(
                self.save(request, profile, secret.as_ref(), *clear_credential)
                    .await,
            ),
            Command::DeleteProvider {
                profile_id,
                expected_revision,
            } => Some(self.delete(request, profile_id, *expected_revision).await),
            Command::SetDefaultProfile { scope, profile_id } => {
                let (req, scope, p) = (request.clone(), scope.clone(), profile_id.clone());
                Some(
                    match self
                        .storage
                        .call(move |s| s.set_default_profile(&req, &scope, p.as_deref()))
                        .await
                    {
                        Ok(events) => {
                            emit(&self.out, events).await;
                            self.catalog().await
                        }
                        Err(e) => Err(storage_error(e)),
                    },
                )
            }
            Command::ImportProfiles { bundle } => {
                let validation = bundle
                    .profiles
                    .iter()
                    .try_for_each(config::validate_profile);
                if let Err(e) = validation {
                    Some(Err(e))
                } else {
                    let (req, bundle) = (request.clone(), bundle.clone());
                    Some(
                        match self
                            .storage
                            .call(move |s| s.import_profiles(&req, &bundle))
                            .await
                        {
                            Ok(events) => {
                                emit(&self.out, events).await;
                                self.catalog().await
                            }
                            Err(e) => Err(storage_error(e)),
                        },
                    )
                }
            }
            Command::StartModelProbe {
                profile_id,
                task_id,
                agent_id,
                mode,
                prompt,
            } => Some(
                self.start(
                    request,
                    profile_id.as_deref(),
                    task_id.as_deref(),
                    agent_id.as_deref(),
                    *mode,
                    prompt,
                )
                .await,
            ),
            Command::CancelModelProbe { call_id } => Some(self.cancel(request, call_id).await),
            Command::ProviderModels { profile_id } => {
                if self.jobs.len() >= 4 {
                    Some(Err(diagnostic::detail(
                        ModelErrorCode::Limit,
                        "同时最多进行 4 次模型连接操作",
                    )))
                } else {
                    let id = profile_id.clone();
                    match self
                        .storage
                        .call(move |s| s.profile_with_observations(&id))
                        .await
                    {
                        Err(e) => Some(Err(storage_error(e))),
                        Ok(p) => {
                            let (backend, storage, out, namespace, request_id) = (
                                self.backend.clone(),
                                self.storage.clone(),
                                self.out.clone(),
                                self.namespace.clone(),
                                request.request_id.clone(),
                            );
                            let cancel = CancellationToken::new();
                            let token = cancel.clone();
                            let handle = tokio::spawn(async move {
                                let response = match secret_for(&namespace, &p, &storage).await {
                                    Ok(secret) => {
                                        match backend.models(&p, secret.as_ref(), &token).await {
                                            Ok((models, has_more)) => {
                                                Response::Models { models, has_more }
                                            }
                                            Err(diagnostic) => Response::ModelError { diagnostic },
                                        }
                                    }
                                    Err(diagnostic) => Response::ModelError { diagnostic },
                                };
                                let _ = out
                                    .send(Wire::Reply {
                                        request_id,
                                        response,
                                    })
                                    .await;
                            });
                            self.jobs.insert(
                                format!("list-{}", request.request_id),
                                Job { cancel, handle },
                            );
                            return Handled::Deferred;
                        }
                    }
                }
            }
            _ => None,
        };
        match result {
            None => Handled::No,
            Some(Ok(response)) => Handled::Reply(Box::new(response)),
            Some(Err(diagnostic)) => Handled::Reply(Box::new(Response::ModelError { diagnostic })),
        }
    }
    async fn catalog(&self) -> std::result::Result<Response, ModelDiagnostic> {
        let (profiles, global_default) = self
            .storage
            .call(|s| Ok((s.profiles()?, s.global_profile()?)))
            .await
            .map_err(storage_error)?;
        let profiles = profiles.into_iter().map(view).collect();
        Ok(Response::Profiles {
            catalog: ProfileCatalog {
                profiles,
                global_default,
            },
        })
    }
    async fn save(
        &self,
        request: &Request,
        profile: &ProviderProfile,
        secret_input: Option<&SecretInput>,
        clear: bool,
    ) -> std::result::Result<Response, ModelDiagnostic> {
        config::validate_profile(profile)?;
        let req = request.clone();
        if let Some(receipt) = self
            .storage
            .call(move |s| s.cached_receipt(&req))
            .await
            .map_err(storage_error)?
        {
            return Ok(Response::Receipt { receipt });
        }
        let id = profile.id.clone();
        let old = self
            .storage
            .call(move |s| match s.profile(&id) {
                Ok(p) => Ok(Some(p)),
                Err(StorageError::NotFound) => Ok(None),
                Err(e) => Err(e),
            })
            .await
            .map_err(storage_error)?;
        let mut profile = profile.clone();
        // The client cannot point us at arbitrary entries in the system credential store.
        profile.credential = old.as_ref().and_then(|p| p.credential.clone());
        if clear {
            profile.credential = None;
        }
        let mut new_reference = None;
        if let Some(input) = secret_input {
            if config::effective_auth(&profile) == AuthMode::None {
                return Err(diagnostic::detail(
                    ModelErrorCode::Configuration,
                    "选择无需密钥时，不应填写密钥",
                ));
            }
            let secret = Secret::new(input.0.clone())
                .map_err(|_| diagnostic::error(ModelErrorCode::Authentication))?;
            let masked = Zeroizing::new(secret.expose().to_owned());
            self.storage
                .call(move |s| s.register_secret(masked.as_str()))
                .await
                .map_err(storage_error)?;
            let reference = CredentialRef {
                id: uuid::Uuid::new_v4().to_string(),
            };
            let namespace = self.namespace.clone();
            let target = reference.clone();
            tokio::task::spawn_blocking(move || {
                SystemCredentials::new(&namespace)?.put(&target, &secret)
            })
            .await
            .map_err(|_| diagnostic::error(ModelErrorCode::Authentication))?
            .map_err(|_| {
                diagnostic::detail(
                    ModelErrorCode::Authentication,
                    "系统凭据库未能保存密钥，配置没有写入",
                )
            })?;
            profile.credential = Some(reference.clone());
            new_reference = Some(reference);
        }
        let (req, to_save) = (request.clone(), profile.clone());
        let committed = self
            .storage
            .call(move |s| s.commit_profile(&req, to_save))
            .await;
        if let Err(e) = committed {
            if let Some(reference) = new_reference {
                let _ = remove_secret(&self.namespace, reference).await;
            }
            return Err(storage_error(e));
        }
        emit(&self.out, committed.unwrap()).await;
        if let Some(previous) = old.and_then(|p| p.credential)
            && profile.credential.as_ref() != Some(&previous)
        {
            // A failed cleanup does not roll back a configuration already committed.
            if remove_secret(&self.namespace, previous).await.is_err() {
                return Err(diagnostic::detail(
                    ModelErrorCode::Authentication,
                    "新配置已保存，但旧凭据未能清理；请稍后重新打开设置核对",
                ));
            }
        }
        let id = profile.id;
        Ok(Response::ProviderSaved {
            profile: Box::new(view(
                self.storage
                    .call(move |s| s.profile_with_observations(&id))
                    .await
                    .map_err(storage_error)?,
            )),
        })
    }
    async fn delete(
        &self,
        request: &Request,
        id: &str,
        revision: u32,
    ) -> std::result::Result<Response, ModelDiagnostic> {
        let (req, id) = (request.clone(), id.to_owned());
        let (reference, events) = self
            .storage
            .call(move |s| s.delete_profile(&req, &id, revision))
            .await
            .map_err(storage_error)?;
        emit(&self.out, events).await;
        if let Some(reference) = reference {
            remove_secret(&self.namespace, reference).await?;
        }
        self.catalog().await
    }
    async fn start(
        &mut self,
        request: &Request,
        profile: Option<&str>,
        task: Option<&str>,
        agent: Option<&str>,
        mode: ModelProbeMode,
        prompt: &str,
    ) -> std::result::Result<Response, ModelDiagnostic> {
        let req = request.clone();
        if self
            .storage
            .call(move |s| s.cached_receipt(&req))
            .await
            .map_err(storage_error)?
            .is_some()
        {
            let id = request.request_id.clone();
            return Ok(Response::ModelStarted {
                call: Box::new(
                    self.storage
                        .call(move |s| s.model_call_for_request(&id))
                        .await
                        .map_err(storage_error)?,
                ),
                duplicate: true,
            });
        }
        if self.jobs.len() >= 4 {
            return Err(diagnostic::detail(
                ModelErrorCode::Limit,
                "同时最多进行 4 次模型连接操作",
            ));
        }
        let (profile, task, agent) = (
            profile.map(str::to_owned),
            task.map(str::to_owned),
            agent.map(str::to_owned),
        );
        let task_for_resolve = task.clone();
        let p = self
            .storage
            .call(move |s| {
                s.resolve_profile(
                    task_for_resolve.as_deref(),
                    agent.as_deref(),
                    profile.as_deref(),
                )
            })
            .await
            .map_err(storage_error)?;
        config::validate_profile(&p)?;
        let input = probe_input(mode, prompt);
        config::request_body(&p, &input)?;
        let (req, saved) = (request.clone(), p.clone());
        let (call, duplicate, events) = self
            .storage
            .call(move |s| s.start_model_call(&req, &saved, mode, task.as_deref()))
            .await
            .map_err(storage_error)?;
        emit(&self.out, events).await;
        let call_id = call.id.clone();
        let cancel = CancellationToken::new();
        let token = cancel.clone();
        let (backend, storage, out, namespace) = (
            self.backend.clone(),
            self.storage.clone(),
            self.out.clone(),
            self.namespace.clone(),
        );
        let handle = tokio::spawn(async move {
            let secret = match secret_for(&namespace, &p, &storage).await {
                Ok(secret) => secret,
                Err(e) => {
                    persist_end(&storage, &out, &call_id, Err(e)).await;
                    return;
                }
            };
            if token.is_cancelled() {
                return;
            }
            let (sender, mut updates) = mpsc::channel(32);
            let future = backend.execute(p, input, secret, token.clone(), sender);
            tokio::pin!(future);
            let result = loop {
                tokio::select! {
                    biased;
                    update=updates.recv()=>{
                        if let Some(update)=update{
                            if !token.is_cancelled() && let Err(e)=persist_update(&storage,&out,&call_id,update).await {break Err(e);}
                        }else{break future.await;}
                    }
                    result=&mut future=>break result,
                }
            };
            while let Ok(update) = updates.try_recv() {
                if !token.is_cancelled()
                    && let Err(e) = persist_update(&storage, &out, &call_id, update).await
                {
                    persist_end(&storage, &out, &call_id, Err(e)).await;
                    return;
                }
            }
            if !token.is_cancelled() {
                persist_end(&storage, &out, &call_id, result).await;
            }
        });
        self.jobs.insert(call.id.clone(), Job { cancel, handle });
        Ok(Response::ModelStarted {
            call: Box::new(call),
            duplicate,
        })
    }
    async fn cancel(
        &mut self,
        request: &Request,
        call_id: &str,
    ) -> std::result::Result<Response, ModelDiagnostic> {
        let req = request.clone();
        let cached = self
            .storage
            .call(move |s| s.cached_receipt(&req))
            .await
            .map_err(storage_error)?;
        if let Some(receipt) = cached {
            return Ok(Response::Receipt { receipt });
        }
        if let Some(job) = self.jobs.get(call_id) {
            job.cancel.cancel();
        }
        let id = call_id.to_owned();
        let e = diagnostic::error(ModelErrorCode::Cancelled);
        let req = request.clone();
        let events = self
            .storage
            .call(move |s| s.cancel_model_call(&req, &id, e))
            .await;
        // Cancellation is idempotent; a finished call stays in its actual terminal state.
        match events {
            Ok(events) => emit(&self.out, events).await,
            Err(StorageError::Conflict) => {}
            Err(e) => return Err(storage_error(e)),
        }
        let id = call_id.to_owned();
        let call = self
            .storage
            .call(move |s| s.model_call(&id))
            .await
            .map_err(storage_error)?;
        Ok(Response::ModelStarted {
            call: Box::new(call),
            duplicate: false,
        })
    }
    pub async fn shutdown(&mut self) {
        for job in self.jobs.values() {
            job.cancel.cancel();
        }
        let ids: Vec<_> = self
            .jobs
            .keys()
            .filter(|id| !id.starts_with("list-"))
            .cloned()
            .collect();
        for id in ids {
            persist_end(
                &self.storage,
                &self.out,
                &id,
                Err(diagnostic::error(ModelErrorCode::Cancelled)),
            )
            .await;
        }
        for (_, job) in self.jobs.drain() {
            let mut handle = job.handle;
            if tokio::time::timeout(std::time::Duration::from_millis(500), &mut handle)
                .await
                .is_err()
            {
                handle.abort();
            }
        }
    }
}
async fn secret_for(
    namespace: &str,
    p: &ProviderProfile,
    storage: &Storage,
) -> std::result::Result<Option<Secret>, ModelDiagnostic> {
    if config::effective_auth(p) == AuthMode::None {
        return Ok(None);
    }
    let reference = p
        .credential
        .clone()
        .ok_or_else(|| diagnostic::error(ModelErrorCode::Authentication))?;
    let namespace = namespace.to_owned();
    let secret =
        tokio::task::spawn_blocking(move || SystemCredentials::new(&namespace)?.get(&reference))
            .await
            .map_err(|_| diagnostic::error(ModelErrorCode::Authentication))?
            .map_err(|_| diagnostic::error(ModelErrorCode::Authentication))?;
    let value = Zeroizing::new(secret.expose().to_owned());
    storage
        .call(move |s| s.register_secret(value.as_str()))
        .await
        .map_err(storage_error)?;
    Ok(Some(secret))
}
async fn remove_secret(
    namespace: &str,
    reference: CredentialRef,
) -> std::result::Result<(), ModelDiagnostic> {
    let namespace = namespace.to_owned();
    tokio::task::spawn_blocking(move || SystemCredentials::new(&namespace)?.delete(&reference))
        .await
        .map_err(|_| diagnostic::error(ModelErrorCode::Authentication))?
        .map_err(|_| {
            diagnostic::detail(
                ModelErrorCode::Authentication,
                "配置已移除，但系统凭据库未能清理该密钥",
            )
        })
}
async fn persist_update(
    storage: &Storage,
    out: &mpsc::Sender<Wire>,
    id: &str,
    update: ModelUpdate,
) -> std::result::Result<(), ModelDiagnostic> {
    let id = id.to_owned();
    let (text, reasoning) = match update {
        ModelUpdate::Text(s) => (s, false),
        ModelUpdate::PublicReasoning(s) => (s, true),
    };
    let event = storage
        .call(move |s| s.append_model_text(&id, &text, reasoning))
        .await
        .map_err(storage_error)?;
    emit(out, vec![event]).await;
    Ok(())
}
async fn persist_end(
    storage: &Storage,
    out: &mpsc::Sender<Wire>,
    id: &str,
    result: std::result::Result<ModelOutput, ModelDiagnostic>,
) {
    let id = id.to_owned();
    let observe = result.as_ref().ok().cloned();
    let for_save = id.clone();
    let saved = storage
        .call(move |s| s.finish_model_call(&for_save, result))
        .await;
    match saved {
        Ok(events) => {
            emit(out, events).await;
            if let Some(output) = observe {
                let _ = storage
                    .call(move |s| s.record_capabilities(&id, &output))
                    .await;
            }
        }
        Err(StorageError::Conflict) => {}
        Err(_) => {
            let fallback = diagnostic::detail(
                ModelErrorCode::Limit,
                "响应未能完整保存，本次不能标记为成功",
            );
            if let Ok(events) = storage
                .call(move |s| s.finish_model_call(&id, Err(fallback)))
                .await
            {
                emit(out, events).await;
            }
        }
    }
}
async fn emit(out: &mpsc::Sender<Wire>, events: Vec<Event>) {
    for event in events {
        if out
            .send(Wire::Event {
                event: Box::new(event),
            })
            .await
            .is_err()
        {
            break;
        }
    }
}
fn storage_error(error: StorageError) -> ModelDiagnostic {
    diagnostic::detail(
        ModelErrorCode::Configuration,
        match error {
            StorageError::NotFound => "指定的配置或任务不存在，请刷新后重新选择。",
            StorageError::Conflict => {
                "记录已改变或操作已结束，请刷新后重试；不会自动改用其他模型。"
            }
            StorageError::Busy => "该记录正在使用，请先停止相关操作。",
            _ => "本地配置保存或读取失败，请检查目录和可用空间。",
        },
    )
}
fn view(profile: ProviderProfile) -> ProfileView {
    let endpoint = config::endpoint(&profile)
        .map(|u| u.to_string())
        .unwrap_or_else(|_| "配置地址不正确".into());
    ProfileView {
        credential_saved: profile.credential.is_some(),
        profile: profile.without_credential(),
        endpoint,
    }
}
pub fn probe_input(mode: ModelProbeMode, prompt: &str) -> ModelInput {
    let default = match mode {
        ModelProbeMode::Text => "请只回复：WorkPilot 已连接。",
        ModelProbeMode::Tools => {
            "请调用 workpilot_echo 工具，message 参数填写 WorkPilot。不要执行其他工作。"
        }
        ModelProbeMode::Image => "这是一张小型测试图片。请确认你收到了图片，只回复一句话。",
    };
    let mut content = vec![ModelContent::Text {
        text: if prompt.trim().is_empty() {
            default
        } else {
            prompt
        }
        .into(),
    }];
    if mode == ModelProbeMode::Image {
        content.push(ModelContent::Image{media_type:"image/png".into(),base64:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNwKDgAAAJkAXEbVUd6AAAAAElFTkSuQmCC".into()});
    }
    let tools = if mode == ModelProbeMode::Tools {
        vec![ToolDefinition {
            name: "workpilot_echo".into(),
            description: "A diagnostic tool proposal; this phase never executes it.".into(),
            parameters: serde_json::json!({"type":"object","properties":{"message":{"type":"string"}},"required":["message"],"additionalProperties":false}),
        }]
    } else {
        vec![]
    };
    ModelInput {
        messages: vec![ModelMessage {
            role: "user".into(),
            content,
        }],
        tools,
        tool_results: vec![],
        continuation: None,
        capability_probe: Some(mode),
    }
}
