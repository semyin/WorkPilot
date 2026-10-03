use super::*;
use std::{ffi::OsStr, os::windows::ffi::OsStrExt, ptr};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, ERROR_FILE_NOT_FOUND, ERROR_SUCCESS, HANDLE, WAIT_ABANDONED, WAIT_OBJECT_0,
    },
    System::{
        Registry::*,
        Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject},
    },
};
use workpilot_contracts::{BrowserRegistration, SetupBrowser};

fn wide(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
}
struct Key(HKEY);
impl Drop for Key {
    fn drop(&mut self) {
        unsafe {
            RegCloseKey(self.0);
        }
    }
}
struct SetupLock(HANDLE);
impl SetupLock {
    fn acquire() -> io::Result<Self> {
        let handle = unsafe {
            CreateMutexW(
                ptr::null(),
                0,
                wide(r"Local\WorkPilot-BrowserSetup-v1").as_ptr(),
            )
        };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let wait = unsafe { WaitForSingleObject(handle, 1000) };
        if ![WAIT_OBJECT_0, WAIT_ABANDONED].contains(&wait) {
            unsafe {
                CloseHandle(handle);
            }
            return Err(io::Error::other(
                "另一个版本正在配置浏览器，请稍后重试 / Another copy is configuring the browser; retry shortly",
            ));
        }
        Ok(Self(handle))
    }
}
impl Drop for SetupLock {
    fn drop(&mut self) {
        unsafe {
            ReleaseMutex(self.0);
            CloseHandle(self.0);
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Value {
    Missing,
    Text(String),
    Invalid,
}
#[derive(Clone)]
struct Slot {
    hive: HKEY,
    view: u32,
    path: String,
}
impl Slot {
    fn open(&self, access: u32) -> io::Result<Option<Key>> {
        let mut key = ptr::null_mut();
        let status = unsafe {
            RegOpenKeyExW(
                self.hive,
                wide(&self.path).as_ptr(),
                0,
                access | self.view,
                &mut key,
            )
        };
        if status == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        if status != ERROR_SUCCESS {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        Ok(Some(Key(key)))
    }
    fn read(&self) -> io::Result<Value> {
        let Some(key) = self.open(KEY_QUERY_VALUE)? else {
            return Ok(Value::Missing);
        };
        read_value(key.0)
    }
    fn register(&self, expected: &str) -> io::Result<()> {
        let mut key = ptr::null_mut();
        let status = unsafe {
            RegCreateKeyExW(
                self.hive,
                wide(&self.path).as_ptr(),
                0,
                ptr::null(),
                0,
                KEY_QUERY_VALUE | KEY_SET_VALUE | self.view,
                ptr::null(),
                &mut key,
                ptr::null_mut(),
            )
        };
        if status != 0 {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        let key = Key(key);
        let old = read_value(key.0)?;
        if old != Value::Missing && !owns(&old, expected) {
            return Err(conflict());
        }
        let bytes = wide(expected);
        let status = unsafe {
            RegSetValueExW(
                key.0,
                ptr::null(),
                0,
                REG_SZ,
                bytes.as_ptr().cast(),
                (bytes.len() * 2) as u32,
            )
        };
        if status != 0 {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        Ok(())
    }
    fn remove_owned(&self, expected: &str) -> io::Result<()> {
        let Some(key) = self.open(KEY_QUERY_VALUE | KEY_SET_VALUE)? else {
            return Ok(());
        };
        if !owns(&read_value(key.0)?, expected) {
            return Ok(());
        }
        let status = unsafe { RegDeleteValueW(key.0, ptr::null()) };
        if status != 0 && status != ERROR_FILE_NOT_FOUND {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        let (mut subkeys, mut values) = (0, 0);
        let status = unsafe {
            RegQueryInfoKeyW(
                key.0,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null(),
                &mut subkeys,
                ptr::null_mut(),
                ptr::null_mut(),
                &mut values,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        drop(key);
        if status == 0 && subkeys == 0 && values == 0 {
            // Never recursively remove subkeys or values belonging to someone else.
            unsafe {
                RegDeleteKeyExW(self.hive, wide(&self.path).as_ptr(), self.view, 0);
            }
        }
        Ok(())
    }
}
fn read_value(key: HKEY) -> io::Result<Value> {
    let (mut kind, mut size) = (0, 0);
    let status = unsafe {
        RegQueryValueExW(
            key,
            ptr::null(),
            ptr::null(),
            &mut kind,
            ptr::null_mut(),
            &mut size,
        )
    };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(Value::Missing);
    }
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    if kind != REG_SZ || size == 0 || size > 32768 || size % 2 != 0 {
        return Ok(Value::Invalid);
    }
    let mut value = vec![0u16; (size / 2) as usize];
    let status = unsafe {
        RegQueryValueExW(
            key,
            ptr::null(),
            ptr::null(),
            &mut kind,
            value.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    value.truncate((size / 2) as usize);
    if kind != REG_SZ || value.pop() != Some(0) || value.contains(&0) || value.is_empty() {
        return Ok(Value::Invalid);
    }
    Ok(String::from_utf16(&value)
        .map(Value::Text)
        .unwrap_or(Value::Invalid))
}
fn owns(value: &Value, expected: &str) -> bool {
    matches!(value, Value::Text(s) if s.eq_ignore_ascii_case(expected))
}
fn conflict() -> io::Error {
    io::Error::other(
        "另一处安装或系统设置占用了此连接，未覆盖。请先从原位置解除配置 / Another installation or system setting owns this connection; unregister it there first",
    )
}
fn vendor(browser: SetupBrowser) -> &'static str {
    match browser {
        SetupBrowser::Chrome => r"Google\Chrome",
        SetupBrowser::Edge => r"Microsoft\Edge",
    }
}
fn slots(prefix: &str, vendor: &str) -> Vec<Slot> {
    [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE]
        .into_iter()
        .flat_map(|hive| {
            [KEY_WOW64_32KEY, KEY_WOW64_64KEY]
                .into_iter()
                .map(move |view| Slot {
                    hive,
                    view,
                    path: format!(r"{prefix}\{vendor}\NativeMessagingHosts\{HOST}"),
                })
        })
        .collect()
}
fn browser_report(
    root: &Path,
    prefix: &str,
    browser: SetupBrowser,
    ready: bool,
) -> io::Result<BrowserRegistration> {
    let expected = root
        .join("browser-companion")
        .join(MANIFEST)
        .to_string_lossy()
        .into_owned();
    let mut foreign = false;
    let mut current = false;
    let mut registered = false;
    let mut other_location = None;
    for slot in slots(prefix, vendor(browser)) {
        let value = slot.read()?;
        if value == Value::Missing {
            continue;
        }
        if owns(&value, &expected) {
            registered = true;
            current |= slot.hive == HKEY_CURRENT_USER;
        } else {
            foreign = true;
            if let Value::Text(path) = value {
                other_location.get_or_insert(path.chars().take(2048).collect());
            }
        }
    }
    let mut fallback_detected = false;
    if browser == SetupBrowser::Edge && !registered && !foreign {
        for other in [r"Chromium", r"Google\Chrome"] {
            for slot in slots(prefix, other) {
                fallback_detected |= slot.read()? != Value::Missing;
            }
        }
    }
    let state = if foreign {
        "conflict"
    } else if !ready {
        "unavailable"
    } else if registered && manifest_ready(root) {
        "ready"
    } else if registered {
        "repair"
    } else {
        "missing"
    };
    let manifest = root.join("browser-companion").join(MANIFEST);
    let can_write_manifest = !manifest.try_exists()? || manifest_ready(root);
    Ok(BrowserRegistration {
        browser,
        state: state.into(),
        can_register: ready && !foreign && can_write_manifest,
        can_unregister: current,
        other_location,
        fallback_detected,
    })
}

pub(super) fn perform_at(
    root: &Path,
    action: &BrowserSetupAction,
    prefix: &str,
) -> io::Result<BrowserSetupReport> {
    let _lock = SetupLock::acquire()?;
    let ready = assets_ready(root);
    let expected = root
        .join("browser-companion")
        .join(MANIFEST)
        .to_string_lossy()
        .into_owned();
    match action {
        BrowserSetupAction::Inspect => {}
        BrowserSetupAction::Register { browser } => {
            let report = browser_report(root, prefix, *browser, ready)?;
            if !report.can_register {
                return Err(if report.state == "conflict" {
                    conflict()
                } else {
                    io::Error::other(
                        "连接组件缺失或文件不符，请重新安装当前版本 / Companion files are missing or different; reinstall this copy",
                    )
                });
            }
            ensure_manifest(root)?;
            // HKCU Software is shared between the views on Windows x64. One write is sufficient.
            slots(prefix, vendor(*browser))[0].register(&expected)?;
        }
        BrowserSetupAction::Unregister { browser } => {
            for slot in slots(prefix, vendor(*browser))
                .into_iter()
                .filter(|s| s.hive == HKEY_CURRENT_USER)
            {
                slot.remove_owned(&expected)?;
            }
        }
    }
    Ok(BrowserSetupReport {
        supported: true,
        assets_ready: ready,
        extension_directory: ready.then(|| {
            root.join("browser-companion")
                .join("extension")
                .to_string_lossy()
                .into_owned()
        }),
        extension_id: EXTENSION_ID.trim().into(),
        browsers: [SetupBrowser::Chrome, SetupBrowser::Edge]
            .into_iter()
            .map(|b| browser_report(root, prefix, b, ready))
            .collect::<io::Result<_>>()?,
    })
}

#[cfg(test)]
mod tests;
