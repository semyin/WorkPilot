//! Use a source-built Git only inside the existing Windows AppContainer.
//! Drive mappings are names, not capabilities: no privileged file handles or
//! uncontained subprocesses are shared with the command.
use super::ProcessSpec;
use std::{io, path::Path};
use windows_sys::Win32::Storage::FileSystem::QueryDosDeviceW;

pub(super) fn prepare(spec: &mut ProcessSpec) -> io::Result<Option<String>> {
    prepare_at(&crate::runtimes::app_root()?, spec)
}

fn prepare_at(base: &Path, spec: &mut ProcessSpec) -> io::Result<Option<String>> {
    if !spec.sandboxed {
        return Ok(None);
    }
    let original = base.join("git-runtime/cmd/git.exe");
    let compatible = base.join("git-runtime/sandbox/bin/git.exe");
    let selected = spec.program.canonicalize()?;
    if !original.is_file()
        || ![original, compatible.clone()]
            .iter()
            .any(|path| path.canonicalize().is_ok_and(|path| path == selected))
    {
        return Ok(None);
    }
    if !compatible.is_file() {
        if !base.join("runtime-catalog.json").is_file() {
            return Ok(None);
        }
        return Err(io::Error::other(
            "受限 Git 运行环境缺失，请修复安装 / Sandboxed Git is missing; repair installation",
        ));
    }
    let actual = compatible.canonicalize()?;
    if !actual.starts_with(base.canonicalize()?) {
        return Err(io::Error::other("Sandboxed Git leaves installation"));
    }
    let mut mappings = Vec::new();
    for path in [&spec.cwd, &actual] {
        let drive = drive_letter(path)?;
        let key = [drive as u16, b':' as u16, 0];
        let mut output = vec![0u16; 1024];
        let size =
            unsafe { QueryDosDeviceW(key.as_ptr(), output.as_mut_ptr(), output.len() as u32) };
        if size == 0 {
            return Err(io::Error::last_os_error());
        }
        let end = output
            .iter()
            .position(|value| *value == 0)
            .unwrap_or(output.len());
        let value = String::from_utf16(&output[..end]).map_err(io::Error::other)?;
        // Local volume roots only. SUBST, UNC and network device mappings need
        // separate handling rather than pretending they are ordinary volumes.
        if !value.starts_with(r"\Device\") || value.contains(['|', '=']) {
            return Err(io::Error::other("Unsupported sandboxed Git volume mapping"));
        }
        let entry = format!("{}:={value}", drive as char);
        if !mappings.contains(&entry) {
            mappings.push(entry);
        }
    }
    spec.program = compatible;
    Ok(Some(mappings.join("|")))
}

fn drive_letter(path: &Path) -> io::Result<u8> {
    let canonical = path.canonicalize()?;
    let text = canonical.to_string_lossy();
    let text = text.strip_prefix(r"\\?\").unwrap_or(&text);
    let bytes = text.as_bytes();
    if bytes.len() < 3 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' {
        return Err(io::Error::other(
            "Sandboxed Git requires a local drive path",
        ));
    }
    Ok(bytes[0].to_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn compatibility_is_only_for_owned_sandboxed_git_and_missing_assets_fail_closed() {
        let folder = tempfile::tempdir().unwrap();
        let base = folder.path();
        let original = base.join("git-runtime/cmd/git.exe");
        let compatible = base.join("git-runtime/sandbox/bin/git.exe");
        fs::create_dir_all(original.parent().unwrap()).unwrap();
        fs::create_dir_all(compatible.parent().unwrap()).unwrap();
        fs::write(&original, "official fixture").unwrap();
        fs::write(&compatible, "compatibility fixture").unwrap();
        fs::write(base.join("runtime-catalog.json"), "{}").unwrap();
        let mut spec = ProcessSpec {
            program: original.clone(),
            args: vec![],
            cwd: base.into(),
            sandboxed: false,
            timeout_ms: 1000,
            output_limit: 1000,
            ledger_dir: base.join("ledger"),
        };
        assert!(prepare_at(base, &mut spec).unwrap().is_none());
        assert_eq!(spec.program, original);
        spec.sandboxed = true;
        let mapping = prepare_at(base, &mut spec).unwrap().unwrap();
        assert!(mapping.contains(":=\\Device\\"));
        assert_eq!(spec.program, compatible);
        let external = base.join("external-git.exe");
        fs::write(&external, "external fixture").unwrap();
        spec.program = external.clone();
        assert!(prepare_at(base, &mut spec).unwrap().is_none());
        assert_eq!(spec.program, external);
        spec.program = original;
        fs::remove_file(compatible).unwrap();
        assert!(
            prepare_at(base, &mut spec)
                .unwrap_err()
                .to_string()
                .contains("repair installation")
        );
    }
}
