use super::*;

pub(super) fn collect_refs(
    value: &Value,
    refs: &mut BTreeMap<String, ContentRef>,
    depth: u32,
) -> Result<()> {
    if depth > 64 {
        return Err(Error::Invalid("archive reference nesting exceeds limit"));
    }
    match value {
        Value::Object(map) => {
            if map.get("object_id").is_some_and(Value::is_string)
                && map.get("bytes").is_some_and(Value::is_u64)
                && map.get("media_type").is_some_and(Value::is_string)
            {
                let r: ContentRef = serde_json::from_value(value.clone())?;
                if !task_archive_checksum(&r.object_id) {
                    return Err(Error::Invalid("invalid content reference"));
                }
                if let Some(old) = refs.insert(r.object_id.clone(), r.clone())
                    && old != r
                {
                    return Err(Error::Invalid("conflicting content references"));
                }
            } else {
                for value in map.values() {
                    collect_refs(value, refs, depth + 1)?;
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_refs(value, refs, depth + 1)?;
            }
        }
        // Tool results sometimes contain a JSON document encoded as text.
        Value::String(text) if text.starts_with(['{', '[']) => {
            if let Ok(value) = serde_json::from_str::<Value>(text) {
                collect_refs(&value, refs, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}
pub(super) fn validate_bundle(
    index: &TaskArchiveIndex,
    blobs: &BTreeMap<String, Vec<u8>>,
) -> Result<TaskArchiveSnapshot> {
    index.validate().map_err(Error::Invalid)?;
    if blobs.len() != index.objects.len() {
        return Err(Error::Invalid("archive content set mismatch"));
    }
    let mut refs = BTreeMap::new();
    for reference in &index.objects {
        let bytes = blobs
            .get(&reference.object_id)
            .ok_or(Error::Invalid("missing archive object"))?;
        if bytes.len() as u64 != reference.bytes || digest(bytes) != reference.object_id {
            return Err(Error::Corrupt("archive checksum"));
        }
        if reference.media_type == "application/json" {
            collect_refs(&serde_json::from_slice(bytes)?, &mut refs, 0)?;
        }
    }
    for reference in refs.values() {
        if !index.objects.contains(reference) {
            return Err(Error::Invalid(
                "档案缺少关联正文 / Archive has missing linked content",
            ));
        }
    }
    let snapshot: TaskArchiveSnapshot = serde_json::from_slice(&blobs[&index.snapshot.object_id])?;
    if snapshot.version != 1
        || snapshot.source_schema != 11
        || snapshot.root_task_id != index.root_task_id
        || snapshot.tables.len() != TASK_ARCHIVE_TABLES.len()
        || snapshot.tables.iter().any(|(name, rows)| {
            index.counts.get(name).copied() != Some(rows.len() as u32)
                || rows.iter().any(|r| !r.is_object())
        })
    {
        return Err(Error::Invalid("archive record index mismatch"));
    }
    let tasks = &snapshot.tables["tasks"];
    let members = &snapshot.tables["team_members"];
    if tasks.len() != index.tasks.len() || members.len() + 1 != tasks.len() {
        return Err(Error::Invalid("archive task graph mismatch"));
    }
    for task in &index.tasks {
        if tasks
            .iter()
            .filter(|r| r["id"] == task.id && r["title"] == task.title)
            .count()
            != 1
            || task.parent_task_id.as_ref().is_some_and(|parent| {
                members
                    .iter()
                    .filter(|r| {
                        r["task_id"] == task.id
                            && r["parent_task_id"] == *parent
                            && r["root_task_id"] == index.root_task_id
                    })
                    .count()
                    != 1
            })
        {
            return Err(Error::Invalid("archive task relationship mismatch"));
        }
    }
    // Every explicitly task-owned record must be part of the selected tree.
    for rows in snapshot.tables.values() {
        for row in rows {
            if let Some(task) = row.get("task_id").and_then(Value::as_str)
                && !index.tasks.iter().any(|t| t.id == task)
            {
                return Err(Error::Invalid("archive contains unrelated task records"));
            }
        }
    }
    Ok(snapshot)
}
