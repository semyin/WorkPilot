use super::*;
pub(super) fn collect(value: &Value, found: &mut BTreeSet<String>) {
    match value {
        Value::String(s)
            if s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) =>
        {
            found.insert(s.clone());
        }
        Value::Array(a) => {
            for v in a {
                collect(v, found);
            }
        }
        Value::Object(o) => {
            for v in o.values() {
                collect(v, found);
            }
        }
        _ => (),
    }
}
impl Store {
    pub fn maintenance_required_vault_roots(&self) -> Result<BTreeSet<String>> {
        let mut ids = BTreeSet::new();
        for sql in [
            "SELECT json_extract(data_json,'$.before.blob') FROM file_revisions WHERE json_extract(data_json,'$.before.blob') IS NOT NULL",
            "SELECT json_extract(data_json,'$.after.blob') FROM file_revisions WHERE json_extract(data_json,'$.after.blob') IS NOT NULL",
            "SELECT original_blob FROM media_assets UNION SELECT parsed_blob FROM media_assets",
            "SELECT spec_blob FROM workbench_operations WHERE spec_blob IS NOT NULL",
            "SELECT json_extract(m.value,'$.entry.sha256') FROM settings s,json_each(s.value_json,'$.index.media') m WHERE s.key GLOB 'task-archive:*' AND json_extract(m.value,'$.entry.sha256') IS NOT NULL",
            "SELECT json_extract(m.value,'$.revision.before.sha256') FROM settings s,json_each(s.value_json,'$.index.file_history') m WHERE s.key GLOB 'task-archive:*' AND json_extract(m.value,'$.revision.before.sha256') IS NOT NULL",
            "SELECT json_extract(m.value,'$.revision.after.sha256') FROM settings s,json_each(s.value_json,'$.index.file_history') m WHERE s.key GLOB 'task-archive:*' AND json_extract(m.value,'$.revision.after.sha256') IS NOT NULL",
            "SELECT t.value FROM settings s,json_tree(s.value_json) t WHERE s.key GLOB 'migration:*' AND t.key='manifest_blob' AND t.type='text'",
        ] {
            for id in strings(&self.connection, sql)? {
                if id.len() == 64 {
                    ids.insert(id);
                }
            }
        }
        Ok(ids)
    }
    pub fn maintenance_vault_roots(&self) -> Result<BTreeSet<String>> {
        let mut roots = BTreeSet::new();
        for sql in [
            "SELECT data_json FROM file_revisions",
            "SELECT data_json FROM file_captures WHERE state!='completed'",
            "SELECT json_array(original_blob,parsed_blob) FROM media_assets",
            "SELECT json_array(spec_blob) FROM workbench_operations WHERE spec_blob IS NOT NULL",
            "SELECT value_json FROM settings WHERE key NOT GLOB 'maintenance:*'",
        ] {
            for data in strings(&self.connection, sql)? {
                collect(&serde_json::from_str(&data)?, &mut roots);
            }
        }
        // Artifact receipts can hold a browser download's encrypted original.
        let mut q = self.connection.prepare(
            "SELECT DISTINCT r.object_id FROM revisions r JOIN artifacts a ON a.id=r.artifact_id",
        )?;
        for row in q.query_map([], |r| r.get::<_, String>(0))? {
            let id = row?;
            let content = content_ref(&self.connection, &id)?;
            objects::verify(&self.directory, &content)?;
            if content.bytes <= 1024 * 1024 {
                let data = std::fs::read(objects::object_path(&self.directory, &id)?)?;
                if let Ok(value) = serde_json::from_slice(&data) {
                    collect(&value, &mut roots);
                }
            }
        }
        Ok(roots)
    }
}
