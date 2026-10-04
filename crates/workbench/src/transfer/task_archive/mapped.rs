use super::*;
impl Manager {
    pub(in crate::transfer) async fn handle_mapped_restore(
        &self,
        action: TaskArchiveAction,
        media: &crate::media::Manager,
    ) -> Result<Value> {
        let (archive, profiles, projects, roots, confirm) = match action {
            TaskArchiveAction::MappedRestorePreview {
                archive_id,
                profiles,
                projects,
                history_roots,
            } => (archive_id, profiles, projects, history_roots, None),
            TaskArchiveAction::MappedRestore {
                archive_id,
                profiles,
                projects,
                history_roots,
                fingerprint,
            } => (
                archive_id,
                profiles,
                projects,
                history_roots,
                Some(fingerprint),
            ),
            _ => unreachable!(),
        };
        let (a, p, d, r, stop) = (
            archive.clone(),
            profiles.clone(),
            projects.clone(),
            roots.clone(),
            self.stop.clone(),
        );
        let mut preview = self
            .storage
            .call(move |s| s.mapped_task_restore_preview(&a, &p, &d, &r, &stop))
            .await
            .map_err(|e| e.to_string())?;
        let candidates = if preview["already_restored"] == true {
            vec![]
        } else {
            self.prepare_archive_media(&archive, media).await?
        };
        let (a, v, c) = (archive.clone(), preview.clone(), candidates.clone());
        preview = self
            .storage
            .call(move |s| s.task_restore_media_preview(&a, v, &c))
            .await
            .map_err(|e| e.to_string())?;
        if preview["already_restored"] != true {
            self.verify_restoration_history(&archive, &preview).await?;
            let ids = projects
                .iter()
                .filter_map(|p| p.project_id.clone())
                .chain(roots.iter().map(|r| r.project_id.clone()))
                .collect::<std::collections::BTreeSet<_>>();
            for id in ids {
                let target = self
                    .storage
                    .call(move |s| s.task_restore_target(Some(&id)))
                    .await
                    .map_err(|e| e.to_string())?
                    .ok_or("Target project missing")?;
                Root::open(&target.0.settings.root_path, target.1.as_deref())
                    .map_err(|_| "目标文件夹已经变化 / Target folder changed")?;
            }
        }
        if let Some(fingerprint) = confirm {
            let stop = self.stop.clone();
            let (result, events) = self
                .storage
                .call(move |s| {
                    s.restore_mapped_task_group(
                        &archive,
                        &profiles,
                        &projects,
                        &roots,
                        &fingerprint,
                        &candidates,
                        &stop,
                    )
                })
                .await
                .map_err(|e| e.to_string())?;
            for event in events {
                if !matches!(event.payload, Payload::RestoredMessage { .. }) {
                    let _ = self
                        .out
                        .send(Wire::Event {
                            event: Box::new(event),
                        })
                        .await;
                }
            }
            Ok(result)
        } else {
            Ok(preview)
        }
    }
}
