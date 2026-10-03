mod images;
pub mod model;
mod office;
mod worker;
use crate::vault::{Result, Vault};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};
use workpilot_contracts::*;
use workpilot_platform::credentials::{CredentialStore, Secret, SystemCredentials};
use workpilot_storage::Storage;
use workpilot_tools::files::Root;
pub struct Manager {
    storage: Storage,
    data: PathBuf,
    worker: worker::Worker,
    office: office::Converter,
    uploads: Mutex<HashMap<String, Upload>>,
    active: Mutex<HashMap<String, Running>>,
    config_gate: tokio::sync::Mutex<()>,
}
struct Running {
    owners: Vec<String>,
    stop: Arc<AtomicBool>,
    image: bool,
}
struct Upload {
    name: String,
    source: String,
    total: u64,
    offset: u64,
    file: tempfile::NamedTempFile,
    at: Instant,
}
struct Active<'a> {
    owner: &'a Manager,
    id: String,
    stop: Arc<AtomicBool>,
    cancel_on_drop: bool,
}
impl Drop for Active<'_> {
    fn drop(&mut self) {
        if self.cancel_on_drop {
            self.stop.store(true, Ordering::SeqCst);
        }
        self.owner.active.lock().unwrap().remove(&self.id);
    }
}
pub struct AssetSource<'a> {
    pub task: Option<&'a str>,
    pub name: &'a str,
    pub source: &'a str,
    pub path: Option<String>,
    pub version: Option<FileVersion>,
    pub operation: Option<String>,
}
impl Manager {
    pub fn new(storage: Storage, data: PathBuf) -> Self {
        Self {
            storage,
            data,
            worker: worker::Worker::default(),
            office: office::Converter::default(),
            uploads: Mutex::new(HashMap::new()),
            active: Mutex::new(HashMap::new()),
            config_gate: tokio::sync::Mutex::new(()),
        }
    }
    pub fn cancel_all(&self) {
        for running in self.active.lock().unwrap().values() {
            running.stop.store(true, Ordering::SeqCst);
        }
    }
    pub fn cancel_task(&self, task: &str) {
        for running in self.active.lock().unwrap().values() {
            if running.owners.iter().any(|owner| owner == task) {
                running.stop.store(true, Ordering::SeqCst);
            }
        }
    }
    fn cancel_images(&self) {
        for running in self.active.lock().unwrap().values() {
            if running.image {
                running.stop.store(true, Ordering::SeqCst);
            }
        }
    }
    async fn active(
        &self,
        task: Option<&str>,
        image: bool,
        id: Option<&str>,
    ) -> Result<Active<'_>> {
        let owners = if let Some(task) = task {
            let task = task.to_owned();
            self.storage
                .call(move |s| {
                    let mut owners = vec![task.clone()];
                    let mut current = task;
                    while let Some(parent) = s.member_parent(&current)? {
                        current = parent;
                        owners.push(current.clone());
                        if owners.len() > 16 {
                            return Err(workpilot_storage::Error::Invalid("member ancestry"));
                        }
                    }
                    Ok(owners)
                })
                .await
                .map_err(|e| e.to_string())?
        } else {
            vec![]
        };
        let mut active = self.active.lock().unwrap();
        if active.len() >= 4 {
            return Err("文件处理忙，请稍后重试 / File processing is busy".into());
        }
        let id = id
            .map(str::to_owned)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        if active.contains_key(&id) {
            return Err("此文件正在处理 / This file is already being processed".into());
        }
        let stop = Arc::new(AtomicBool::new(false));
        active.insert(
            id.clone(),
            Running {
                owners,
                stop: stop.clone(),
                image,
            },
        );
        Ok(Active {
            owner: self,
            id,
            stop,
            cancel_on_drop: true,
        })
    }
    async fn asset(&self, task: Option<&str>, id: &str) -> Result<(MediaAsset, String, String)> {
        let id = id.to_owned();
        let result = self
            .storage
            .call(move |s| s.media_asset(&id))
            .await
            .map_err(|e| e.to_string())?;
        if result.0.task_id.as_deref() != task {
            return Err("附件不属于当前任务 / Attachment belongs to another task".into());
        }
        Ok(result)
    }
    async fn save_asset(
        &self,
        source: AssetSource<'_>,
        bytes: &[u8],
        report: Value,
    ) -> Result<MediaAsset> {
        let units = report["units"].as_array().map_or(0, Vec::len) as u32;
        let asset = MediaAsset {
            id: uuid::Uuid::new_v4().to_string(),
            task_id: source.task.map(str::to_owned),
            name: source.name.into(),
            source: source.source.into(),
            media_type: report["media_type"]
                .as_str()
                .ok_or("Invalid parsed media type")?
                .into(),
            bytes: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)),
            at_ms: workpilot_storage::now_ms(),
            units,
            warnings: serde_json::from_value(report["warnings"].clone())
                .map_err(|e| e.to_string())?,
            image: serde_json::from_value(report["image"].clone()).map_err(|e| e.to_string())?,
            path: source.path,
            version: source.version,
            operation_id: source.operation,
        };
        let vault = Vault::open(&self.data)?;
        let original = vault.put(bytes)?;
        let parsed = vault.put(&serde_json::to_vec(&report).map_err(|e| e.to_string())?)?;
        let saved = asset.clone();
        self.storage
            .call(move |s| s.media_put(&saved, &original, &parsed))
            .await
            .map_err(|e| e.to_string())?;
        Ok(asset)
    }
    pub async fn admin(&self, task: Option<String>, action: MediaAdmin) -> Result<Value> {
        action.validate().map_err(str::to_owned)?;
        if let Some(task) = &task {
            let t = task.clone();
            self.storage
                .call(move |s| s.execution_snapshot(&t))
                .await
                .map_err(|e| e.to_string())?;
        }
        match action {
            MediaAdmin::BeginUpload {
                name,
                bytes,
                source,
            } => {
                let folder = self.data.join("media/uploads");
                std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
                let mut uploads = self.uploads.lock().unwrap();
                uploads.retain(|_, u| u.at.elapsed().as_secs() < 600);
                if uploads.len() >= 8 {
                    return Err("最多同时导入 8 个文件 / At most 8 simultaneous imports".into());
                }
                let id = uuid::Uuid::new_v4().to_string();
                uploads.insert(
                    id.clone(),
                    Upload {
                        name,
                        source,
                        total: bytes,
                        offset: 0,
                        file: tempfile::NamedTempFile::new_in(folder).map_err(|e| e.to_string())?,
                        at: Instant::now(),
                    },
                );
                Ok(json!({"upload_id":id}))
            }
            MediaAdmin::UploadChunk {
                upload_id,
                offset,
                base64,
            } => {
                let bytes = STANDARD.decode(base64).map_err(|_| "Invalid file chunk")?;
                let mut uploads = self.uploads.lock().unwrap();
                let upload = uploads
                    .get_mut(&upload_id)
                    .ok_or("上传已过期 / Upload expired")?;
                if offset != upload.offset
                    || offset + bytes.len() as u64 > upload.total
                    || bytes.is_empty()
                {
                    return Err("文件片段顺序或长度不正确 / Invalid chunk order or length".into());
                }
                upload.file.write_all(&bytes).map_err(|e| e.to_string())?;
                upload.offset += bytes.len() as u64;
                upload.at = Instant::now();
                Ok(json!({"offset":upload.offset}))
            }
            MediaAdmin::CancelUpload { upload_id } => {
                self.uploads.lock().unwrap().remove(&upload_id);
                if let Some(running) = self.active.lock().unwrap().get(&upload_id) {
                    running.stop.store(true, Ordering::SeqCst);
                }
                Ok(json!({"cancelled":true}))
            }
            MediaAdmin::FinishUpload { upload_id } => {
                let active = self
                    .active(task.as_deref(), false, Some(&upload_id))
                    .await?;
                let upload = self
                    .uploads
                    .lock()
                    .unwrap()
                    .remove(&upload_id)
                    .ok_or("上传已过期 / Upload expired")?;
                if upload.offset != upload.total {
                    return Err("文件上传不完整 / Incomplete file upload".into());
                }
                upload
                    .file
                    .as_file()
                    .sync_all()
                    .map_err(|e| e.to_string())?;
                let bytes = std::fs::read(upload.file.path()).map_err(|e| e.to_string())?;
                let output = self
                    .worker
                    .run(
                        &self.data,
                        json!({"kind":"parse","name":upload.name}),
                        Some(&bytes),
                        active.stop.clone(),
                    )
                    .await?;
                if active.stop.load(Ordering::SeqCst) {
                    return Err("导入已停止 / Import stopped".into());
                }
                let asset = self
                    .save_asset(
                        AssetSource {
                            task: None,
                            name: &upload.name,
                            source: &upload.source,
                            path: None,
                            version: None,
                            operation: None,
                        },
                        &bytes,
                        output.report,
                    )
                    .await?;
                Ok(json!({"asset":asset}))
            }
            MediaAdmin::Bind { asset_ids } => {
                let task = task.ok_or("Missing task")?;
                self.storage
                    .call(move |s| s.media_bind(&task, &asset_ids))
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(json!({"bound":true}))
            }
            MediaAdmin::List => {
                let task = task.ok_or("Missing task")?;
                Ok(
                    json!({"assets":self.storage.call(move|s|s.media_list(&task)).await.map_err(|e|e.to_string())?}),
                )
            }
            MediaAdmin::Read {
                asset_id,
                start,
                limit,
            } => self.read(task.as_deref(), &asset_id, start, limit).await,
            MediaAdmin::CancelPreview { asset_id } => {
                self.asset(task.as_deref(), &asset_id).await?;
                if let Some(running) = self
                    .active
                    .lock()
                    .unwrap()
                    .get(&format!("preview:{asset_id}"))
                {
                    running.stop.store(true, Ordering::SeqCst);
                }
                Ok(json!({"cancelled":true}))
            }
            MediaAdmin::Preview { asset_id, page } => {
                if !(1..=500).contains(&page) {
                    return Err("页码超出范围 / Page is out of range".into());
                }
                let (asset, original, _) = self.asset(task.as_deref(), &asset_id).await?;
                let active = self
                    .active(task.as_deref(), false, Some(&format!("preview:{asset_id}")))
                    .await?;
                let work = async {
                    let bytes = Vault::open(&self.data)?.read(&original)?;
                    let converted = if let Some(format) = office::format(&asset.media_type) {
                        Some(
                            self.office
                                .pdf(
                                    &self.data,
                                    &asset.sha256,
                                    format,
                                    &bytes,
                                    active.stop.clone(),
                                )
                                .await?,
                        )
                    } else {
                        None
                    };
                    let (name, input) = if let Some(pdf) = &converted {
                        ("preview.pdf", pdf.bytes.as_slice())
                    } else {
                        (asset.name.as_str(), bytes.as_slice())
                    };
                    let result = self
                        .worker
                        .run(
                            &self.data,
                            json!({"kind":"preview","name":name,"page":page}),
                            Some(input),
                            active.stop.clone(),
                        )
                        .await?;
                    Ok::<Value, String>(
                        json!({"image":format!("data:image/png;base64,{}",STANDARD.encode(result.bytes.ok_or("Missing preview")?)),"page":page,"pages":result.report["pages"],"asset_id":asset.id,"source_sha256":asset.sha256,"conversion":converted.is_some(),"renderer":converted.as_ref().map(|p|p.renderer.as_str()),"cache_hit":converted.as_ref().is_some_and(|p|p.cached)}),
                    )
                };
                tokio::time::timeout(std::time::Duration::from_secs(110), work)
                    .await
                    .map_err(|_| {
                        "版式预览超时，请尝试较小的文件 / Layout preview timed out".to_string()
                    })?
            }
            MediaAdmin::Remove { asset_id } => {
                self.asset(task.as_deref(), &asset_id).await?;
                if let Some(running) = self
                    .active
                    .lock()
                    .unwrap()
                    .get(&format!("preview:{asset_id}"))
                {
                    running.stop.store(true, Ordering::SeqCst);
                }
                if let Some(task) = task
                    && self
                        .storage
                        .call(move |s| {
                            Ok(matches!(
                                s.execution_snapshot(&task)?.task.state,
                                TaskState::Running | TaskState::Queued | TaskState::Stopping
                            ) || s.has_active_workbench(&task)?)
                        })
                        .await
                        .map_err(|e| e.to_string())?
                {
                    return Err(
                        "请先停止任务再移除附件 / Stop the task before removing its attachment"
                            .into(),
                    );
                }
                self.storage
                    .call(move |s| s.media_remove(&asset_id))
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(json!({"removed":true}))
            }
            MediaAdmin::ImageServices => Ok(
                json!({"services":self.storage.call(|s|s.image_services()).await.map_err(|e|e.to_string())?}),
            ),
            MediaAdmin::SaveImageService {
                mut service,
                secret,
            } => {
                let _gate = self.config_gate.lock().await;
                images::base_url(&service.base_url)?;
                if !service.auth_required
                    && !images::base_url(&service.base_url)?
                        .host_str()
                        .is_some_and(|h| matches!(h, "localhost" | "127.0.0.1" | "[::1]" | "::1"))
                {
                    return Err(
                        "无密钥模式仅用于本机服务 / No-key mode is limited to loopback services"
                            .into(),
                    );
                }
                let lookup = service.id.clone();
                let old = self
                    .storage
                    .call(move |s| s.image_service(&lookup))
                    .await
                    .ok();
                if service.revision != old.as_ref().map_or(0, |s| s.revision) {
                    return Err("配置已改变，请刷新 / Configuration changed; refresh first".into());
                }
                service.revision += 1;
                service.credential = old.as_ref().and_then(|s| s.credential.clone());
                let credentials =
                    SystemCredentials::new("image-services").map_err(|e| e.to_string())?;
                let mut new_ref = None;
                if let Some(raw) = secret.filter(|s| !s.is_empty() && service.auth_required) {
                    let value = Secret::new(raw).map_err(|e| e.to_string())?;
                    let redaction = value.expose().to_owned();
                    self.storage
                        .call(move |s| s.register_secret(&redaction))
                        .await
                        .map_err(|e| e.to_string())?;
                    let reference = CredentialRef {
                        id: uuid::Uuid::new_v4().to_string(),
                    };
                    credentials
                        .put(&reference, &value)
                        .map_err(|e| e.to_string())?;
                    service.credential = Some(reference.clone());
                    new_ref = Some(reference);
                }
                if !service.auth_required {
                    service.credential = None;
                }
                let saved = service.clone();
                if let Err(e) = self
                    .storage
                    .call(move |s| {
                        s.extension_content_allowed(&serde_json::to_string(&saved)?)?;
                        s.image_service_save(&saved)
                    })
                    .await
                {
                    if let Some(r) = new_ref {
                        let _ = credentials.delete(&r);
                    }
                    return Err(e.to_string());
                }
                if let Some(previous) = old
                    .and_then(|s| s.credential)
                    .filter(|r| service.credential.as_ref().map(|s| &s.id) != Some(&r.id))
                {
                    let _ = credentials.delete(&previous);
                }
                self.cancel_images();
                Ok(json!({"service":service}))
            }
            MediaAdmin::RemoveImageService { service_id } => {
                let _gate = self.config_gate.lock().await;
                let lookup = service_id.clone();
                let old = self
                    .storage
                    .call(move |s| s.image_service(&lookup))
                    .await
                    .map_err(|e| e.to_string())?;
                self.storage
                    .call(move |s| s.image_service_remove(&service_id))
                    .await
                    .map_err(|e| e.to_string())?;
                self.cancel_images();
                if let Some(r) = old.credential {
                    SystemCredentials::new("image-services")
                        .map_err(|e| e.to_string())?
                        .delete(&r)
                        .map_err(|e| e.to_string())?;
                }
                Ok(json!({"removed":true}))
            }
        }
    }
    pub async fn read(
        &self,
        task: Option<&str>,
        id: &str,
        start: u32,
        limit: u32,
    ) -> Result<Value> {
        if !(1..=32).contains(&limit) {
            return Err("Invalid document range".into());
        }
        let (asset, _, parsed) = self.asset(task, id).await?;
        let report: Value = serde_json::from_slice(&Vault::open(&self.data)?.read(&parsed)?)
            .map_err(|e| e.to_string())?;
        let all = report["units"].as_array().ok_or("Missing document units")?;
        if start as usize > all.len() {
            return Err("读取范围超出文件内容 / Document range is out of bounds".into());
        }
        let mut units = vec![];
        let mut size = 0;
        for unit in all.iter().skip(start as usize).take(limit as usize) {
            let bytes = unit.to_string().len();
            if size + bytes > 18000 && !units.is_empty() {
                break;
            }
            size += bytes;
            units.push(unit.clone());
        }
        let next = start as usize + units.len();
        let value = json!({"asset":asset,"units":units,"next":if next<all.len(){Some(next)}else{None},"total":all.len(),"image_requires_vision":asset.image.is_some()});
        self.storage
            .call(move |s| Ok(s.media_safe_value(value)))
            .await
            .map_err(|e| e.to_string())
    }
    pub async fn import_project(
        &self,
        task: &str,
        root: &Root,
        path: &str,
        expected: &FileVersion,
    ) -> Result<Value> {
        workpilot_tools::binary::user_path(path).map_err(|e| e.to_string())?;
        let file = root.binary_snapshot(path).map_err(|e| e.to_string())?;
        if &file.version != expected || !file.version.exists {
            return Err(
                "文件已改变或不存在，请刷新 / File changed or missing; refresh first".into(),
            );
        }
        let active = self.active(Some(task), false, None).await?;
        let name = Path::new(path)
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or("Invalid file name")?;
        let report = self
            .worker
            .run(
                &self.data,
                json!({"kind":"parse","name":name}),
                Some(&file.bytes),
                active.stop.clone(),
            )
            .await?
            .report;
        if root
            .binary_snapshot(path)
            .map_err(|e| e.to_string())?
            .version
            != *expected
        {
            return Err("解析时文件已被修改，请刷新 / File changed during parsing".into());
        }
        let asset = self
            .save_asset(
                AssetSource {
                    task: Some(task),
                    name,
                    source: "project",
                    path: Some(path.into()),
                    version: Some(expected.clone()),
                    operation: None,
                },
                &file.bytes,
                report,
            )
            .await?;
        Ok(json!({"asset":asset}))
    }
    pub async fn prepare(&self, task: &str, root: &Root, effect: &MediaEffect) -> Result<Value> {
        effect.validate().map_err(str::to_owned)?;
        let paths = effect.paths();
        let mut seen = std::collections::HashSet::new();
        let expected = match effect {
            MediaEffect::CreateDocument { expected, .. } => vec![expected.clone()],
            MediaEffect::GenerateImage { request } => request.expected.clone(),
        };
        for (path, version) in paths.iter().zip(expected.iter()) {
            workpilot_tools::binary::user_path(path).map_err(|e| e.to_string())?;
            if !seen.insert(path.to_lowercase()) {
                return Err("输出路径重复 / Duplicate output path".into());
            }
            if root
                .binary_snapshot(path)
                .map_err(|e| e.to_string())?
                .version
                != *version
            {
                return Err(
                    "目标文件已改变，请刷新再生成 / Output file changed; refresh before generating"
                        .into(),
                );
            }
        }
        match effect {
            MediaEffect::CreateDocument { path, format, .. } => {
                if Path::new(path).extension().and_then(|s| s.to_str()) != Some(format.as_str()) {
                    return Err(
                        "文件扩展名与生成格式不一致 / Output extension does not match format"
                            .into(),
                    );
                }
                Ok(json!({"paths":paths,"expected":expected}))
            }
            MediaEffect::GenerateImage { request } => {
                let service = self.image_service(&request.service_id).await?;
                images::validate_request(&service, request)?;
                let mut references = vec![];
                for id in &request.references {
                    let (asset, _, _) = self.asset(Some(task), id).await?;
                    if asset.image.is_none()
                        || !matches!(
                            asset.media_type.as_str(),
                            "image/png" | "image/jpeg" | "image/webp"
                        )
                    {
                        return Err("参考图必须为 PNG/JPEG/WebP / Invalid reference image".into());
                    }
                    references.push(json!({"id":id,"sha256":asset.sha256}));
                }
                let mut service = service;
                service.credential = None;
                Ok(
                    json!({"service":service,"paths":paths,"expected":expected,"references":references,"cost":"unknown"}),
                )
            }
        }
    }
    async fn image_service(&self, id: &str) -> Result<ImageService> {
        let id = id.to_owned();
        self.storage
            .call(move |s| s.image_service(&id))
            .await
            .map_err(|_| "图片服务未配置 / Image service is not configured".into())
    }
    pub async fn execute(
        &self,
        task: &str,
        root: &Root,
        effect: &MediaEffect,
        operation: &str,
        stop: Arc<AtomicBool>,
    ) -> Result<(Value, Vec<Event>)> {
        let mut active = self
            .active(
                Some(task),
                matches!(effect, MediaEffect::GenerateImage { .. }),
                None,
            )
            .await?;
        self.active
            .lock()
            .unwrap()
            .get_mut(&active.id)
            .unwrap()
            .stop = stop.clone();
        active.stop = stop.clone();
        active.cancel_on_drop = false;
        let (files, source) = match effect {
            MediaEffect::CreateDocument {
                path,
                format,
                recipe,
                expected,
            } => {
                let output = self
                    .worker
                    .run(
                        &self.data,
                        json!({"kind":"generate","format":format,"recipe":recipe}),
                        None,
                        stop.clone(),
                    )
                    .await?;
                (
                    vec![(
                        path.clone(),
                        expected.clone(),
                        output.bytes.ok_or("Missing generated document")?,
                        output.report,
                    )],
                    json!({"kind":"document_generated","format":format,"conversion":false}),
                )
            }
            MediaEffect::GenerateImage { request } => {
                let service = self.image_service(&request.service_id).await?;
                images::validate_request(&service, request)?;
                let secret = if service.auth_required {
                    let r = service
                        .credential
                        .as_ref()
                        .ok_or("图片服务尚未填写密钥 / Image service key is missing")?;
                    let secret = SystemCredentials::new("image-services")
                        .map_err(|e| e.to_string())?
                        .get(r)
                        .map_err(|_| "图片服务密钥不可用 / Image service key unavailable")?;
                    let raw = secret.expose().to_owned();
                    self.storage
                        .call(move |s| s.register_secret(&raw))
                        .await
                        .map_err(|e| e.to_string())?;
                    Some(secret)
                } else {
                    None
                };
                let mut references = vec![];
                for id in &request.references {
                    let (asset, original, _) = self.asset(Some(task), id).await?;
                    references.push((
                        asset.name,
                        asset.media_type,
                        Vault::open(&self.data)?.read(&original)?,
                    ));
                }
                let response =
                    images::generate(&service, secret.as_ref(), request, references, stop.clone())
                        .await?;
                if self.image_service(&service.id).await?.revision != service.revision {
                    return Err("图片服务设置已改变，结果未写入；请核对服务用量 / Configuration changed; result was not saved; check provider usage".into());
                }
                let mut files = vec![];
                for ((path, expected), bytes) in request
                    .paths
                    .iter()
                    .zip(&request.expected)
                    .zip(response.images)
                {
                    let parsed = self
                        .worker
                        .run(
                            &self.data,
                            json!({"kind":"parse","name":path}),
                            Some(&bytes),
                            stop.clone(),
                        )
                        .await?
                        .report;
                    let dimensions: ImageDimensions =
                        serde_json::from_value(parsed["image"].clone()).map_err(
                            |_| "图片服务未返回可打开的图片 / Invalid image returned by service",
                        )?;
                    if request.size != "auto"
                        && request.size != format!("{}x{}", dimensions.width, dimensions.height)
                    {
                        return Err("图片服务返回的尺寸与请求不符；未写入成果 / Returned dimensions do not match the request".into());
                    }
                    files.push((path.clone(), expected.clone(), bytes, parsed));
                }
                (
                    files,
                    json!({"kind":"image_generated","service_id":service.id,"service_revision":service.revision,"model":service.model,"usage":response.usage,"cost":null,"cost_status":"unknown","references":request.references,"revised_prompts":response.revised_prompts}),
                )
            }
        };
        if stop.load(Ordering::SeqCst) {
            return Err("操作已停止，未写入成果 / Stopped before saving".into());
        }
        // Recheck every output before writing the first, including edits made during a remote request.
        for (path, expected, _, _) in &files {
            if root
                .binary_snapshot(path)
                .map_err(|e| e.to_string())?
                .version
                != *expected
            {
                return Err("生成期间目标文件被修改，原文件保留 / Output changed while generating; existing file preserved".into());
            }
        }
        let mut assets = vec![];
        let mut events = vec![];
        for (path, expected, bytes, report) in files {
            if stop.load(Ordering::SeqCst) {
                return Err("操作已停止；已写入的文件保留在历史中 / Stopped; any saved files remain in history".into());
            }
            let version = root
                .replace_bytes(&path, &expected, &bytes)
                .map_err(|e| e.to_string())?;
            let asset = self
                .save_asset(
                    AssetSource {
                        task: Some(task),
                        name: Path::new(&path)
                            .file_name()
                            .and_then(|n| n.to_str())
                            .ok_or("Invalid file name")?,
                        source: source["kind"].as_str().unwrap_or("generated"),
                        path: Some(path.clone()),
                        version: Some(version.clone()),
                        operation: Some(operation.into()),
                    },
                    &bytes,
                    report,
                )
                .await?;
            let receipt =
                json!({"asset":asset,"provenance":source,"operation_id":operation}).to_string();
            let t = task.to_owned();
            events.extend(
                self.storage
                    .call(move |s| s.register_file_artifact(&t, &path, &receipt))
                    .await
                    .map_err(|e| e.to_string())?,
            );
            assets.push(asset);
        }
        let value = json!({"assets":assets,"source":source});
        let value = self
            .storage
            .call(move |s| Ok(s.media_safe_value(value)))
            .await
            .map_err(|e| e.to_string())?;
        Ok((value, events))
    }
}
