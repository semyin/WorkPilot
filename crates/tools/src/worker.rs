//! Dropping a future requests cancellation; task completion waits for owned work.
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::Notify;
struct Activity {
    stop: Arc<AtomicBool>,
    done: AtomicBool,
    notify: Notify,
}
fn activities() -> &'static Mutex<HashMap<String, Arc<Activity>>> {
    static ITEMS: OnceLock<Mutex<HashMap<String, Arc<Activity>>>> = OnceLock::new();
    ITEMS.get_or_init(|| Mutex::new(HashMap::new()))
}
struct StopOnDrop(Arc<Activity>);
impl Drop for StopOnDrop {
    fn drop(&mut self) {
        self.0.stop.store(true, Ordering::SeqCst);
    }
}
pub async fn run<T: Send + 'static>(
    run_id: &str,
    work: impl FnOnce(Arc<AtomicBool>) -> T + Send + 'static,
) -> Result<T, tokio::task::JoinError> {
    let state = Arc::new(Activity {
        stop: Arc::new(AtomicBool::new(false)),
        done: AtomicBool::new(false),
        notify: Notify::new(),
    });
    activities()
        .lock()
        .unwrap()
        .insert(run_id.into(), state.clone());
    let _cancel = StopOnDrop(state.clone());
    let result = tokio::task::spawn_blocking(move || {
        struct Done(Arc<Activity>);
        impl Drop for Done {
            fn drop(&mut self) {
                self.0.done.store(true, Ordering::SeqCst);
                self.0.notify.notify_one();
            }
        }
        let _done = Done(state.clone());
        work(state.stop.clone())
    })
    .await;
    settle(run_id).await;
    result
}
pub async fn settle(run_id: &str) {
    let state = activities().lock().unwrap().get(run_id).cloned();
    if let Some(state) = state {
        while !state.done.load(Ordering::SeqCst) {
            state.notify.notified().await;
        }
        activities().lock().unwrap().remove(run_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn dropping_async_call_waits_until_owned_work_observes_stop() {
        let id = uuid::Uuid::new_v4().to_string();
        let task = id.clone();
        let completed = Arc::new(AtomicBool::new(false));
        let observed = completed.clone();
        let handle = tokio::spawn(async move {
            run(&task, move |stop| {
                while !stop.load(Ordering::SeqCst) {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                std::thread::sleep(std::time::Duration::from_millis(30));
                observed.store(true, Ordering::SeqCst);
            })
            .await
        });
        while !activities().lock().unwrap().contains_key(&id) {
            tokio::task::yield_now().await;
        }
        handle.abort();
        let _ = handle.await;
        tokio::time::timeout(std::time::Duration::from_secs(2), settle(&id))
            .await
            .unwrap();
        assert!(completed.load(Ordering::SeqCst));
        assert!(!activities().lock().unwrap().contains_key(&id));
    }
}
