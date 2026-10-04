//! Extension management requests, installation approval and lifecycle.
use super::*;

impl Manager {
    pub async fn admin(&self, scope: Option<String>, action: ExtensionAdmin) -> Result<Value> {
        match action {
            ExtensionAdmin::Catalog { query } => {
                return self.catalog(scope.as_deref(), query.as_deref()).await;
            }
            ExtensionAdmin::ReadResource {
                installation_id,
                revision,
                path,
            } => {
                return self
                    .resource(&installation_id, revision, scope.as_deref(), &path, false)
                    .await;
            }
            ExtensionAdmin::PreviewResource { draft_id, path } => {
                let id = draft_id.clone();
                let p = self
                    .0
                    .storage
                    .call(move |s| s.extension_preview(&id))
                    .await
                    .map_err(|e| e.to_string())?;
                if !visible(&p.scope, scope.as_deref()) {
                    return Err("预览不属于当前项目。".into());
                }
                let staged = self.stage_path(&draft_id)?;
                let root = if staged.exists() {
                    staged
                } else {
                    self.version_path(&p.version.digest)
                };
                let bytes = package::read_verified(&root, &p.version, &path)?;
                return Ok(
                    json!({"path":path,"text":std::str::from_utf8(&bytes).ok().filter(|_|bytes.len()<=256*1024),"bytes":bytes.len()}),
                );
            }
            ExtensionAdmin::OAuthStart {
                installation_id,
                server_id,
                revision,
                client_id,
                scopes,
            } => {
                let (_, v) = self
                    .installation(&installation_id, Some(revision), scope.as_deref(), false)
                    .await?;
                let server = v
                    .manifest
                    .servers
                    .iter()
                    .find(|s| s.id == server_id)
                    .ok_or("授权服务不存在。")?;
                let McpTransport::Http {
                    url,
                    auth: McpAuth::OAuth,
                } = &server.transport
                else {
                    return Err("此服务未配置浏览器登录方式。".into());
                };
                {
                    let flows = self.0.oauth.lock().unwrap();
                    if flows
                        .values()
                        .filter(|f| f.state.lock().unwrap()["state"] == "waiting")
                        .count()
                        >= 4
                    {
                        return Err("请先完成或取消正在等待的登录。".into());
                    }
                }
                let pending = crate::oauth::begin(url, client_id, scopes).await?;
                let _guard = self.0.gate.lock().await;
                self.installation(&installation_id, Some(revision), scope.as_deref(), false)
                    .await?;
                let id = uuid::Uuid::new_v4().to_string();
                let flow = Arc::new(crate::oauth::Flow {
                    installation: installation_id.clone(),
                    scope: scope.clone(),
                    stop: Arc::new(AtomicBool::new(false)),
                    state: Mutex::new(json!({"state":"waiting"})),
                    created: std::time::Instant::now(),
                });
                {
                    let mut flows = self.0.oauth.lock().unwrap();
                    flows.retain(|_, f| f.created.elapsed() < std::time::Duration::from_secs(600));
                    flows.insert(id.clone(), flow.clone());
                }
                let authorization_url = pending.authorization_url.clone();
                let manager = self.clone();
                tokio::spawn(async move {
                    let result = async {
                        let token = pending.complete(flow.stop.clone()).await?;
                        let _guard = manager.0.gate.lock().await;
                        if flow.stop.load(Ordering::SeqCst) {
                            return Err("登录已取消。".to_owned());
                        }
                        manager
                            .installation(&installation_id, Some(revision), scope.as_deref(), false)
                            .await?;
                        manager
                            .save_credential(
                                &installation_id,
                                &server_id,
                                "authorization",
                                revision,
                                Some(token.to_string()),
                            )
                            .await?;
                        Ok::<(), String>(())
                    }
                    .await;
                    *flow.state.lock().unwrap() = match result {
                        Ok(()) => {
                            json!({"state":"authorized","message":"登录已保存到系统凭据存储，请重新检查工具。"})
                        }
                        Err(e) => json!({"state":"failed","message":e}),
                    };
                });
                return Ok(
                    json!({"flow_id":id,"authorization_url":authorization_url,"expires_in_seconds":300,"state":"waiting"}),
                );
            }
            ExtensionAdmin::OAuthStatus { flow_id } => {
                let flows = self.0.oauth.lock().unwrap();
                let flow = flows
                    .get(&flow_id)
                    .filter(|f| visible(&f.scope, scope.as_deref()))
                    .ok_or("登录记录已失效。")?;
                return Ok(flow.state.lock().unwrap().clone());
            }
            ExtensionAdmin::OAuthCancel { flow_id } => {
                let flows = self.0.oauth.lock().unwrap();
                let flow = flows
                    .get(&flow_id)
                    .filter(|f| visible(&f.scope, scope.as_deref()))
                    .ok_or("登录记录已失效。")?;
                flow.stop.store(true, Ordering::SeqCst);
                return Ok(json!({"state":"cancelled"}));
            }
            _ => {}
        }
        // Downloading an archive must not block disabling a running installation.
        let _guard = if matches!(&action, ExtensionAdmin::Preview { .. }) {
            None
        } else {
            Some(self.0.gate.lock().await)
        };
        match action {
            ExtensionAdmin::Preview { source, project } => {
                if source.len() > 4096 || source.contains('\0') {
                    return Err("扩展来源地址无效。".into());
                }
                let scope = if project {
                    Some(scope.ok_or("项目范围安装需要先选择绑定文件夹的任务。")?)
                } else {
                    None
                };
                let files = if source.starts_with("https://") || source.starts_with("http://") {
                    package::unpack(&mcp::download(&source).await?)?
                } else {
                    let path = Path::new(&source);
                    if !path.is_absolute() {
                        return Err("请使用扩展目录或 ZIP 的完整路径。".into());
                    }
                    if path.is_dir() {
                        package::directory(path)?
                    } else {
                        use std::io::Read;
                        let mut bytes = vec![];
                        std::fs::File::open(path)
                            .map_err(|_| "找不到扩展包。")?
                            .take((package::MAX_PACKAGE + 1) as u64)
                            .read_to_end(&mut bytes)
                            .map_err(|_| "无法读取扩展包。")?;
                        package::unpack(&bytes)?
                    }
                };
                let _guard = self.0.gate.lock().await;
                let preview = self
                    .stage(
                        uuid::Uuid::new_v4().to_string(),
                        source,
                        scope,
                        files,
                        false,
                    )
                    .await?;
                Ok(json!(preview))
            }
            ExtensionAdmin::PreviewDraft { draft_id } => {
                let id = draft_id.clone();
                let p = self
                    .0
                    .storage
                    .call(move |s| s.extension_preview(&id))
                    .await
                    .map_err(|e| e.to_string())?;
                if !visible(&p.scope, scope.as_deref()) {
                    return Err("草稿不属于当前项目。".into());
                }
                Ok(json!(p))
            }
            ExtensionAdmin::DiscardPreview { draft_id } => {
                let id = draft_id.clone();
                let p = self
                    .0
                    .storage
                    .call(move |s| s.extension_preview(&id))
                    .await
                    .map_err(|e| e.to_string())?;
                if !visible(&p.scope, scope.as_deref()) {
                    return Err("草稿不属于当前项目。".into());
                }
                self.0
                    .storage
                    .call(move |s| s.extension_discard_preview(&draft_id))
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(json!({"discarded":true}))
            }
            ExtensionAdmin::Confirm {
                draft_id,
                digest,
                enable,
            } => {
                let id = draft_id.clone();
                let preview = self
                    .0
                    .storage
                    .call(move |s| s.extension_preview(&id))
                    .await
                    .map_err(|e| e.to_string())?;
                if preview.version.digest != digest || !visible(&preview.scope, scope.as_deref()) {
                    return Err("预览内容或安装范围已变化。".into());
                }
                self.dependencies(&preview.version, preview.scope.as_deref())
                    .await?;
                let staged = self.stage_path(&draft_id)?;
                let path = if staged.exists() {
                    staged
                } else {
                    self.version_path(&digest)
                };
                let mut files = package::Contents::new();
                for file in &preview.version.files {
                    files.insert(
                        file.path.clone(),
                        package::read_verified(&path, &preview.version, &file.path)?,
                    );
                }
                let (version, _) = package::validate(files)?;
                for server in &version.manifest.servers {
                    if let McpTransport::Stdio { runtime, entry, .. } = &server.transport {
                        runtime_command(*runtime, &path.join(entry))?;
                    }
                }
                if version.digest != digest {
                    return Err("预览内容校验失败。".into());
                }
                let destination = self.version_path(&digest);
                std::fs::create_dir_all(destination.parent().ok_or("安装目录不可用。")?)
                    .map_err(|_| "无法创建扩展安装目录。")?;
                if destination.exists() {
                    for file in &preview.version.files {
                        package::read_verified(&destination, &preview.version, &file.path)?;
                    }
                } else {
                    std::fs::rename(&path, &destination)
                        .map_err(|_| "扩展原子安装失败，旧版保持不变。")?;
                }
                let installation = PluginInstallation {
                    id: preview
                        .installed_id
                        .clone()
                        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                    scope: preview.scope.clone(),
                    slug: preview.version.manifest.id.clone(),
                    source: preview.source.clone(),
                    active_digest: digest,
                    enabled: enable,
                    installed: true,
                    revision: preview
                        .expected_revision
                        .unwrap_or(0)
                        .checked_add(1)
                        .ok_or("扩展修订编号已超限。")?,
                    at_ms: workpilot_storage::now_ms(),
                };
                self.cancel_installation(&installation.id);
                let (p, i) = (preview.clone(), installation.clone());
                self.0
                    .storage
                    .call(move |s| s.extension_commit_preview(&p, &i))
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(json!(installation))
            }
            ExtensionAdmin::SetEnabled {
                installation_id,
                revision,
                enabled,
            } => {
                let (mut i, v) = self
                    .installation(&installation_id, Some(revision), scope.as_deref(), false)
                    .await?;
                if enabled {
                    self.dependencies(&v, i.scope.as_deref()).await?;
                    for file in &v.files {
                        package::read_verified(&self.version_path(&v.digest), &v, &file.path)?;
                    }
                    for server in &v.manifest.servers {
                        if let McpTransport::Stdio { runtime, entry, .. } = &server.transport {
                            runtime_command(*runtime, &self.version_path(&v.digest).join(entry))?;
                        }
                    }
                }
                i.enabled = enabled;
                self.cancel_installation(&i.id);
                let i = self
                    .0
                    .storage
                    .call(move |s| {
                        s.extension_update(
                            i,
                            revision,
                            if enabled { "enabled" } else { "disabled" },
                        )
                    })
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(json!(i))
            }
            ExtensionAdmin::Uninstall {
                installation_id,
                revision,
            } => {
                let (mut i, _) = self
                    .installation(&installation_id, Some(revision), scope.as_deref(), false)
                    .await?;
                i.installed = false;
                i.enabled = false;
                self.cancel_installation(&i.id);
                let id = i.id.clone();
                let credentials = self
                    .0
                    .storage
                    .call(move |s| s.extension_credentials(&id))
                    .await
                    .map_err(|e| e.to_string())?;
                let saved = self
                    .0
                    .storage
                    .call(move |s| s.extension_update(i, revision, "uninstalled"))
                    .await
                    .map_err(|e| e.to_string())?;
                for reference in credentials {
                    self.credentials()?
                        .delete(&reference)
                        .map_err(|_| "扩展已卸载，但系统凭据清理未完成。")?;
                }
                let id = saved.id.clone();
                self.0
                    .storage
                    .call(move |s| s.extension_clear_credentials(&id))
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(json!({"installation":saved,"user_files_preserved":true}))
            }
            ExtensionAdmin::Versions { installation_id } => {
                self.installation(&installation_id, None, scope.as_deref(), false)
                    .await?;
                let history = self
                    .0
                    .storage
                    .call(move |s| {
                        let mut history = s.extension_history(Some(&installation_id))?;
                        let current = s.extension_installation(&installation_id)?;
                        for version in s.extension_owned_versions(&installation_id)? {
                            if history.iter().any(|r| r["data"]["active_digest"] == version.digest) {
                                continue;
                            }
                            let mut item = current.clone();
                            item.active_digest = version.digest;
                            history.push(json!({"at_ms":version.created_at_ms,"action":"retained_version","data":item}));
                        }
                        Ok(history)
                    })
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(json!({"history":history}))
            }
            ExtensionAdmin::Rollback {
                installation_id,
                digest,
                revision,
            } => {
                let (mut i, _) = self
                    .installation(&installation_id, Some(revision), scope.as_deref(), false)
                    .await?;
                let id = i.id.clone();
                let history = self
                    .0
                    .storage
                    .call(move |s| s.extension_owned_versions(&id))
                    .await
                    .map_err(|e| e.to_string())?;
                if !history.iter().any(|v| v.digest == digest) {
                    return Err("回退版本不是该扩展的安装历史。".into());
                }
                let hash = digest.clone();
                let v = self
                    .0
                    .storage
                    .call(move |s| s.extension_version(&hash))
                    .await
                    .map_err(|e| e.to_string())?;
                self.dependencies(&v, i.scope.as_deref()).await?;
                for f in &v.files {
                    package::read_verified(&self.version_path(&digest), &v, &f.path)?;
                }
                i.active_digest = digest;
                self.cancel_installation(&i.id);
                let saved = self
                    .0
                    .storage
                    .call(move |s| s.extension_update(i, revision, "rolled_back"))
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(json!(saved))
            }
            ExtensionAdmin::SaveCredential {
                installation_id,
                server_id,
                revision,
                key,
                secret,
            } => {
                let (_, version) = self
                    .installation(&installation_id, Some(revision), scope.as_deref(), false)
                    .await?;
                let server = version
                    .manifest
                    .servers
                    .iter()
                    .find(|s| s.id == server_id)
                    .ok_or("找不到 MCP 服务。")?;
                let permitted = match &server.transport {
                    McpTransport::Http { auth, .. } => {
                        key == "authorization" && !matches!(auth, McpAuth::None)
                    }
                    McpTransport::Stdio { secret_env, .. } => secret_env.contains(&key),
                };
                if !permitted {
                    return Err("凭据名称不在扩展公布的认证设置中。".into());
                }
                let saved = self
                    .save_credential(
                        &installation_id,
                        &server_id,
                        &key,
                        revision,
                        secret.map(|s| s.0.clone()),
                    )
                    .await?;
                Ok(json!(saved))
            }
            ExtensionAdmin::Export {
                installation_id,
                revision,
                destination,
            } => {
                let (_, version) = self
                    .installation(&installation_id, Some(revision), scope.as_deref(), false)
                    .await?;
                let path = Path::new(&destination);
                if !path.is_absolute()
                    || path.exists()
                    || !path
                        .extension()
                        .is_some_and(|v| v.eq_ignore_ascii_case("zip"))
                {
                    return Err("请选择尚不存在的 ZIP 文件完整路径，避免覆盖已有文件。".into());
                }
                let mut files = package::Contents::new();
                for file in &version.files {
                    files.insert(
                        file.path.clone(),
                        package::read_verified(
                            &self.version_path(&version.digest),
                            &version,
                            &file.path,
                        )?,
                    );
                }
                use std::io::Write;
                let mut output =
                    tempfile::NamedTempFile::new_in(path.parent().ok_or("无效导出目录。")?)
                        .map_err(|_| "无法创建导出暂存文件。")?;
                output
                    .write_all(&package::zip(&files)?)
                    .and_then(|_| output.as_file().sync_all())
                    .map_err(|_| "扩展导出未完成。")?;
                output
                    .persist_noclobber(path)
                    .map_err(|_| "导出失败或目标已存在，原文件未改动。")?;
                Ok(json!({"path":destination,"credentials_included":false,"digest":version.digest}))
            }
            _ => Err("未知扩展操作。".into()),
        }
    }
}
