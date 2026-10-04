use super::*;
use serde_json::{Value, json};

fn receipt_key(archive: &str, scope: Option<&str>) -> String {
    format!(
        "extension-import:{:x}",
        Sha256::digest(json!([archive, scope]).to_string().as_bytes())
    )
}
impl Store {
    pub fn extension_transfer_preview(
        &self,
        archive: &str,
        scope: Option<&str>,
        digest: &str,
        candidates: &[ExtensionImportCandidate],
    ) -> Result<Value> {
        if !valid_id(archive) || candidates.is_empty() || candidates.len() > 32 {
            return Err(Error::Invalid("invalid extension archive"));
        }
        let key = receipt_key(archive, scope);
        let old: Option<String> = self
            .connection
            .query_row(
                "SELECT value_json FROM settings WHERE key=?1",
                [&key],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(old) = old {
            let receipt: Value = serde_json::from_str(&old)?;
            if receipt["digest"] != digest {
                return Err(Error::Conflict);
            }
            return Ok(json!({"already_imported":true,"receipt":receipt,"conflicts":[]}));
        }
        let installs = self.extension_installations()?;
        let count: usize =
            self.connection
                .query_row("SELECT count(*) FROM extension_installations", [], |r| {
                    r.get(0)
                })?;
        let mut conflicts = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for item in candidates {
            if !valid_id(&item.source_id)
                || (item.scope.is_some() && item.scope.as_deref() != scope)
                || (!item.draft
                    && !seen.insert((item.scope.clone(), item.version.manifest.id.clone())))
                || item.earlier.len() > 127
                || item
                    .earlier
                    .iter()
                    .any(|v| v.manifest.id != item.version.manifest.id)
                || (item.draft && (item.installed || !item.earlier.is_empty()))
            {
                return Err(Error::Invalid("invalid extension target mapping"));
            }
            if !item.draft
                && installs
                    .iter()
                    .any(|i| i.scope == item.scope && i.slug == item.version.manifest.id)
            {
                conflicts.push(format!(
                    "{}：目标范围已有同名记录 / Same extension already exists in target scope",
                    item.version.manifest.name
                ));
            }
        }
        if count + candidates.iter().filter(|c| !c.draft).count() > 512 {
            conflicts.push("已安装记录将超过 512 项 / Installation limit would be exceeded".into());
        }
        let drafts = self.extension_previews()?;
        if drafts.len() + candidates.iter().filter(|c| c.draft).count() > 128 {
            conflicts
                .push("待确认扩展将超过 128 项 / Pending extension limit would be exceeded".into());
        }
        let state: Vec<_> = installs
            .iter()
            .map(|i| {
                json!([
                    i.id,
                    i.revision,
                    i.scope,
                    i.active_digest,
                    i.enabled,
                    i.installed
                ])
            })
            .collect();
        Ok(
            json!({"already_imported":false,"conflicts":conflicts,"destination_state":[count,state,drafts.iter().map(|p|json!([p.id,p.version.digest,p.scope,p.expected_revision])).collect::<Vec<_>>()]}),
        )
    }

    pub fn import_extensions(
        &mut self,
        archive: &str,
        scope: Option<&str>,
        digest: &str,
        candidates: &[ExtensionImportCandidate],
        expected: &Value,
    ) -> Result<Value> {
        let current = self.extension_transfer_preview(archive, scope, digest, candidates)?;
        if &current != expected {
            return Err(Error::Conflict);
        }
        if current["already_imported"] == true {
            return Ok(current["receipt"].clone());
        }
        if current["conflicts"]
            .as_array()
            .is_none_or(|v| !v.is_empty())
        {
            return Err(Error::Conflict);
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut mappings = Vec::new();
        for item in candidates.iter().filter(|i| !i.draft) {
            let installation = PluginInstallation {
                id: id(),
                scope: item.scope.clone(),
                slug: item.version.manifest.id.clone(),
                source: format!("Migrated archive {archive} / {}", item.source_id),
                active_digest: item.version.digest.clone(),
                enabled: false,
                installed: item.installed,
                revision: 1,
                at_ms: now_ms(),
            };
            tx.execute(
                "INSERT OR IGNORE INTO extension_versions(digest,data_json) VALUES(?1,?2)",
                params![item.version.digest, encode(&item.version)?],
            )?;
            for v in &item.earlier {
                tx.execute(
                    "INSERT OR IGNORE INTO extension_versions(digest,data_json) VALUES(?1,?2)",
                    params![v.digest, encode(v)?],
                )?;
                let mut historical = installation.clone();
                historical.active_digest = v.digest.clone();
                historical.at_ms = v.created_at_ms;
                tx.execute("INSERT INTO extension_history(installation_id,action,at_ms,data_json) VALUES(?1,'imported_version',?2,?3)",params![installation.id,v.created_at_ms,encode(&historical)?])?;
            }
            tx.execute(
                "INSERT INTO extension_installations(id,scope,slug,data_json) VALUES(?1,?2,?3,?4)",
                params![
                    installation.id,
                    installation.scope.as_deref().unwrap_or(""),
                    installation.slug,
                    encode(&installation)?
                ],
            )?;
            tx.execute("INSERT INTO extension_history(installation_id,action,at_ms,data_json) VALUES(?1,'imported_disabled',?2,?3)",
                params![installation.id, now_ms(), encode(&installation)?])?;
            mappings.push(json!({"source_id":item.source_id,"installation_id":installation.id,"scope":installation.scope,"digest":installation.active_digest}));
        }
        let mut previews = vec![];
        for item in candidates.iter().filter(|i| i.draft) {
            let existing = tx
                .query_row(
                    "SELECT data_json FROM extension_installations WHERE scope=?1 AND slug=?2",
                    params![
                        item.scope.as_deref().unwrap_or(""),
                        item.version.manifest.id
                    ],
                    |r| r.get::<_, String>(0),
                )
                .optional()?
                .map(|raw| serde_json::from_str::<PluginInstallation>(&raw))
                .transpose()?;
            let p = PluginPreview {
                id: id(),
                source: format!("Migrated draft {archive} / {}", item.source_id),
                scope: item.scope.clone(),
                version: item.version.clone(),
                expected_revision: existing.as_ref().map(|i| i.revision),
                installed_id: existing.as_ref().map(|i| i.id.clone()),
                draft: true,
            };
            tx.execute(
                "INSERT INTO extension_previews(id,data_json) VALUES(?1,?2)",
                params![p.id, encode(&p)?],
            )?;
            tx.execute("INSERT INTO extension_history(installation_id,action,at_ms,data_json) VALUES(NULL,'draft_imported',?1,?2)",params![now_ms(),encode(&json!({"preview_id":p.id,"name":p.version.manifest.name,"scope":p.scope,"digest":p.version.digest}))?])?;
            previews.push(json!({"source_id":item.source_id,"preview_id":p.id,"scope":p.scope,"digest":p.version.digest}));
        }
        let receipt = json!({"archive_id":archive,"digest":digest,"at_ms":now_ms(),"installations":mappings,"drafts":previews,"enabled":false,"credentials_included":false});
        tx.execute(
            "INSERT INTO settings(key,value_json) VALUES(?1,?2)",
            params![receipt_key(archive, scope), encode(&receipt)?],
        )?;
        tx.commit()?;
        Ok(receipt)
    }
}
