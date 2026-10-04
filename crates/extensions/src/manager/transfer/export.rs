use super::*;

impl Manager {
    pub async fn transfer_catalog(&self, scope: Option<&str>) -> Result<Value> {
        self.ensure_builtin().await?;
        let scope = scope.map(str::to_owned);
        self.0
            .storage
            .call(move |s| {
                let mut items = vec![];
                for i in s.extension_installations()? {
                    if visible(&i.scope, scope.as_deref()) {
                        let v = s.extension_version(&i.active_digest)?;
                        items.push(json!({"installation":i,"version":v}));
                    }
                }
                let drafts = s
                    .extension_previews()?
                    .into_iter()
                    .filter(|p| visible(&p.scope, scope.as_deref()))
                    .collect::<Vec<_>>();
                Ok(json!({"items":items,"drafts":drafts}))
            })
            .await
            .map_err(|e| e.to_string())
    }
    pub async fn export_transfer_complete(
        &self,
        scope: Option<&str>,
        selections: &[ExtensionSelection],
        include_history: bool,
        drafts: &[String],
        stop: &AtomicBool,
    ) -> Result<ExtensionTransferBundle> {
        let _guard = self.0.gate.lock().await;
        let mut bundle = ExtensionTransferBundle {
            version: 2,
            archive_id: uuid::Uuid::new_v4().to_string(),
            created_at_ms: workpilot_storage::now_ms(),
            entries: vec![],
        };
        let (mut total, mut count) = (0, 0);
        for selection in selections {
            check(stop)?;
            let id = selection.installation_id.clone();
            let (i, versions) = self
                .0
                .storage
                .call(move |s| {
                    let i = s.extension_installation(&id)?;
                    let v = if include_history {
                        s.extension_owned_versions(&id)?
                    } else {
                        vec![s.extension_version(&i.active_digest)?]
                    };
                    Ok((i, v))
                })
                .await
                .map_err(|e| e.to_string())?;
            if !visible(&i.scope, scope) || i.revision != selection.revision {
                return Err("扩展选择或范围已变化 / Extension selection changed".into());
            }
            let mut portable = vec![];
            for v in versions {
                portable.push(PortableExtensionVersion {
                    files: read_files(
                        &self.version_path(&v.digest),
                        &v,
                        &mut total,
                        &mut count,
                        stop,
                    )?,
                    digest: v.digest,
                    created_at_ms: v.created_at_ms,
                });
            }
            let current = portable
                .iter()
                .position(|v| v.digest == i.active_digest)
                .ok_or("Missing active extension version")?;
            let current = portable.remove(current);
            bundle.entries.push(PortableExtension {
                source_id: i.id,
                project_scoped: i.scope.is_some(),
                was_enabled: i.enabled,
                digest: current.digest,
                files: current.files,
                earlier: portable,
                draft: false,
                installed: i.installed,
            });
        }
        for id in drafts {
            check(stop)?;
            let lookup = id.clone();
            let p = self
                .0
                .storage
                .call(move |s| s.extension_preview(&lookup))
                .await
                .map_err(|e| e.to_string())?;
            if !visible(&p.scope, scope) {
                return Err("草稿不属于所选项目 / Draft belongs to another project".into());
            }
            let staged = self.stage_path(id)?;
            let root = if staged.exists() {
                staged
            } else {
                self.version_path(&p.version.digest)
            };
            bundle.entries.push(PortableExtension {
                source_id: p.id,
                project_scoped: p.scope.is_some(),
                was_enabled: false,
                files: read_files(&root, &p.version, &mut total, &mut count, stop)?,
                digest: p.version.digest,
                earlier: vec![],
                draft: true,
                installed: false,
            });
        }
        self.prepare_transfer(&bundle, scope, stop).await?;
        Ok(bundle)
    }
}
fn read_files(
    root: &Path,
    version: &PluginVersion,
    total: &mut usize,
    count: &mut usize,
    stop: &AtomicBool,
) -> Result<Vec<ExtensionArchiveFile>> {
    let mut files = vec![];
    for file in &version.files {
        check(stop)?;
        let bytes = package::read_verified(root, version, &file.path)?;
        *total += bytes.len();
        *count += 1;
        if *total > MAX_TOTAL || *count > 2048 {
            return Err(
                "扩展备份最多 2048 个文件、64 MiB 原文 / Extension archive capacity exceeded"
                    .into(),
            );
        }
        files.push(ExtensionArchiveFile {
            path: file.path.clone(),
            base64: STANDARD.encode(bytes),
        });
    }
    Ok(files)
}
