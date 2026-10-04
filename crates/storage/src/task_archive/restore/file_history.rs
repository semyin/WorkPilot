use super::*;

pub(super) fn mapped_targets(
    index: &TaskArchiveIndex,
    task: &str,
    project: &Option<(WorkspaceProject, Option<String>)>,
    explicit: Option<&BTreeMap<String, String>>,
) -> Result<BTreeMap<String, String>> {
    let roots = index
        .file_history
        .iter()
        .filter(|h| h.revision.task_id == task)
        .map(|h| h.root_identity.clone())
        .collect::<HashSet<_>>();
    if let Some(explicit) = explicit {
        return roots
            .into_iter()
            .map(|r| {
                let target = explicit
                    .get(&r)
                    .cloned()
                    .ok_or(Error::Invalid("missing source folder mapping"))?;
                Ok((r, target))
            })
            .collect();
    }
    if roots.is_empty() {
        return Ok(BTreeMap::new());
    }
    if roots.len() != 1 {
        return Err(Error::Invalid(
            "多个原文件夹需要分别映射 / Map each original folder separately",
        ));
    }
    let target = project
        .as_ref()
        .and_then(|p| p.1.as_ref())
        .ok_or(Error::Invalid(
            "请选择本机项目文件夹 / Select a local project folder",
        ))?;
    Ok(roots.into_iter().map(|r| (r, target.clone())).collect())
}
pub(super) fn summary(index: &TaskArchiveIndex) -> Value {
    json!(index.file_history.iter().map(|h| {
        let r=&h.revision;
        json!({"task_id":r.task_id,"path":r.path,"previous_path":r.previous_path,"change":r.change,"at_ms":r.at_ms,"before_exists":r.before.exists,"before_bytes":r.before.bytes,"after_exists":r.after.exists,"after_bytes":r.after.bytes})
    }).collect::<Vec<_>>())
}
pub(super) fn install(
    tx: &rusqlite::Transaction<'_>,
    index: &TaskArchiveIndex,
    mapping: &BTreeMap<String, String>,
    roots: &BTreeMap<String, String>,
    created: u64,
    stop: &AtomicBool,
) -> Result<()> {
    let mut operations = BTreeMap::new();
    for item in &index.file_history {
        check_stop(stop)?;
        let r = &item.revision;
        let task = mapping
            .get(&r.task_id)
            .ok_or(Error::Invalid("foreign file revision"))?;
        let operation_key = (task.clone(), r.operation_id.clone());
        let operation = if let Some(id) = operations.get(&operation_key) {
            id
        } else {
            let operation = id();
            let op=WorkbenchOperation {
                id:operation.clone(),task_id:task.clone(),fingerprint:digest(index.archive_id.as_bytes()),kind:"history_import".into(),
                summary:"随任务恢复文件历史；当前项目文件未改动 / Restored task file history; project files unchanged".into(),
                state:"completed".into(),at_ms:created,output:None,input:None,stdout:None,stderr:None,error:None,pid:None,preview_port:None,
            };
            tx.execute("INSERT INTO workbench_operations(id,task_id,fingerprint,data_json,started) VALUES(?1,?2,?3,?4,1)",params![op.id,task,op.fingerprint,encode(&op)?])?;
            operations.entry(operation_key).or_insert(operation)
        };
        let row = FileRevision {
            id: id(),
            task_id: task.clone(),
            root_identity: roots
                .get(&item.root_identity)
                .cloned()
                .ok_or(Error::Invalid("missing source folder mapping"))?,
            operation_id: operation.clone(),
            path: r.path.clone(),
            previous_path: r.previous_path.clone(),
            change: r.change.clone(),
            source: "task_archive_restore".into(),
            at_ms: r.at_ms,
            before: r.before.local_image(),
            after: r.after.local_image(),
            origin: Some(r.origin.clone().unwrap_or_else(|| FileRevisionOrigin {
                archive_id: index.archive_id.clone(),
                revision_id: r.id.clone(),
                task_id: r.task_id.clone(),
                operation_id: r.operation_id.clone(),
                source: r.source.clone(),
            })),
        };
        tx.execute("INSERT INTO file_revisions(id,task_id,root_identity,path,operation_id,data_json) VALUES(?1,?2,?3,?4,?5,?6)",params![row.id,row.task_id,row.root_identity,row.path,row.operation_id,encode(&row)?])?;
    }
    Ok(())
}
