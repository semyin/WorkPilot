use std::{
    ffi::{CStr, CString, c_char, c_void},
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    ptr,
};
#[link(name = "kernel32")]
unsafe extern "system" {
    fn SetDefaultDllDirectories(flags: u32) -> i32;
    fn SetDllDirectoryW(path: *const u16) -> i32;
    fn LoadLibraryExW(path: *const u16, file: *mut c_void, flags: u32) -> *mut c_void;
    fn GetProcAddress(module: *mut c_void, name: *const u8) -> *mut c_void;
    fn GetCurrentProcess() -> *mut c_void;
    fn TerminateProcess(process: *mut c_void, code: u32) -> i32;
}
fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}
fn plain(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{unc}"))
    } else {
        PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(&text))
    }
}
unsafe fn symbol(library: *mut c_void, name: &CStr) -> Result<*mut c_void, String> {
    let pointer = unsafe { GetProcAddress(library, name.as_ptr().cast()) };
    if pointer.is_null() {
        Err(format!("Missing Python API: {}", name.to_string_lossy()))
    } else {
        Ok(pointer)
    }
}
pub fn convert() -> Result<(), String> {
    if std::env::args().count() != 1 {
        return Err("Office worker accepts no arguments".into());
    }
    let exe = plain(std::env::current_exe().map_err(|e| e.to_string())?);
    let program = exe.parent().ok_or("Missing renderer directory")?;
    // A pinned CPython 3.13 runtime shipped by LibreOffice. Explicit module and
    // DLL paths exclude the document directory, user modules and environment.
    // These initialization APIs are supported by the pinned 3.13 ABI; a future
    // Python upgrade must migrate them to PyConfig and repeat integration tests.
    let paths = std::env::join_paths([program.join("python-core-3.13.15/lib"), program.to_owned()])
        .map_err(|e| e.to_string())?;
    let paths: Vec<u16> = paths.encode_wide().chain(Some(0)).collect();
    let exe = wide(&exe);
    let code = CString::new(include_str!("../../../services/office/worker.py"))
        .map_err(|e| e.to_string())?;
    unsafe {
        if SetDefaultDllDirectories(0x1000) == 0 || SetDllDirectoryW(wide(program).as_ptr()) == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let library = LoadLibraryExW(
            wide(&program.join("python313.dll")).as_ptr(),
            ptr::null_mut(),
            0x1100,
        );
        if library.is_null() {
            return Err(format!(
                "Cannot load bundled Python: {}",
                std::io::Error::last_os_error()
            ));
        }
        for name in [
            c"Py_IsolatedFlag",
            c"Py_IgnoreEnvironmentFlag",
            c"Py_NoSiteFlag",
            c"Py_DontWriteBytecodeFlag",
        ] {
            *symbol(library, name)?.cast::<i32>() = 1;
        }
        let set_path: unsafe extern "C" fn(*const u16) =
            std::mem::transmute(symbol(library, c"Py_SetPath")?);
        let set_program: unsafe extern "C" fn(*const u16) =
            std::mem::transmute(symbol(library, c"Py_SetProgramName")?);
        let initialize: unsafe extern "C" fn(i32) =
            std::mem::transmute(symbol(library, c"Py_InitializeEx")?);
        let run: unsafe extern "C" fn(*const c_char) -> i32 =
            std::mem::transmute(symbol(library, c"PyRun_SimpleString")?);
        set_path(paths.as_ptr());
        set_program(exe.as_ptr());
        initialize(0);
        if run(code.as_ptr()) != 0 {
            return Err(
                "无法生成办公文件预览，文件可能损坏或包含不支持的内容 / Office conversion failed"
                    .into(),
            );
        }
    }
    Ok(())
}
pub fn finish(code: u32) -> ! {
    // All output is flushed before ending this one-job worker. Avoid shutdown
    // callbacks taking locks held by LibreOffice background threads.
    unsafe {
        TerminateProcess(GetCurrentProcess(), code);
    }
    std::process::exit(code as i32)
}
