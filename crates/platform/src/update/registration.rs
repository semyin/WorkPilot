use super::Result;
use std::path::Path;
pub(crate) const LOCAL_FILES: &[&str] = &[
    "uninstall.exe",
    "browser-companion/com.workpilot.browser_companion.json",
];

#[cfg(not(windows))]
pub(crate) fn owned_version(_install: &Path) -> Result<Option<String>> {
    Ok(None)
}
#[cfg(not(windows))]
pub(crate) fn replace_version(_install: &Path, _expected: &str, _new: &str) -> Result<()> {
    Ok(())
}
#[cfg(windows)]
mod windows {
    use super::*;
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::{
        Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS},
        System::Registry::*,
    };
    const KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\WorkPilot";
    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(Some(0)).collect()
    }
    struct Key(HKEY);
    impl Drop for Key {
        fn drop(&mut self) {
            unsafe {
                RegCloseKey(self.0);
            }
        }
    }
    fn open(write: bool) -> Result<Option<Key>> {
        let mut key = ptr::null_mut();
        let access = KEY_QUERY_VALUE | if write { KEY_SET_VALUE } else { 0 };
        let status = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                wide(KEY).as_ptr(),
                0,
                access | KEY_WOW64_64KEY,
                &mut key,
            )
        };
        if status == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        if status != ERROR_SUCCESS {
            return Err("无法核对当前用户的安装登记，更新已停止。".into());
        }
        Ok(Some(Key(key)))
    }
    fn read(key: HKEY, name: &str) -> Result<String> {
        let mut kind = 0;
        let mut bytes = 8192u32;
        let mut value = vec![0u16; 4096];
        let result = unsafe {
            RegQueryValueExW(
                key,
                wide(name).as_ptr(),
                ptr::null(),
                &mut kind,
                value.as_mut_ptr().cast(),
                &mut bytes,
            )
        };
        if result != ERROR_SUCCESS
            || kind != REG_SZ
            || !(2..=8192).contains(&bytes)
            || !bytes.is_multiple_of(2)
        {
            return Err("安装登记字段格式不正确。".into());
        }
        value.truncate(bytes as usize / 2);
        if value.pop() != Some(0) {
            return Err("安装登记缺少结束符。".into());
        }
        String::from_utf16(&value).map_err(|_| "安装登记文字无效。".into())
    }
    fn owns(key: HKEY, install: &Path) -> Result<bool> {
        let location = read(key, "InstallLocation")?;
        Ok(Path::new(location.trim_matches('"'))
            .canonicalize()
            .ok()
            .as_deref()
            == Some(install))
    }
    pub(crate) fn owned_version(install: &Path) -> Result<Option<String>> {
        let Some(key) = open(false)? else {
            return Ok(None);
        };
        if !owns(key.0, install)? {
            return Ok(None);
        }
        read(key.0, "DisplayVersion").map(Some)
    }
    pub(crate) fn replace_version(install: &Path, expected: &str, new: &str) -> Result<()> {
        let key = open(true)?.ok_or("本机安装登记已被移除，更新已停止。")?;
        if !owns(key.0, install)? {
            return Err("安装登记现已属于另一位置，不能覆盖。".into());
        }
        let current = read(key.0, "DisplayVersion")?;
        if current == new {
            return Ok(());
        }
        if current != expected {
            return Err("安装登记在更新期间变化，不能覆盖。".into());
        }
        let value = wide(new);
        let result = unsafe {
            RegSetValueExW(
                key.0,
                wide("DisplayVersion").as_ptr(),
                0,
                REG_SZ,
                value.as_ptr().cast(),
                (value.len() * 2) as u32,
            )
        };
        if result != ERROR_SUCCESS {
            return Err("无法保存新的安装版本登记。".into());
        }
        Ok(())
    }
}
#[cfg(windows)]
pub(crate) use windows::{owned_version, replace_version};
