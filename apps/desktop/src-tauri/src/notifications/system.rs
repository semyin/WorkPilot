use super::model::{Delivery, Kind};
use tauri::AppHandle;

pub fn available() -> bool {
    #[cfg(windows)]
    {
        registered_install()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

pub fn show(app: &AppHandle, id: Option<String>, kind: Option<Kind>, english: bool) -> Delivery {
    if !available() {
        return Delivery::Unavailable;
    }
    let text = kind.map(|kind| kind.text(english)).unwrap_or(if english {
        "Notification test. Your task content stays inside WorkPilot."
    } else {
        "通知测试。任务内容只显示在 WorkPilot 内。"
    });
    #[cfg(windows)]
    {
        use tauri_winrt_notification::{Duration, Toast};
        let target = app.clone();
        let hint = if english {
            "Open WorkPilot to view the task."
        } else {
            "打开 WorkPilot 查看任务。"
        };
        let result = Toast::new(&app.config().identifier)
            .title("WorkPilot")
            .text1(text)
            .text2(hint)
            .duration(Duration::Short)
            .sound(None)
            .on_activated(move |_| {
                super::activate(&target, id.clone());
                Ok(())
            })
            .show();
        if result.is_ok() {
            Delivery::Submitted
        } else {
            Delivery::Failed
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (app, id, text);
        Delivery::Unavailable
    }
}

#[cfg(windows)]
fn registered_install() -> bool {
    use std::{path::Path, ptr};
    use windows_sys::Win32::{Foundation::ERROR_SUCCESS, System::Registry::*};
    let wide = |text: &str| text.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let mut key = ptr::null_mut();
    let status = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            wide(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\WorkPilot").as_ptr(),
            0,
            KEY_QUERY_VALUE | KEY_WOW64_64KEY,
            &mut key,
        )
    };
    if status != ERROR_SUCCESS {
        return false;
    }
    let mut buffer = [0u16; 4096];
    let mut bytes = (buffer.len() * 2) as u32;
    let mut kind = 0;
    let status = unsafe {
        RegQueryValueExW(
            key,
            wide("InstallLocation").as_ptr(),
            ptr::null(),
            &mut kind,
            buffer.as_mut_ptr().cast(),
            &mut bytes,
        )
    };
    unsafe {
        RegCloseKey(key);
    }
    if status != ERROR_SUCCESS
        || kind != REG_SZ
        || !(2..=8192).contains(&bytes)
        || !bytes.is_multiple_of(2)
    {
        return false;
    }
    let values = &buffer[..bytes as usize / 2];
    if values.last() != Some(&0) {
        return false;
    }
    let Ok(location) = String::from_utf16(&values[..values.len() - 1]) else {
        return false;
    };
    let Ok(location) = Path::new(location.trim_matches('"')).canonicalize() else {
        return false;
    };
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().and_then(|p| p.canonicalize().ok()))
        .is_some_and(|current| current == location)
}
