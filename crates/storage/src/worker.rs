use crate::{Error, Result, Store};
use std::path::PathBuf;
use tokio::sync::{mpsc, oneshot};

pub const WORK_QUEUE_CAPACITY: usize = 32;
type Job = Box<dyn FnOnce(&mut Store) + Send>;
/// One owning thread, bounded mailbox. SQLite and filesystem I/O never run on
/// the async executor. Callers await backpressure; they must not spawn unbounded jobs.
#[derive(Clone)]
pub struct Storage {
    sender: mpsc::Sender<Job>,
}
impl Storage {
    pub async fn open(directory: PathBuf) -> Result<Self> {
        let (sender, mut receiver) = mpsc::channel::<Job>(WORK_QUEUE_CAPACITY);
        let (ready, opened) = oneshot::channel();
        std::thread::Builder::new()
            .name("workpilot-storage".into())
            .spawn(move || {
                let mut store = match Store::open(&directory) {
                    Ok(store) => {
                        let _ = ready.send(Ok(()));
                        store
                    }
                    Err(error) => {
                        let _ = ready.send(Err(error));
                        return;
                    }
                };
                while let Some(job) = receiver.blocking_recv() {
                    job(&mut store);
                }
            })?;
        opened.await.map_err(|_| Error::WorkerClosed)??;
        Ok(Self { sender })
    }
    pub async fn call<T: Send + 'static>(
        &self,
        action: impl FnOnce(&mut Store) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let (send, receive) = oneshot::channel();
        self.sender
            .send(Box::new(move |store| {
                let _ = send.send(action(store));
            }))
            .await
            .map_err(|_| Error::WorkerClosed)?;
        receive.await.map_err(|_| Error::WorkerClosed)?
    }
}
