use crate::models::Handled;
use std::{collections::HashMap, path::PathBuf};
use tokio::{sync::mpsc, task::JoinHandle};
use workpilot_contracts::*;
use workpilot_storage::{Inspector, Storage};

pub struct Workspace {
    storage: Storage,
    directory: PathBuf,
    out: mpsc::Sender<Wire>,
    jobs: HashMap<String, JoinHandle<()>>,
}
impl Workspace {
    pub fn new(storage: Storage, directory: PathBuf, out: mpsc::Sender<Wire>) -> Self {
        Self {
            storage,
            directory,
            out,
            jobs: HashMap::new(),
        }
    }
    pub fn dispatch(&mut self, request: &Request) -> Handled {
        if !matches!(
            &request.command,
            Command::Workspace { .. }
                | Command::Read {
                    query: Query::Workspace {
                        query: WorkspaceQuery::SearchRecords { .. }
                    }
                }
        ) {
            return Handled::No;
        }
        self.jobs.retain(|_, j| !j.is_finished());
        if self.jobs.len() >= 2 || self.jobs.contains_key(&request.request_id) {
            return Handled::Reply(Box::new(Response::Error {
                code: ErrorCode::Busy,
                message: "A workspace operation is still running. Please retry after it finishes."
                    .into(),
            }));
        }
        let (storage, directory, out, req) = (
            self.storage.clone(),
            self.directory.clone(),
            self.out.clone(),
            request.clone(),
        );
        let handle = tokio::spawn(async move {
            let result = run(storage, directory, &req, &out).await;
            let response = match result {
                Ok(data) => Response::Workspace {
                    data: Box::new(data),
                },
                Err(e) => Response::Error {
                    code: e.code(),
                    message: e.to_string(),
                },
            };
            let _ = out
                .send(Wire::Reply {
                    request_id: req.request_id,
                    response,
                })
                .await;
        });
        self.jobs.insert(request.request_id.clone(), handle);
        Handled::Deferred
    }
    pub async fn shutdown(self) {
        for (_, job) in self.jobs {
            let _ = job.await;
        }
    }
}
async fn run(
    storage: Storage,
    directory: PathBuf,
    request: &Request,
    out: &mpsc::Sender<Wire>,
) -> workpilot_storage::Result<WorkspaceData> {
    match &request.command {
        Command::Read {
            query:
                Query::Workspace {
                    query:
                        WorkspaceQuery::SearchRecords {
                            task_id,
                            text,
                            after,
                            limit,
                        },
                },
        } => {
            let (task, text, after, limit) = (task_id.clone(), text.clone(), *after, *limit);
            tokio::task::spawn_blocking(move || {
                Inspector::open(&directory)?
                    .search_workspace_records(&directory, &task, &text, after, limit)
            })
            .await
            .map_err(|_| workpilot_storage::Error::WorkerClosed)?
        }
        Command::Workspace {
            action: WorkspaceAction::ExportRecords { task_id },
        } => {
            let (req, task) = (request.clone(), task_id.clone());
            if let Some(data) = storage
                .call(move |s| s.begin_workspace_export(&req, &task))
                .await?
            {
                return Ok(data);
            }
            let task = task_id.clone();
            let data = tokio::task::spawn_blocking(move || {
                Inspector::open(&directory)?.export_workspace_records(&directory, &task)
            })
            .await
            .map_err(|_| workpilot_storage::Error::WorkerClosed)??;
            let (req, task, saved) = (request.clone(), task_id.clone(), data.clone());
            let events = storage
                .call(move |s| s.finish_workspace_export(&req, &task, &saved))
                .await?;
            let _ = crate::publish(out, events).await;
            Ok(data)
        }
        Command::Workspace { action } => {
            let mut action = action.clone();
            let identity = if let WorkspaceAction::SaveProject { settings, .. } = &mut action {
                let path = settings.root_path.clone();
                let root = tokio::task::spawn_blocking(move || {
                    workpilot_tools::files::Root::open(&path, None)
                })
                .await
                .map_err(|_| workpilot_storage::Error::WorkerClosed)?
                .map_err(|_| {
                    workpilot_storage::Error::Invalid("project folder is unavailable or is a link")
                })?;
                settings.root_path = root.path.to_string_lossy().into_owned();
                Some(root.identity)
            } else {
                None
            };
            let req = request.clone();
            let (data, events) = storage
                .call(move |s| s.workspace_action(&req, &action, identity))
                .await?;
            let _ = crate::publish(out, events).await;
            Ok(data)
        }
        _ => Err(workpilot_storage::Error::Invalid("workspace operation")),
    }
}
