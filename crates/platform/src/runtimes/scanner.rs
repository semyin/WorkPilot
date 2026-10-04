//! A fixed worker count overlaps independent file reads without caching path
//! checks. The owning helper process still has the same lifetime and I/O limits.
use super::{FileEntry, checked_file};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    io::{self, Read},
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{self, RecvTimeoutError},
    },
    thread,
    time::Duration,
};

const WORKERS: usize = 4;
enum Event {
    Open(usize),
    Progress,
    Complete(usize, io::Result<()>),
}
fn cancelled() -> io::Error {
    io::Error::new(io::ErrorKind::Interrupted, "Installation check cancelled")
}

pub(super) fn inspect_files(
    base: &Path,
    files: &[FileEntry],
    verify: bool,
    stop: &AtomicBool,
    progress: &mut impl FnMut(Option<&str>, bool) -> io::Result<()>,
) -> io::Result<Vec<io::Result<()>>> {
    let cursor = AtomicUsize::new(0);
    let abandoned = AtomicBool::new(false);
    thread::scope(|scope| {
        // Bound progress and results even if output is slow or cancelled.
        let (sender, receiver) = mpsc::sync_channel(32);
        for _ in 0..WORKERS.min(files.len()) {
            let sender = sender.clone();
            let cursor = &cursor;
            let abandoned = &abandoned;
            scope.spawn(move || {
                let active = || !stop.load(Ordering::Relaxed) && !abandoned.load(Ordering::Relaxed);
                while active() {
                    let index = cursor.fetch_add(1, Ordering::Relaxed);
                    let Some(file) = files.get(index) else {
                        break;
                    };
                    if sender.send(Event::Open(index)).is_err() {
                        break;
                    }
                    let result = inspect_file(base, file, verify, || {
                        if !active() {
                            return Err(cancelled());
                        }
                        sender.send(Event::Progress).map_err(|_| cancelled())
                    });
                    if sender.send(Event::Complete(index, result)).is_err() {
                        break;
                    }
                }
            });
        }
        drop(sender);
        let result = (|| {
            let mut states: Vec<Option<io::Result<()>>> = (0..files.len()).map(|_| None).collect();
            let mut active = BTreeSet::new();
            let mut complete = 0;
            while complete < files.len() {
                if stop.load(Ordering::Relaxed) {
                    return Err(cancelled());
                }
                let before_open = match receiver.recv_timeout(Duration::from_millis(50)) {
                    Ok(Event::Open(index)) => {
                        active.insert(index);
                        true
                    }
                    Ok(Event::Progress) => false,
                    Ok(Event::Complete(index, result)) => {
                        active.remove(&index);
                        states[index] = Some(result);
                        complete += 1;
                        true
                    }
                    Err(RecvTimeoutError::Timeout) => continue,
                    Err(RecvTimeoutError::Disconnected) => {
                        return Err(io::Error::other("Runtime scanner ended before completion"));
                    }
                };
                // Keep the earliest outstanding file visible. A later fast
                // worker must not hide an older read when the helper times out.
                let path = active.first().map(|index| files[*index].path.as_str());
                progress(path, before_open)?;
            }
            states
                .into_iter()
                .map(|state| {
                    state.ok_or_else(|| io::Error::other("Runtime scanner omitted a result"))
                })
                .collect()
        })();
        abandoned.store(true, Ordering::Relaxed);
        drop(receiver);
        result
    })
}

fn inspect_file(
    base: &Path,
    file: &FileEntry,
    verify: bool,
    mut progress: impl FnMut() -> io::Result<()>,
) -> io::Result<()> {
    // Every file still checks every path component. No cached directory result
    // can conceal a replaced directory or reparse point during a later read.
    let path = checked_file(base, &file.path)?;
    if fs::metadata(&path)?.len() != file.bytes {
        return Err(io::Error::other("size mismatch"));
    }
    if !verify {
        return Ok(());
    }
    let mut input = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    let mut bytes = 0u64;
    loop {
        progress()?;
        let size = input.read(&mut buffer)?;
        if size == 0 {
            break;
        }
        bytes += size as u64;
        if bytes > file.bytes {
            return Err(io::Error::other("file grew during check"));
        }
        hash.update(&buffer[..size]);
    }
    if bytes != file.bytes || format!("{:x}", hash.finalize()) != file.sha256 {
        return Err(io::Error::other("content mismatch"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parallel_results_keep_manifest_order_detect_bad_files_and_propagate_cancellation() {
        let dir = tempfile::tempdir().unwrap();
        let files: Vec<_> = (0..24)
            .map(|index| {
                let text = format!("checked file {index:02}");
                let path = format!("file-{index:02}.txt");
                fs::write(dir.path().join(&path), &text).unwrap();
                FileEntry {
                    path,
                    bytes: text.len() as u64,
                    sha256: format!("{:x}", Sha256::digest(text.as_bytes())),
                }
            })
            .collect();
        fs::write(dir.path().join(&files[3].path), "changed file 03").unwrap();
        fs::remove_file(dir.path().join(&files[7].path)).unwrap();
        let stop = AtomicBool::new(false);
        let results = inspect_files(dir.path(), &files, true, &stop, &mut |_, _| Ok(())).unwrap();
        assert_eq!(results.len(), files.len());
        for (index, result) in results.iter().enumerate() {
            assert_eq!(result.is_ok(), index != 3 && index != 7);
        }
        assert_eq!(
            results[7].as_ref().unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
        let cancelled_scan = inspect_files(dir.path(), &files, true, &stop, &mut |_, _| {
            stop.store(true, Ordering::Relaxed);
            Ok(())
        });
        assert_eq!(
            cancelled_scan.unwrap_err().kind(),
            io::ErrorKind::Interrupted
        );
        let broken_output = inspect_files(
            dir.path(),
            &files,
            true,
            &AtomicBool::new(false),
            &mut |_, _| Err(io::ErrorKind::BrokenPipe.into()),
        );
        assert_eq!(broken_output.unwrap_err().kind(), io::ErrorKind::BrokenPipe);
    }
}
