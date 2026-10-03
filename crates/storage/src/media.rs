use super::*;
impl Store {
    pub fn media_put(&mut self, asset: &MediaAsset, original: &str, parsed: &str) -> Result<()> {
        let count: u32 = self.connection.query_row(
            "SELECT count(*) FROM media_assets WHERE removed=0",
            [],
            |r| r.get(0),
        )?;
        if count >= 10000 {
            return Err(Error::Invalid("attachment library limit reached"));
        }
        self.connection.execute("INSERT INTO media_assets(id,task_id,data_json,original_blob,parsed_blob) VALUES(?1,?2,?3,?4,?5)",params![asset.id,asset.task_id,encode(asset)?,original,parsed])?;
        Ok(())
    }
    pub fn media_asset(&self, id: &str) -> Result<(MediaAsset, String, String)> {
        self.connection.query_row("SELECT data_json,original_blob,parsed_blob FROM media_assets WHERE id=?1 AND removed=0",[id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).optional()?.ok_or(Error::NotFound).and_then(|(j,o,p)|Ok((serde_json::from_str(&j)?,o,p)))
    }
    pub fn media_list(&self, task: &str) -> Result<Vec<MediaAsset>> {
        let mut q=self.connection.prepare("SELECT data_json FROM media_assets WHERE task_id=?1 AND removed=0 ORDER BY rowid DESC LIMIT 256")?;
        q.query_map([task], |r| r.get::<_, String>(0))?
            .map(|r| Ok(serde_json::from_str(&r?)?))
            .collect()
    }
    pub fn media_bind(&mut self, task: &str, ids: &[String]) -> Result<()> {
        if self.task_archived(task)? {
            return Err(Error::Invalid("archived task"));
        }
        self.execution_snapshot(task)?;
        let items = ids
            .iter()
            .map(|id| self.media_asset(id).map(|v| v.0))
            .collect::<Result<Vec<_>>>()?;
        if items
            .iter()
            .any(|a| a.task_id.as_deref().is_some_and(|t| t != task))
        {
            return Err(Error::Invalid("attachment belongs to another task"));
        }
        let tx = self.connection.transaction()?;
        for mut item in items {
            item.task_id = Some(task.into());
            tx.execute(
                "UPDATE media_assets SET task_id=?2,data_json=?3 WHERE id=?1",
                params![item.id, task, encode(&item)?],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn media_remove(&mut self, id: &str) -> Result<()> {
        self.connection
            .execute("UPDATE media_assets SET removed=1 WHERE id=?1", [id])?;
        Ok(())
    }
    pub fn image_services(&self) -> Result<Vec<ImageService>> {
        let mut q = self
            .connection
            .prepare("SELECT data_json FROM image_services ORDER BY rowid")?;
        q.query_map([], |r| r.get::<_, String>(0))?
            .map(|r| Ok(serde_json::from_str(&r?)?))
            .collect()
    }
    pub fn image_service(&self, id: &str) -> Result<ImageService> {
        self.image_services()?
            .into_iter()
            .find(|s| s.id == id)
            .ok_or(Error::NotFound)
    }
    pub fn image_service_save(&mut self, service: &ImageService) -> Result<()> {
        let old = self.image_services()?;
        let previous = old.iter().find(|s| s.id == service.id);
        if previous.map_or(1, |s| s.revision + 1) != service.revision {
            return Err(Error::Conflict);
        }
        if previous.is_none() && old.len() >= 32 {
            return Err(Error::Invalid("too many image services"));
        }
        self.connection.execute("INSERT INTO image_services(id,data_json) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json",params![service.id,encode(service)?])?;
        Ok(())
    }
    pub fn image_service_remove(&mut self, id: &str) -> Result<()> {
        self.connection
            .execute("DELETE FROM image_services WHERE id=?1", [id])?;
        Ok(())
    }
    pub fn media_safe_value(&self, mut value: serde_json::Value) -> serde_json::Value {
        self.redactor.value(&mut value);
        value
    }
}
