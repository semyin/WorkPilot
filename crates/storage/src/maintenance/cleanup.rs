use super::*;
impl Store {
    pub fn maintenance_cleanup_pending(&self) -> Result<Value> {
        let s: Option<String> = self
            .connection
            .query_row(
                "SELECT value_json FROM settings WHERE key='maintenance-pending-reset'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        Ok(s.map(|s| serde_json::from_str(&s))
            .transpose()?
            .unwrap_or(Value::Null))
    }
    pub fn maintenance_credentials(&self) -> Result<Value> {
        // Credential namespaces used the engine's original path spelling, which can
        // differ from the canonical Windows path. Ready records preserve that spelling.
        let mut paths = BTreeSet::from([self.directory.to_string_lossy().into_owned()]);
        for path in strings(
            &self.connection,
            "SELECT DISTINCT json_extract(payload_json,'$.data_dir') FROM events WHERE task_id IS NULL AND json_extract(payload_json,'$.kind')='ready' AND json_extract(payload_json,'$.data_dir') IS NOT NULL",
        )? {
            if Path::new(&path).canonicalize().ok().as_ref() == Some(&self.directory) {
                paths.insert(path);
            }
        }
        let mut entries = BTreeSet::new();
        for path in paths {
            let hash = format!("{:x}", Sha256::digest(path.as_bytes()));
            for (sql, namespace) in [
                (
                    "SELECT json_extract(data_json,'$.credential.id') FROM provider_profiles WHERE json_extract(data_json,'$.credential.id') IS NOT NULL",
                    format!("models-{hash}"),
                ),
                (
                    "SELECT json_extract(snapshot_json,'$.credential.id') FROM profile_versions WHERE json_extract(snapshot_json,'$.credential.id') IS NOT NULL",
                    format!("models-{hash}"),
                ),
                (
                    "SELECT credential_ref FROM extension_credentials",
                    format!("extensions-{}", &hash[..20]),
                ),
                (
                    "SELECT json_extract(data_json,'$.credential.id') FROM image_services WHERE json_extract(data_json,'$.credential.id') IS NOT NULL",
                    "image-services".to_owned(),
                ),
            ] {
                for raw in strings(&self.connection, sql)? {
                    // Early extension schemas stored a serialized CredentialRef.
                    let id = serde_json::from_str::<CredentialRef>(&raw)
                        .map(|r| r.id)
                        .unwrap_or(raw);
                    if !valid_id(&id) {
                        return Err(Error::Corrupt("credential reference"));
                    }
                    entries.insert((namespace.clone(), id));
                }
            }
        }
        let marker = self.directory.join("versions/key-id");
        if marker.exists() {
            if marker.canonicalize()? != marker || std::fs::metadata(&marker)?.len() > 128 {
                return Err(Error::Corrupt("vault key marker"));
            }
            let id = std::fs::read_to_string(marker)?;
            if !valid_id(&id) {
                return Err(Error::Corrupt("vault credential"));
            }
            entries.insert(("file-history".into(), id));
        }
        Ok(json!(
            entries
                .into_iter()
                .map(|(namespace, id)| json!({"namespace":namespace,"id":id}))
                .collect::<Vec<_>>()
        ))
    }
    pub(super) fn maintenance_reset_rows(&mut self) -> Result<()> {
        let pending = self.maintenance_cleanup_pending()?;
        let credentials = if pending.is_null() {
            self.maintenance_credentials()?
        } else {
            pending["credentials"].clone()
        };
        let tables = strings(
            &self.connection,
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )?;
        let protected_roots = self.maintenance_project_paths()?;
        // The exclusive offline owner wipes every application row in one transaction.
        // Credentials remain in a durable retry journal until OS and file cleanup succeeds.
        self.connection.execute_batch("PRAGMA foreign_keys=OFF;")?;
        let result = (|| -> Result<()> {
            let tx = self
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            for table in tables {
                if !table
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_')
                {
                    return Err(Error::Corrupt("table identifier"));
                }
                tx.execute(&format!("DELETE FROM {table}"), [])?;
            }
            tx.execute(
                "INSERT INTO settings(key,value_json) VALUES('maintenance-pending-reset',?1)",
                [encode(
                    &json!({"credentials":credentials,"protected_roots":protected_roots,"started_at_ms":now_ms()}),
                )?],
            )?;
            tx.commit()?;
            Ok(())
        })();
        self.connection.execute_batch("PRAGMA foreign_keys=ON;")?;
        result
    }
    pub fn maintenance_finish_reset(&mut self) -> Result<()> {
        self.connection.execute(
            "DELETE FROM settings WHERE key='maintenance-pending-reset'",
            [],
        )?;
        // Remove deleted history bytes from free pages and truncate the WAL.
        self.connection.execute_batch(
            "PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);",
        )?;
        Ok(())
    }
}
