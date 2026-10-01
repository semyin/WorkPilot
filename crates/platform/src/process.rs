use std::{
    io,
    process::{Child, Command, Stdio},
};

/// Owns the trusted WorkPilot engine and its process group.
/// The engine must wait for stdin commands before creating descendants.
/// This is lifecycle containment, NOT isolation for untrusted tools (P04).
pub struct ManagedEngine {
    pub child: Child,
    terminated: bool,
    #[cfg(windows)]
    job: usize,
    #[cfg(unix)]
    group: i32,
}

impl ManagedEngine {
    pub fn spawn(command: &mut Command) -> io::Result<Self> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let child = command.spawn()?;
        #[cfg(windows)]
        {
            let mut child = child;
            use std::{mem::size_of, os::windows::io::AsRawHandle, ptr};
            use windows_sys::Win32::{
                Foundation::CloseHandle,
                System::JobObjects::{
                    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
                    SetInformationJobObject,
                },
            };
            // SAFETY: all pointers refer to initialized local structures. The job
            // handle is owned here, non-inheritable, and closed exactly once.
            let job = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
            if job.is_null() {
                let error = io::Error::last_os_error();
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = unsafe {
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const _,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) != 0
                    && AssignProcessToJobObject(job, child.as_raw_handle()) != 0
            };
            if !configured {
                let error = io::Error::last_os_error();
                unsafe {
                    CloseHandle(job);
                }
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
            Ok(Self {
                child,
                terminated: false,
                job: job as usize,
            })
        }
        #[cfg(unix)]
        {
            let group = child.id() as i32;
            Ok(Self {
                child,
                group,
                terminated: false,
            })
        }
    }

    pub fn terminate(&mut self) -> io::Result<()> {
        if self.terminated {
            return Ok(());
        }
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::JobObjects::TerminateJobObject;
            // SAFETY: job remains valid until Drop.
            if unsafe { TerminateJobObject(self.job as _, 1) } == 0 {
                return Err(io::Error::last_os_error());
            }
        }
        #[cfg(unix)]
        {
            // SAFETY: the negative id identifies only the group we created.
            let result = unsafe { libc::kill(-self.group, libc::SIGKILL) };
            if result != 0 && io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) {
                return Err(io::Error::last_os_error());
            }
        }
        self.terminated = true;
        let _ = self.child.wait()?;
        Ok(())
    }
}
impl Drop for ManagedEngine {
    fn drop(&mut self) {
        let _ = self.terminate();
        #[cfg(windows)]
        {
            // SAFETY: this is the final owner of the non-inherited handle.
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(self.job as _);
            }
        }
    }
}
