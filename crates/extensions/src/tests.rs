use super::*;
use std::io::{Cursor, Write};
fn skill() -> package::Contents {
    [("SKILL.md".into(),b"---\nname: test-skill\ndescription: Reusable test skill\nallowed-tools: anything\n---\nRead references/notes.md when needed.\n".to_vec()),("references/notes.md".into(),b"Verified resource.".to_vec())].into_iter().collect()
}
#[test]
fn skill_roundtrip_canonical_digest_and_tamper_detection() {
    let (version, files) = package::validate(skill()).unwrap();
    assert_eq!(version.skills[0].name, "test-skill");
    assert!(!version.warnings.is_empty());
    let rebuilt = package::unpack(&package::zip(&files).unwrap()).unwrap();
    assert_eq!(version.digest, package::validate(rebuilt).unwrap().0.digest);
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("package");
    package::write_new(&root, &files).unwrap();
    assert_eq!(
        package::read_verified(&root, &version, "references/notes.md").unwrap(),
        b"Verified resource."
    );
    std::fs::write(root.join("references/notes.md"), "replacement").unwrap();
    assert!(package::read_verified(&root, &version, "references/notes.md").is_err());
    assert!(package::read_verified(&root, &version, "unindexed.txt").is_err());
}
#[test]
fn bad_packages_cannot_escape_or_hide_credential_files() {
    for path in [
        "../escape",
        "C:/escape",
        "/escape",
        "a\\b",
        "a/./b",
        "a//b",
        "a/../b",
        "x:stream",
        "NUL.txt",
        "a/CON",
        ".env",
        "notes.pem",
        ".git/config",
        "foo.",
    ] {
        assert!(package::relative(path).is_err(), "{path}");
    }
    for path in ["../escape", "a/../../outside"] {
        let mut zip = zip::ZipWriter::new(Cursor::new(vec![]));
        zip.start_file(path, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"outside").unwrap();
        assert!(package::unpack(&zip.finish().unwrap().into_inner()).is_err());
    }
    let mut files = skill();
    files.insert("skill.md".into(), b"shadow".to_vec());
    assert!(package::validate(files).is_err());
    let mut files = skill();
    files.insert(
        "references/key.txt".into(),
        b"-----BEGIN PRIVATE KEY-----".to_vec(),
    );
    assert!(package::validate(files).is_err());
    let mut files = skill();
    files.insert("SKILL.md".into(), b"Missing YAML metadata".to_vec());
    assert!(package::validate(files).is_err());
    assert!(package::unpack(b"broken zip").is_err());
    assert!(
        package::unpack(
            &package::zip(
                &[("SKILL.md".into(), vec![0; package::MAX_FILE + 1])]
                    .into_iter()
                    .collect()
            )
            .unwrap()
        )
        .is_err()
    );
}
#[test]
fn schemas_reject_remote_refs_and_invalid_arguments() {
    let valid = serde_json::json!({"name":"test","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false}});
    assert!(mcp::validate_arguments(&valid, &serde_json::json!({"text":"ok"})).is_ok());
    assert!(mcp::validate_arguments(&valid, &serde_json::json!({"text":12})).is_err());
    let external =
        serde_json::json!({"inputSchema":{"type":"object","$ref":"http://127.0.0.1:9/private"}});
    assert!(mcp::validate_arguments(&external, &serde_json::json!({})).is_err());
    assert!(mcp::endpoint("https://user:secret@example.com/tool").is_err());
    assert!(mcp::endpoint("http://example.com/tool").is_err());
    assert!(mcp::endpoint("https://example.com/tool?key=secret").is_err());
}
