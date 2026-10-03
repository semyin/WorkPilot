use std::{fs::File, io};
/// Preserve access restrictions when replacing an existing file with a new inode.
/// Both handles must already have been opened within the authorized directory.
pub fn copy_access(source: &File, destination: &File) -> io::Result<()> {
    #[cfg(windows)]
    {
        use std::{os::windows::io::AsRawHandle, ptr::null_mut};
        use windows_sys::Win32::{
            Foundation::LocalFree,
            Security::{
                Authorization::{GetSecurityInfo, SE_FILE_OBJECT, SetSecurityInfo},
                DACL_SECURITY_INFORMATION, GetSecurityDescriptorControl,
                PROTECTED_DACL_SECURITY_INFORMATION, SE_DACL_PROTECTED,
                UNPROTECTED_DACL_SECURITY_INFORMATION,
            },
        };
        let mut acl = null_mut();
        let mut descriptor = null_mut();
        // SAFETY: source is live; returned allocations remain alive through SetSecurityInfo.
        let code = unsafe {
            GetSecurityInfo(
                source.as_raw_handle(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut acl,
                null_mut(),
                &mut descriptor,
            )
        };
        if code != 0 {
            return Err(io::Error::from_raw_os_error(code as i32));
        }
        let result = (|| {
            let mut control = 0;
            let mut revision = 0;
            // SAFETY: descriptor was returned by GetSecurityInfo above.
            if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0
            {
                return Err(io::Error::last_os_error());
            }
            let inheritance = if control & SE_DACL_PROTECTED != 0 {
                PROTECTED_DACL_SECURITY_INFORMATION
            } else {
                UNPROTECTED_DACL_SECURITY_INFORMATION
            };
            // SAFETY: destination is live with WRITE_DAC; ACL belongs to the live descriptor.
            let code = unsafe {
                SetSecurityInfo(
                    destination.as_raw_handle(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION | inheritance,
                    null_mut(),
                    null_mut(),
                    acl,
                    null_mut(),
                )
            };
            if code != 0 {
                return Err(io::Error::from_raw_os_error(code as i32));
            }
            Ok(())
        })();
        // SAFETY: GetSecurityInfo returns a LocalAlloc-owned descriptor.
        unsafe {
            LocalFree(descriptor);
        }
        result?;
    }
    destination.set_permissions(source.metadata()?.permissions())
}

/// Identity and link count read from the already-open file, never a second path lookup.
pub fn identity(file: &File) -> io::Result<(String, u64)> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
        };
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: the file owns a live handle and the output is correctly sized.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok((
            format!(
                "{}:{}:{}",
                info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow
            ),
            info.nNumberOfLinks.into(),
        ))
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let m = file.metadata()?;
        Ok((format!("{}:{}", m.dev(), m.ino()), m.nlink()))
    }
}
