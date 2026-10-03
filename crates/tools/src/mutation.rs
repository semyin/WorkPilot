//! Shared by model tools and the user-facing project workspace.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock, Weak},
};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};
pub type Lease = Option<Arc<OwnedMutexGuard<()>>>;
pub async fn acquire(identity: Option<&str>, name: &str) -> Lease {
    if !matches!(name, "write_file" | "run_command" | "workbench") {
        return None;
    }
    let identity = identity?;
    static LOCKS: OnceLock<Mutex<HashMap<String, Weak<AsyncMutex<()>>>>> = OnceLock::new();
    let lock = {
        let mut locks = LOCKS
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        locks.retain(|_, weak| weak.strong_count() > 0);
        if let Some(lock) = locks.get(identity).and_then(Weak::upgrade) {
            lock
        } else {
            let lock = Arc::new(AsyncMutex::new(()));
            locks.insert(identity.to_owned(), Arc::downgrade(&lock));
            lock
        }
    };
    Some(Arc::new(lock.lock_owned().await))
}
