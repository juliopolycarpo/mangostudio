//! Pins the SDK integration to the private adapter and one real-SDK executable fixture.
use std::path::Path;

const SDK_CRATES: &[&str] = &[
    "mango_external_agents",
    "mango_agent_acp",
    "mango_agent_claude",
    "mango_agent_codex",
];
const FIXTURES: &[&str] = &["examples/fake_cursor_agent.rs"];

fn allowed(path: &str) -> bool {
    path.starts_with("src/external_agents/adapter/") || FIXTURES.contains(&path)
}

// Rust identifiers after removing comments and string literals. This catches imports, re-exports,
// aliases, extern crate declarations and fully qualified types, including multiline declarations.
fn sdk_references(source: &str) -> Vec<&str> {
    let bytes = source.as_bytes();
    let mut cursor = 0;
    let mut found = Vec::new();
    while cursor < bytes.len() {
        if bytes[cursor..].starts_with(b"//") {
            while cursor < bytes.len() && bytes[cursor] != b'\n' {
                cursor += 1;
            }
            continue;
        }
        if bytes[cursor..].starts_with(b"/*") {
            cursor += 2;
            let mut depth = 1;
            while cursor < bytes.len() && depth > 0 {
                if bytes[cursor..].starts_with(b"/*") {
                    depth += 1;
                    cursor += 2;
                } else if bytes[cursor..].starts_with(b"*/") {
                    depth -= 1;
                    cursor += 2;
                } else {
                    cursor += 1;
                }
            }
            continue;
        }
        if bytes[cursor] == b'r' {
            let start = cursor;
            cursor += 1;
            while cursor < bytes.len() && bytes[cursor] == b'#' {
                cursor += 1;
            }
            if cursor < bytes.len() && bytes[cursor] == b'"' {
                let end = format!("\"{}", "#".repeat(cursor - start - 1));
                cursor += 1;
                cursor = source[cursor..]
                    .find(&end)
                    .map_or(bytes.len(), |offset| cursor + offset + end.len());
                continue;
            }
            cursor = start;
        }
        if bytes[cursor] == b'\'' {
            let start = cursor + 1;
            let end = if bytes.get(start) == Some(&b'\\') {
                start + 2
            } else {
                source[start..]
                    .chars()
                    .next()
                    .map_or(start, |character| start + character.len_utf8())
            };
            if bytes.get(end) == Some(&b'\'') {
                cursor = end + 1;
                continue;
            }
        }
        if bytes[cursor] == b'"' {
            cursor += 1;
            while cursor < bytes.len() {
                match bytes[cursor] {
                    b'\\' => cursor = (cursor + 2).min(bytes.len()),
                    b'"' => {
                        cursor += 1;
                        break;
                    }
                    _ => cursor += 1,
                }
            }
            continue;
        }
        if bytes[cursor].is_ascii_alphabetic() || bytes[cursor] == b'_' {
            let start = cursor;
            cursor += 1;
            while cursor < bytes.len()
                && (bytes[cursor].is_ascii_alphanumeric() || bytes[cursor] == b'_')
            {
                cursor += 1;
            }
            let identifier = &source[start..cursor];
            if SDK_CRATES.contains(&identifier) {
                found.push(identifier);
            }
            continue;
        }
        cursor += 1;
    }
    found
}

#[test]
fn product_sources_cannot_name_sdk_crates() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut pending = vec![root.join("src"), root.join("tests"), root.join("examples")];
    let mut violations = Vec::new();
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                pending.push(path);
                continue;
            }
            if path.extension().and_then(|ext| ext.to_str()) != Some("rs") {
                continue;
            }
            let relative = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            if allowed(&relative) {
                continue;
            }
            let source = std::fs::read_to_string(&path).unwrap();
            let references = sdk_references(&source);
            if !references.is_empty() {
                violations.push(format!("{relative}: {references:?}"));
            }
        }
    }
    assert!(
        violations.is_empty(),
        "SDK references must stay inside the private adapter: {violations:#?}"
    );
    let modules = std::fs::read_to_string(root.join("src/external_agents/mod.rs")).unwrap();
    assert!(
        modules.lines().any(|line| line == "mod adapter;"),
        "the SDK adapter must remain private"
    );
}

#[test]
fn the_guard_catches_every_dependency_and_type_escape() {
    for name in SDK_CRATES {
        for declaration in [
            format!("use\n {name}::Session;"),
            format!("pub use {name} as vendor;"),
            format!("type Leaked = {name}::Session;"),
            format!("extern crate {name} as vendor;"),
            format!("fn session() -> Box<dyn {name}::Session> {{ todo!() }}"),
        ] {
            assert_eq!(
                sdk_references(&declaration),
                [*name],
                "missed {declaration}"
            );
        }
    }
    assert!(!allowed("src/external_agents/supervisor/tests.rs"));
    assert!(!allowed("tests/new_sdk_fixture.rs"));
    assert!(!allowed("src/external_agents/adapter.rs"));
    assert!(allowed("src/external_agents/adapter/session.rs"));
}

#[test]
fn the_guard_ignores_documentation_and_literal_text() {
    assert!(sdk_references("// mango_external_agents\n/* nested /* mango_agent_codex */ comment */ let text = \"mango_agent_acp\"; let raw = r##\"mango_agent_claude\"##;").is_empty());
}

#[test]
fn character_literals_and_lifetimes_cannot_hide_a_following_import() {
    let source = "let quote = '\"'; let byte = b'\\n'; let character = 'é'; fn f<'a>() {} use mango_external_agents::Session;";
    assert_eq!(sdk_references(source), ["mango_external_agents"]);
}
