use super::*;

impl Manager {
    pub(super) async fn handle_team_restore(
        &self,
        action: TaskArchiveAction,
        media: &crate::media::Manager,
    ) -> Result<Value> {
        if let TaskArchiveAction::TeamRestoreOptions { archive_id } = action {
            let stop = self.stop.clone();
            return self
                .storage
                .call(move |s| s.task_group_restore_options(&archive_id, &stop))
                .await
                .map_err(|e| e.to_string());
        }
        let (archive_id, project_id, profiles, fingerprint) = match action {
            TaskArchiveAction::TeamRestorePreview {
                archive_id,
                project_id,
                profiles,
            } => (archive_id, project_id, profiles, None),
            TaskArchiveAction::TeamRestore {
                archive_id,
                project_id,
                profiles,
                fingerprint,
            } => (archive_id, project_id, profiles, Some(fingerprint)),
            _ => unreachable!(),
        };
        let (archive, project, mappings, stop) = (
            archive_id.clone(),
            project_id.clone(),
            profiles.clone(),
            self.stop.clone(),
        );
        let mut preview = self
            .storage
            .call(move |s| {
                s.task_group_restore_preview(&archive, project.as_deref(), &mappings, &stop)
            })
            .await
            .map_err(|e| e.to_string())?;
        let candidates = if preview["already_restored"] == true {
            vec![]
        } else {
            self.prepare_archive_media(&archive_id, media).await?
        };
        let (archive, data, prepared) = (archive_id.clone(), preview.clone(), candidates.clone());
        preview = self
            .storage
            .call(move |s| s.task_restore_media_preview(&archive, data, &prepared))
            .await
            .map_err(|e| e.to_string())?;
        if preview["already_restored"] != true {
            self.verify_restoration_history(&archive_id, &preview)
                .await?;
            let project = project_id.clone();
            let target = self
                .storage
                .call(move |s| s.task_restore_target(project.as_deref()))
                .await
                .map_err(|e| e.to_string())?;
            if let Some((project, identity)) = target {
                Root::open(&project.settings.root_path,identity.as_deref()).map_err(|_|"目标项目文件夹已变化或无法访问 / Target project folder changed or unavailable")?;
            }
        }
        if let Some(fingerprint) = fingerprint {
            let stop = self.stop.clone();
            let (result, events) = self
                .storage
                .call(move |s| {
                    s.restore_task_group_with_media(
                        &archive_id,
                        project_id.as_deref(),
                        &profiles,
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
