use super::*;
use serde_json::{Value, json};
impl Store {
    /// Trusted application resource, installed once; a user's disable/uninstall survives restarts.
    pub fn extension_builtin(
        &mut self,
        installation: &PluginInstallation,
        version: &PluginVersion,
    ) -> Result<()> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "INSERT OR IGNORE INTO extension_versions(digest,data_json) VALUES(?1,?2)",
            params![version.digest, encode(version)?],
        )?;
        let created=tx.execute("INSERT OR IGNORE INTO extension_installations(id,scope,slug,data_json) VALUES(?1,'',?2,?3)",params![installation.id,installation.slug,encode(installation)?])?;
        if created == 1 {
            tx.execute("INSERT INTO extension_history(installation_id,action,at_ms,data_json) VALUES(?1,'builtin_installed',?2,?3)",params![installation.id,now_ms(),encode(installation)?])?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn extension_content_allowed(&self, text: &str) -> Result<()> {
        if self.redactor.contains_registered_secret(text) {
            return Err(Error::Invalid(
                "extension content contains a configured credential",
            ));
        }
        Ok(())
    }
    pub fn extension_discard_preview(&mut self, id: &str) -> Result<()> {
        self.connection
            .execute("UPDATE extension_previews SET consumed=1 WHERE id=?1", [id])?;
        self.extension_log(None, "preview_discarded", json!({"preview_id":id}))
    }
    pub fn extension_previews(&self) -> Result<Vec<PluginPreview>> {
        let mut q=self.connection.prepare("SELECT data_json FROM extension_previews WHERE consumed=0 ORDER BY rowid DESC LIMIT 128")?;
        q.query_map([], |r| r.get::<_, String>(0))?
            .map(|r| Ok(serde_json::from_str(&r?)?))
            .collect()
    }
    pub fn extension_installations(&self) -> Result<Vec<PluginInstallation>> {
        let mut q = self.connection.prepare(
            "SELECT data_json FROM extension_installations ORDER BY rowid DESC LIMIT 512",
        )?;
        q.query_map([], |r| r.get::<_, String>(0))?
            .map(|r| Ok(serde_json::from_str(&r?)?))
            .collect()
    }
    pub fn extension_installation(&self, id: &str) -> Result<PluginInstallation> {
        let raw: String = self
            .connection
            .query_row(
                "SELECT data_json FROM extension_installations WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or(Error::NotFound)?;
        Ok(serde_json::from_str(&raw)?)
    }
    pub fn extension_version(&self, digest: &str) -> Result<PluginVersion> {
        let raw: String = self
            .connection
            .query_row(
                "SELECT data_json FROM extension_versions WHERE digest=?1",
                [digest],
                |r| r.get(0),
            )
            .optional()?
            .ok_or(Error::NotFound)?;
        Ok(serde_json::from_str(&raw)?)
    }
    pub fn extension_preview(&self, id: &str) -> Result<PluginPreview> {
        let raw: String = self
            .connection
            .query_row(
                "SELECT data_json FROM extension_previews WHERE id=?1 AND consumed=0",
                [id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or(Error::NotFound)?;
        Ok(serde_json::from_str(&raw)?)
    }
    pub fn extension_save_preview(&mut self, preview: &PluginPreview) -> Result<()> {
        let n: u32 = self.connection.query_row(
            "SELECT count(*) FROM extension_previews WHERE consumed=0",
            [],
            |r| r.get(0),
        )?;
        if n >= 128 {
            return Err(Error::Invalid("too many pending extension previews"));
        }
        self.connection.execute(
            "INSERT INTO extension_previews(id,data_json) VALUES(?1,?2)",
            params![preview.id, encode(preview)?],
        )?;
        self.extension_log(None,if preview.draft{"draft_created"}else{"package_preview"},json!({"preview_id":preview.id,"scope":preview.scope,"name":preview.version.manifest.name,"digest":preview.version.digest}))
    }
    pub fn extension_commit_preview(
        &mut self,
        preview: &PluginPreview,
        installation: &PluginInstallation,
    ) -> Result<()> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let count: u32 = tx.query_row("SELECT count(*) FROM extension_installations", [], |r| {
            r.get(0)
        })?;
        if preview.installed_id.is_none() && count >= 512 {
            return Err(Error::Invalid("extension installation limit reached"));
        }
        let current: Option<String> = tx
            .query_row(
                "SELECT data_json FROM extension_installations WHERE scope=?1 AND slug=?2",
                params![
                    installation.scope.as_deref().unwrap_or(""),
                    installation.slug
                ],
                |r| r.get(0),
            )
            .optional()?;
        let revision = current
            .map(|v| serde_json::from_str::<PluginInstallation>(&v))
            .transpose()?
            .map(|i| i.revision);
        if revision != preview.expected_revision {
            return Err(Error::Conflict);
        }
        if tx.execute(
            "UPDATE extension_previews SET consumed=1 WHERE id=?1 AND consumed=0",
            [&preview.id],
        )? != 1
        {
            return Err(Error::Conflict);
        }
        tx.execute(
            "INSERT OR IGNORE INTO extension_versions(digest,data_json) VALUES(?1,?2)",
            params![preview.version.digest, encode(&preview.version)?],
        )?;
        tx.execute("INSERT INTO extension_installations(id,scope,slug,data_json) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json",params![installation.id,installation.scope.as_deref().unwrap_or(""),installation.slug,encode(installation)?])?;
        tx.execute(
            "DELETE FROM extension_catalogs WHERE installation_id=?1",
            [&installation.id],
        )?;
        tx.execute("INSERT INTO extension_history(installation_id,action,at_ms,data_json) VALUES(?1,'installed',?2,?3)",params![installation.id,now_ms(),encode(installation)?])?;
        tx.commit()?;
        Ok(())
    }
    pub fn extension_update(
        &mut self,
        mut value: PluginInstallation,
        expected: u32,
        action: &str,
    ) -> Result<PluginInstallation> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let raw: String = tx.query_row(
            "SELECT data_json FROM extension_installations WHERE id=?1",
            [&value.id],
            |r| r.get(0),
        )?;
        let old: PluginInstallation = serde_json::from_str(&raw)?;
        if old.revision != expected || old.slug != value.slug || old.scope != value.scope {
            return Err(Error::Conflict);
        }
        value.revision = expected.checked_add(1).ok_or(Error::Conflict)?;
        value.at_ms = now_ms();
        tx.execute(
            "UPDATE extension_installations SET data_json=?2 WHERE id=?1",
            params![value.id, encode(&value)?],
        )?;
        tx.execute(
            "DELETE FROM extension_catalogs WHERE installation_id=?1",
            [&value.id],
        )?;
        tx.execute("INSERT INTO extension_history(installation_id,action,at_ms,data_json) VALUES(?1,?2,?3,?4)",params![value.id,action,now_ms(),encode(&value)?])?;
        tx.commit()?;
        Ok(value)
    }
    pub fn extension_log(
        &mut self,
        id: Option<&str>,
        action: &str,
        mut value: Value,
    ) -> Result<()> {
        self.redactor.value(&mut value);
        self.connection.execute("INSERT INTO extension_history(installation_id,action,at_ms,data_json) VALUES(?1,?2,?3,?4)",params![id,action,now_ms(),encode(&value)?])?;
        Ok(())
    }
    pub fn extension_history(&self, id: Option<&str>) -> Result<Vec<Value>> {
        let mut q=self.connection.prepare("SELECT sequence,installation_id,action,at_ms,data_json FROM extension_history WHERE ?1 IS NULL OR installation_id=?1 ORDER BY sequence DESC LIMIT 64")?;
        let rows = q.query_map([id], |r| {
            Ok((
                r.get::<_, u64>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, u64>(3)?,
                r.get::<_, String>(4)?,
            ))
        })?;
        rows.map(|r|{let (seq,id,action,at,data)=r?;Ok(json!({"sequence":seq,"installation_id":id,"action":action,"at_ms":at,"data":serde_json::from_str::<Value>(&data)?}))}).collect()
    }
    pub fn extension_catalog(&self, id: &str, server: &str) -> Result<Option<Value>> {
        self.connection.query_row("SELECT data_json FROM extension_catalogs WHERE installation_id=?1 AND server_id=?2",params![id,server],|r|r.get::<_,String>(0)).optional()?.map(|s|serde_json::from_str(&s).map_err(Error::from)).transpose()
    }
    pub fn extension_save_catalog(
        &mut self,
        id: &str,
        server: &str,
        revision: u32,
        mut value: Value,
    ) -> Result<()> {
        if self.extension_installation(id)?.revision != revision {
            return Err(Error::Conflict);
        }
        self.redactor.value(&mut value);
        self.connection.execute("INSERT INTO extension_catalogs(installation_id,server_id,data_json) VALUES(?1,?2,?3) ON CONFLICT(installation_id,server_id) DO UPDATE SET data_json=excluded.data_json",params![id,server,encode(&value)?])?;
        Ok(())
    }
    pub fn extension_credential(
        &self,
        id: &str,
        server: &str,
        key: &str,
    ) -> Result<Option<CredentialRef>> {
        Ok(self.connection.query_row("SELECT credential_ref FROM extension_credentials WHERE installation_id=?1 AND server_id=?2 AND key=?3",params![id,server,key],|r|r.get::<_,String>(0)).optional()?.map(|id|CredentialRef{id}))
    }
    pub fn extension_credentials(&self, id: &str) -> Result<Vec<CredentialRef>> {
        let mut q = self
            .connection
            .prepare("SELECT credential_ref FROM extension_credentials WHERE installation_id=?1")?;
        q.query_map([id], |r| Ok(CredentialRef { id: r.get(0)? }))?
            .map(|r| r.map_err(Error::from))
            .collect()
    }
    pub fn extension_clear_credentials(&mut self, id: &str) -> Result<()> {
        self.connection.execute(
            "DELETE FROM extension_credentials WHERE installation_id=?1",
            [id],
        )?;
        Ok(())
    }
    pub fn extension_replace_credential(
        &mut self,
        id: &str,
        server: &str,
        key: &str,
        reference: Option<&CredentialRef>,
        expected: u32,
    ) -> Result<PluginInstallation> {
        let mut i = self.extension_installation(id)?;
        if i.revision != expected {
            return Err(Error::Conflict);
        }
        i.revision += 1;
        i.at_ms = now_ms();
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(reference) = reference {
            tx.execute("INSERT INTO extension_credentials VALUES(?1,?2,?3,?4) ON CONFLICT(installation_id,server_id,key) DO UPDATE SET credential_ref=excluded.credential_ref",params![id,server,key,reference.id])?;
        } else {
            tx.execute("DELETE FROM extension_credentials WHERE installation_id=?1 AND server_id=?2 AND key=?3",params![id,server,key])?;
        }
        tx.execute(
            "UPDATE extension_installations SET data_json=?2 WHERE id=?1",
            params![id, encode(&i)?],
        )?;
        tx.execute(
            "DELETE FROM extension_catalogs WHERE installation_id=?1",
            [id],
        )?;
        tx.execute("INSERT INTO extension_history(installation_id,action,at_ms,data_json) VALUES(?1,'credential_changed',?2,?3)",params![id,now_ms(),json!({"server":server,"key":key,"revision":i.revision}).to_string()])?;
        tx.commit()?;
        Ok(i)
    }
}
