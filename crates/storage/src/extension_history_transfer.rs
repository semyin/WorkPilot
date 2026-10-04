use super::*;
impl Store {
    /// All versions belonging to this installation, not the paged UI history.
    pub fn extension_owned_versions(&self, installation: &str) -> Result<Vec<PluginVersion>> {
        let current = self.extension_installation(installation)?;
        let mut hashes = std::collections::BTreeSet::from([current.active_digest.clone()]);
        let mut q = self.connection.prepare("SELECT DISTINCT json_extract(data_json,'$.active_digest') FROM extension_history WHERE installation_id=?1 AND json_extract(data_json,'$.active_digest') IS NOT NULL LIMIT 129")?;
        for row in q.query_map([installation], |r| r.get::<_, String>(0))? {
            hashes.insert(row?);
        }
        if hashes.len() > 128 {
            return Err(Error::Invalid(
                "扩展版本超过 128 项，未截断 / Extension exceeds 128 versions",
            ));
        }
        hashes
            .into_iter()
            .map(|hash| {
                let v = self.extension_version(&hash)?;
                if v.manifest.id != current.slug {
                    return Err(Error::Corrupt("extension version ownership"));
                }
                Ok(v)
            })
            .collect()
    }
}
