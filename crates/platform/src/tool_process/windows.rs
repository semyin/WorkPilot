use super::*;
use std::{
    ffi::OsStr,
    fs::{self, File},
    io::{Read, Write},
    mem::size_of,
    os::windows::{ffi::OsStrExt, io::FromRawHandle},
    ptr,
    sync::atomic::Ordering,
    time::Instant,
};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, HANDLE, HANDLE_FLAG_INHERIT, LocalFree, SetHandleInformation, WAIT_OBJECT_0,
    },
    Security::{
        self, Authorization::*, DACL_SECURITY_INFORMATION, Isolation::*, PSID, SECURITY_ATTRIBUTES,
        SECURITY_CAPABILITIES, SUB_CONTAINERS_AND_OBJECTS_INHERIT,
    },
    Storage::FileSystem::{DELETE, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE},
    System::{JobObjects::*, Pipes::CreatePipe, Threading::*},
};
fn wide(s: impl AsRef<OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain(Some(0)).collect()
}
struct Handle(HANDLE);
unsafe impl Send for Handle {}
impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}
fn checked(handle: HANDLE) -> io::Result<Handle> {
    if handle.is_null() {
        Err(io::Error::last_os_error())
    } else {
        Ok(Handle(handle))
    }
}
fn win(result: i32) -> io::Result<()> {
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
#[derive(serde::Serialize, serde::Deserialize)]
struct Ledger {
    name: String,
    paths: Vec<PathBuf>,
}
struct Sandbox {
    sid: PSID,
    ledger: Ledger,
    path: PathBuf,
}
impl Sandbox {
    fn new(spec: &ProcessSpec, extra: Option<&ProcessInput>) -> io::Result<Self> {
        fs::create_dir_all(&spec.ledger_dir)?;
        let name = format!("WorkPilot.Tool.{}", uuid::Uuid::new_v4());
        let text = wide(&name);
        let mut sid = ptr::null_mut();
        let hr = unsafe {
            CreateAppContainerProfile(
                text.as_ptr(),
                text.as_ptr(),
                text.as_ptr(),
                ptr::null(),
                0,
                &mut sid,
            )
        };
        if hr < 0 {
            return Err(io::Error::other(format!(
                "AppContainer creation failed: {hr:#x}"
            )));
        }
        let path = spec.ledger_dir.join(format!("{name}.json"));
        let mut sandbox = Self {
            sid,
            ledger: Ledger {
                name,
                paths: vec![],
            },
            path,
        };
        let runtime_root = crate::runtimes::owned_read_root(&spec.program)?;
        let mut paths = vec![(&spec.cwd, true, true), (&spec.program, false, false)];
        if let Some(root) = &runtime_root {
            paths.push((root, false, true));
        }
        if let Some(input) = extra {
            paths.extend(input.read_roots.iter().map(|p| (p, false, true)));
        }
        for (path, write, inherit) in paths {
            // Windows ships system executables with AppContainer read access;
            // never attempt to change TrustedInstaller-owned system ACLs.
            let system =
                PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into()));
            if !write && path.starts_with(system) {
                continue;
            }
            // Journal before changing an ACL. Recovery only revokes this unique SID.
            sandbox.ledger.paths.push(path.clone());
            sandbox.persist()?;
            acl(path, sid, Some((write, inherit)))?;
        }
        Ok(sandbox)
    }
    fn persist(&self) -> io::Result<()> {
        let temp = self.path.with_extension("pending");
        let data = serde_json::to_vec(&self.ledger).map_err(io::Error::other)?;
        let mut file = File::create(&temp)?;
        file.write_all(&data)?;
        file.sync_all()?;
        drop(file);
        fs::rename(temp, &self.path)
    }
    fn cleanup(&mut self) -> Vec<String> {
        let mut errors = vec![];
        for path in &self.ledger.paths {
            if let Err(e) = acl(path, self.sid, None) {
                errors.push(format!("ACL cleanup: {e}"));
            }
        }
        if errors.is_empty() {
            let hr = unsafe { DeleteAppContainerProfile(wide(&self.ledger.name).as_ptr()) };
            if hr < 0 {
                errors.push(format!("AppContainer cleanup: {hr:#x}"));
            } else {
                let _ = fs::remove_file(&self.path);
            }
        }
        errors
    }
}
impl Drop for Sandbox {
    fn drop(&mut self) {
        if self.path.exists() {
            let _ = self.cleanup();
        }
        unsafe {
            Security::FreeSid(self.sid);
        }
    }
}
fn acl(path: &std::path::Path, sid: PSID, grant: Option<(bool, bool)>) -> io::Result<()> {
    // ACL read/modify/write must also serialize across separate engine processes.
    let mutex = checked(unsafe {
        CreateMutexW(ptr::null(), 0, wide("Local\\WorkPilot.ToolAcl.v1").as_ptr())
    })?;
    let wait = unsafe { WaitForSingleObject(mutex.0, 10000) };
    if wait != 0 && wait != 0x80 {
        return Err(io::Error::other("ACL update lock unavailable"));
    }
    struct Lock(Handle);
    impl Drop for Lock {
        fn drop(&mut self) {
            unsafe {
                ReleaseMutex(self.0.0);
            }
        }
    }
    let _lock = Lock(mutex);
    let name = wide(path);
    let mut old = ptr::null_mut();
    let mut descriptor = ptr::null_mut();
    let status = unsafe {
        GetNamedSecurityInfoW(
            name.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut old,
            ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    // A NULL DACL means unrestricted access, not an empty ACL. Adding one ACE to it
    // would remove the owner's existing access. Never rewrite such a boundary.
    if old.is_null() {
        if !descriptor.is_null() {
            unsafe {
                LocalFree(descriptor);
            }
        }
        return if grant.is_some() {
            Err(io::Error::other(
                "Cannot safely grant sandbox access to a path with a NULL DACL",
            ))
        } else {
            Ok(())
        };
    }
    let mut entry: EXPLICIT_ACCESS_W = unsafe { std::mem::zeroed() };
    entry.grfAccessMode = if grant.is_some() {
        GRANT_ACCESS
    } else {
        REVOKE_ACCESS
    };
    entry.grfAccessPermissions = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;
    if grant.is_some_and(|g| g.0) {
        entry.grfAccessPermissions |= FILE_GENERIC_WRITE | DELETE;
    }
    entry.grfInheritance = if grant.is_some_and(|g| g.1) {
        SUB_CONTAINERS_AND_OBJECTS_INHERIT
    } else {
        0
    };
    entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
    entry.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
    entry.Trustee.ptstrName = sid.cast();
    let mut updated = ptr::null_mut();
    let status = unsafe { SetEntriesInAclW(1, &entry, old, &mut updated) };
    let status = if status == 0 {
        unsafe {
            SetNamedSecurityInfoW(
                name.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                updated,
                ptr::null(),
            )
        }
    } else {
        status
    };
    unsafe {
        if !updated.is_null() {
            LocalFree(updated.cast());
        }
        if !descriptor.is_null() {
            LocalFree(descriptor);
        }
    }
    if status == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(status as i32))
    }
}

pub fn recover(directory: &std::path::Path) -> io::Result<Vec<String>> {
    if !directory.exists() {
        return Ok(vec![]);
    }
    let mut errors = vec![];
    for item in fs::read_dir(directory)? {
        let path = item?.path();
        if !matches!(
            path.extension().and_then(|s| s.to_str()),
            Some("json" | "pending")
        ) {
            continue;
        }
        let data = fs::read(&path)?;
        if data.len() > 65536 {
            errors.push("Sandbox recovery record too large".into());
            continue;
        }
        let l: Ledger = serde_json::from_slice(&data).map_err(io::Error::other)?;
        let Some(id) = l.name.strip_prefix("WorkPilot.Tool.") else {
            continue;
        };
        if uuid::Uuid::parse_str(id).is_err() || l.paths.len() > 10 {
            continue;
        }
        let mut sid = ptr::null_mut();
        let hr =
            unsafe { DeriveAppContainerSidFromAppContainerName(wide(&l.name).as_ptr(), &mut sid) };
        if hr < 0 {
            errors.push(format!("Sandbox identity recovery: {hr:#x}"));
            continue;
        }
        let mut sandbox = Sandbox {
            sid,
            ledger: l,
            path,
        };
        errors.extend(sandbox.cleanup());
    }
    Ok(errors)
}
fn pipe() -> io::Result<(Handle, Handle)> {
    let attr = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: ptr::null_mut(),
        bInheritHandle: 1,
    };
    let (mut r, mut w) = (ptr::null_mut(), ptr::null_mut());
    win(unsafe { CreatePipe(&mut r, &mut w, &attr, 0) })?;
    Ok((Handle(r), Handle(w)))
}
struct Attributes {
    buffer: Vec<usize>,
    pointer: LPPROC_THREAD_ATTRIBUTE_LIST,
}
impl Attributes {
    fn new(count: u32) -> io::Result<Self> {
        let mut bytes = 0;
        unsafe {
            InitializeProcThreadAttributeList(ptr::null_mut(), count, 0, &mut bytes);
        }
        let mut buffer = vec![0usize; bytes.div_ceil(size_of::<usize>())];
        let pointer = buffer.as_mut_ptr().cast();
        win(unsafe { InitializeProcThreadAttributeList(pointer, count, 0, &mut bytes) })?;
        Ok(Self { buffer, pointer })
    }
    fn set<T>(&mut self, kind: u32, value: &mut T) -> io::Result<()> {
        win(unsafe {
            UpdateProcThreadAttribute(
                self.pointer,
                0,
                kind as usize,
                (value as *mut T).cast(),
                size_of::<T>(),
                ptr::null_mut(),
                ptr::null_mut(),
            )
        })
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.pointer);
        }
        let _ = &self.buffer;
    }
}
struct Job(Handle);
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            TerminateJobObject(self.0.0, 1);
        }
    }
}
fn quote(arg: &OsStr) -> String {
    let plain = arg.to_string_lossy();
    if !plain.is_empty() && !plain.chars().any(|c| c.is_whitespace() || c == '"') {
        return plain.into_owned();
    }
    let mut result = String::from("\"");
    let mut slashes = 0;
    for c in arg.to_string_lossy().chars() {
        if c == '\\' {
            slashes += 1;
            continue;
        }
        if c == '"' {
            result.push_str(&"\\".repeat(slashes * 2 + 1));
        } else {
            result.push_str(&"\\".repeat(slashes));
        }
        result.push(c);
        slashes = 0;
    }
    result.push_str(&"\\".repeat(slashes * 2));
    result.push('"');
    result
}
fn capture(
    handle: Handle,
    limit: usize,
    overflow: Arc<AtomicBool>,
    observer: Option<ProcessObserver>,
    stderr: bool,
) -> std::thread::JoinHandle<io::Result<Vec<u8>>> {
    std::thread::spawn(move || {
        let raw = handle.0;
        std::mem::forget(handle);
        let mut file = unsafe { File::from_raw_handle(raw) };
        let mut result = vec![];
        let mut chunk = [0u8; 8192];
        loop {
            let n = file.read(&mut chunk)?;
            if n == 0 {
                break;
            }
            if result.len() + n > limit {
                result.extend_from_slice(&chunk[..limit - result.len()]);
                overflow.store(true, Ordering::SeqCst);
                break;
            }
            result.extend_from_slice(&chunk[..n]);
            if let Some(observer) = &observer {
                observer(if stderr {
                    ProcessProgress::Stderr(chunk[..n].to_vec())
                } else {
                    ProcessProgress::Stdout(chunk[..n].to_vec())
                });
            }
        }
        Ok(result)
    })
}
pub fn run(
    spec: ProcessSpec,
    stop: Arc<AtomicBool>,
    observer: Option<ProcessObserver>,
    input: Option<ProcessInput>,
) -> io::Result<ProcessResult> {
    if stop.load(Ordering::SeqCst) {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "cancelled before process creation",
        ));
    }
    let start = Instant::now();
    let mut sandbox = if spec.sandboxed {
        Some(Sandbox::new(&spec, input.as_ref())?)
    } else {
        None
    };
    if stop.load(Ordering::SeqCst) {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "cancelled during process preparation",
        ));
    }
    let job = Job(checked(unsafe {
        CreateJobObjectW(ptr::null(), ptr::null())
    })?);
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
    limits.BasicLimitInformation.ActiveProcessLimit = 32;
    win(unsafe {
        SetInformationJobObject(
            job.0.0,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    })?;
    // All inheritable pipe ends must be closed before another trusted Rust
    // launcher can spawn. HANDLE_LIST protects our child, not unrelated children.
    let creation = crate::process::creation_guard();
    let (input_read, input_write) = pipe()?;
    let (output_read, output_write) = pipe()?;
    let (error_read, error_write) = pipe()?;
    for h in [&input_write, &output_read, &error_read] {
        win(unsafe { SetHandleInformation(h.0, HANDLE_FLAG_INHERIT, 0) })?;
    }
    let mut inherited = [input_read.0, output_write.0, error_write.0];
    let mut attributes = Attributes::new(if sandbox.is_some() { 2 } else { 1 })?;
    attributes.set(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &mut inherited)?;
    let mut security = SECURITY_CAPABILITIES::default();
    if let Some(s) = &sandbox {
        security.AppContainerSid = s.sid;
        attributes.set(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &mut security)?;
    }
    let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = input_read.0;
    startup.StartupInfo.hStdOutput = output_write.0;
    startup.StartupInfo.hStdError = error_write.0;
    startup.lpAttributeList = attributes.pointer;
    let system = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    // Explicit environment only. No account keys, SSH agents, user profiles or proxy credentials.
    let mut variables = zeroize::Zeroizing::new(vec![
        format!(
            "APPDATA={}",
            if spec.sandboxed {
                spec.cwd.to_string_lossy().into_owned()
            } else {
                std::env::var("APPDATA").unwrap_or_else(|_| spec.cwd.to_string_lossy().into_owned())
            }
        ),
        format!(
            "LOCALAPPDATA={}",
            if spec.sandboxed {
                spec.cwd.to_string_lossy().into_owned()
            } else {
                std::env::var("LOCALAPPDATA")
                    .unwrap_or_else(|_| spec.cwd.to_string_lossy().into_owned())
            }
        ),
        format!("COMSPEC={system}\\System32\\cmd.exe"),
        format!(
            "PATH={};{system}\\System32;{system};{}",
            spec.program.parent().unwrap_or(&spec.cwd).display(),
            if spec.sandboxed {
                String::new()
            } else {
                std::env::var("PATH").unwrap_or_default()
            }
        ),
        format!("SystemRoot={system}"),
        // The embedded Python preconfiguration reads UTF-8 mode before its
        // isolated path setup; keep Chinese text safe through captured pipes.
        "PYTHONUTF8=1".into(),
        format!("TEMP={}", spec.cwd.display()),
        format!("TMP={}", spec.cwd.display()),
        format!(
            "USERPROFILE={}",
            if spec.sandboxed {
                spec.cwd.to_string_lossy().into_owned()
            } else {
                std::env::var("USERPROFILE")
                    .unwrap_or_else(|_| spec.cwd.to_string_lossy().into_owned())
            }
        ),
        format!("WINDIR={system}"),
    ]);
    if let Some(input) = &input {
        variables.extend(
            input
                .environment
                .iter()
                .map(|(k, v)| format!("{k}={}", v.as_str())),
        );
    }
    variables.sort_by_key(|v| v.to_ascii_uppercase());
    let mut environment =
        zeroize::Zeroizing::new(variables.iter().flat_map(wide).collect::<Vec<u16>>());
    environment.push(0);
    let executable = spec.program.to_string_lossy().replace('/', "\\");
    let mut command = wide(
        std::iter::once(quote(OsStr::new(&executable)))
            .chain(spec.args.iter().map(|s| quote(OsStr::new(s))))
            .collect::<Vec<_>>()
            .join(" "),
    );
    let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    win(unsafe {
        CreateProcessW(
            wide(&spec.program).as_ptr(),
            command.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            1,
            CREATE_SUSPENDED
                | CREATE_NO_WINDOW
                | CREATE_UNICODE_ENVIRONMENT
                | EXTENDED_STARTUPINFO_PRESENT,
            environment.as_ptr().cast(),
            wide(&spec.cwd).as_ptr(),
            &startup.StartupInfo,
            &mut process,
        )
    })
    .map_err(|e| io::Error::other(format!("CreateProcess: {e}")))?;
    let process_handle = Handle(process.hProcess);
    let thread_handle = Handle(process.hThread);
    drop((input_read, output_write, error_write));
    drop(creation);
    if let Err(e) = win(unsafe { AssignProcessToJobObject(job.0.0, process_handle.0) }) {
        unsafe {
            TerminateProcess(process_handle.0, 1);
        }
        return Err(e);
    }
    if let Some(observer) = &observer {
        observer(ProcessProgress::Started(process.dwProcessId));
    }
    if stop.load(Ordering::SeqCst) {
        win(unsafe { TerminateJobObject(job.0.0, 1) })?;
    } else if unsafe { ResumeThread(thread_handle.0) } == u32::MAX {
        return Err(io::Error::last_os_error());
    }
    let input_finished = Arc::new(AtomicBool::new(false));
    let input_worker = if let Some(input) = input {
        let done = input_finished.clone();
        let stop = stop.clone();
        Some(std::thread::spawn(move || {
            let raw = input_write.0;
            std::mem::forget(input_write);
            // SAFETY: the thread uniquely owns the non-inheritable pipe write handle.
            let mut file = unsafe { File::from_raw_handle(raw) };
            while !done.load(Ordering::SeqCst) && !stop.load(Ordering::SeqCst) {
                match input
                    .messages
                    .recv_timeout(std::time::Duration::from_millis(20))
                {
                    Ok(bytes) if bytes.len() <= 1024 * 1024 => {
                        if file.write_all(&bytes).is_err() {
                            break;
                        }
                    }
                    Ok(_) => {
                        stop.store(true, Ordering::SeqCst);
                        break;
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                    Err(_) => break,
                }
            }
        }))
    } else {
        drop(input_write);
        None
    };
    let overflow = Arc::new(AtomicBool::new(false));
    let stdout = capture(
        output_read,
        spec.output_limit,
        overflow.clone(),
        observer.clone(),
        false,
    );
    let stderr = capture(
        error_read,
        spec.output_limit,
        overflow.clone(),
        observer.clone(),
        true,
    );
    let mut stopped = None;
    let mut last_owned = Instant::now() - std::time::Duration::from_secs(1);
    loop {
        if let Some(observer) = &observer
            && last_owned.elapsed().as_millis() >= 400
        {
            #[repr(C)]
            struct Owned {
                assigned: u32,
                count: u32,
                pids: [usize; 32],
            }
            let mut owned = Owned {
                assigned: 0,
                count: 0,
                pids: [0; 32],
            };
            if unsafe {
                QueryInformationJobObject(
                    job.0.0,
                    JobObjectBasicProcessIdList,
                    (&mut owned as *mut Owned).cast(),
                    size_of::<Owned>() as u32,
                    ptr::null_mut(),
                )
            } != 0
            {
                observer(ProcessProgress::OwnedProcesses(
                    owned.pids[..(owned.count as usize).min(32)]
                        .iter()
                        .map(|p| *p as u32)
                        .collect(),
                ));
            }
            last_owned = Instant::now();
        }
        if stop.load(Ordering::SeqCst) {
            stopped = Some("cancelled".into());
            break;
        }
        if overflow.load(Ordering::SeqCst) {
            stopped = Some("output_limit".into());
            break;
        }
        if start.elapsed().as_millis() >= spec.timeout_ms as u128 {
            stopped = Some("timeout".into());
            break;
        }
        if unsafe { WaitForSingleObject(process_handle.0, 20) } == WAIT_OBJECT_0 {
            break;
        }
    }
    if stopped.is_some() {
        win(unsafe { TerminateJobObject(job.0.0, 1) })?;
    }
    unsafe {
        WaitForSingleObject(process_handle.0, 2000);
    }
    let mut exit_code = 0;
    win(unsafe { GetExitCodeProcess(process_handle.0, &mut exit_code) })?;
    // Main process exit does not grant descendants permission to outlive the tool.
    drop(job);
    input_finished.store(true, Ordering::SeqCst);
    if let Some(worker) = input_worker {
        let _ = worker.join();
    }
    let stdout = stdout
        .join()
        .map_err(|_| io::Error::other("stdout reader failed"))??;
    let stderr = stderr
        .join()
        .map_err(|_| io::Error::other("stderr reader failed"))??;
    if stopped.is_none() && overflow.load(Ordering::SeqCst) {
        stopped = Some("output_limit".into());
    }
    if stopped.is_none()
        && (std::str::from_utf8(&stdout).is_err() || std::str::from_utf8(&stderr).is_err())
    {
        stopped = Some("unsupported_output_encoding".into());
    }
    drop((thread_handle, process_handle));
    let cleanup_errors = sandbox.as_mut().map(Sandbox::cleanup).unwrap_or_default();
    Ok(ProcessResult {
        pid: process.dwProcessId,
        exit_code,
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        stopped,
        containment: if spec.sandboxed {
            "windows_appcontainer_no_network"
        } else {
            "account_access_with_job_lifecycle"
        }
        .into(),
        elapsed_ms: start.elapsed().as_millis() as u64,
        cleanup_errors,
    })
}

#[cfg(test)]
mod acl_tests {
    use super::*;
    #[test]
    fn null_dacl_is_not_replaced_with_a_single_sandbox_ace() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("owned.txt");
        fs::write(&path, "preserve access").unwrap();
        let mut sid = ptr::null_mut();
        let name = wide("WorkPilot.Tool.00000000-0000-4000-8000-000000000001");
        assert_eq!(
            unsafe { DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut sid) },
            0
        );
        assert_eq!(
            unsafe {
                SetNamedSecurityInfoW(
                    wide(&path).as_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION | Security::PROTECTED_DACL_SECURITY_INFORMATION,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null(),
                    ptr::null(),
                )
            },
            0
        );
        assert!(
            acl(&path, sid, Some((false, false)))
                .unwrap_err()
                .to_string()
                .contains("NULL DACL")
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "preserve access");
        assert!(acl(&path, sid, None).is_ok());
        unsafe {
            Security::FreeSid(sid);
        }
    }
}
