use super::*;

/// Destructive operations are available only through the local desktop's offline helper.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum MaintenanceSelection {
    Unreferenced,
    Versions {
        root_identity: String,
        keep_last: u32,
        older_than_days: u32,
    },
    Tasks {
        root_task_ids: Vec<String>,
    },
    Archives {
        archive_ids: Vec<String>,
    },
    Reset,
}
impl MaintenanceSelection {
    pub fn validate(&self) -> Result<(), &'static str> {
        match self {
            Self::Versions {
                root_identity,
                keep_last,
                older_than_days,
            } => {
                if root_identity.is_empty()
                    || root_identity.len() > 4096
                    || !(1..=1000).contains(keep_last)
                    || *older_than_days > 36500
                {
                    return Err("invalid history retention rule");
                }
            }
            Self::Tasks { root_task_ids }
            | Self::Archives {
                archive_ids: root_task_ids,
            } if root_task_ids.is_empty()
                || root_task_ids.len() > 128
                || root_task_ids.iter().any(|i| !valid_id(i))
                || root_task_ids
                    .iter()
                    .collect::<std::collections::BTreeSet<_>>()
                    .len()
                    != root_task_ids.len() =>
            {
                return Err("select 1..128 distinct items");
            }
            _ => (),
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum MaintenanceAction {
    Catalog,
    Preview { selection: MaintenanceSelection },
}
impl MaintenanceAction {
    pub fn validate(&self) -> Result<(), &'static str> {
        if let Self::Preview { selection } = self {
            selection.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaintenanceApply {
    pub selection: MaintenanceSelection,
    pub fingerprint: String,
    pub confirmation: String,
    pub backup_path: Option<String>,
    pub backup_password: Option<SecretInput>,
}
