use super::*;

impl Store {
    pub fn restore_task_archive(
        &mut self,
        archive: &str,
        project: Option<&str>,
        profile: &str,
        fingerprint: &str,
        stop: &AtomicBool,
    ) -> Result<(Value, Vec<Event>)> {
        self.restore_task_archive_with_media(archive, project, profile, fingerprint, &[], stop)
    }
    pub fn restore_task_archive_with_media(
        &mut self,
        archive: &str,
        project: Option<&str>,
        profile: &str,
        fingerprint: &str,
        media: &[TaskRestoreMedia],
        stop: &AtomicBool,
    ) -> Result<(Value, Vec<Event>)> {
        check_stop(stop)?;
        if let Some(mut receipt) = self.restoration_receipt(archive)? {
            receipt["duplicate"] = json!(true);
            return Ok((receipt, vec![]));
        }
        let mut p = self.prepare_task_restore(archive, project, profile, stop)?;
        p.fingerprint = self.restore_media_fingerprint(&p.index, &p.fingerprint, media)?;
        if p.fingerprint != fingerprint {
            return Err(Error::Conflict);
        }
        self.commit_restored_group(
            archive,
            team::Group {
                fingerprint: p.fingerprint.clone(),
                nodes: vec![p],
                graph: None,
                media: media.to_vec(),
            },
            stop,
        )
    }
}
