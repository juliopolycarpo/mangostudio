//! Every child process the runtime host starts goes through `ProcessRequest::new`, which hides
//! the console window on Windows (`CREATE_NO_WINDOW`). A git, gh, shell, MCP, install, or probe
//! child that bypassed it would flash a console window on a native-Windows runtime.
//!
//! This test scans the crate's own `src/` tree, outside test code, for the ways a process can be
//! started or its window re-shown without that request, and pins each allowed site's exact call
//! text and count, the way `config_boundary.rs` pins environment reads. A new direct spawn fails
//! here, not in review.

use std::collections::BTreeMap;
use std::path::Path;

/// `(path relative to src/, call text, expected occurrence count, why it is allowed)`.
const ALLOWED: &[(&str, &str, usize, &str)] = &[
    (
        "subprocess/supervisor.rs",
        "Command::new(",
        1,
        "portable fallback compiled only on targets that are neither Unix nor Windows",
    ),
    (
        "subprocess/supervisor.rs",
        "hide_window:",
        1,
        "the one default every request starts from: hidden",
    ),
    (
        "subprocess/windows_job.rs",
        "CreateProcessW(",
        2,
        "the bounded spawn takes its flags from the request; the ConPTY spawn must not hide",
    ),
    (
        "external_agents/launcher.rs",
        "hide_window =",
        1,
        "copies the vendor launch spec's own window policy",
    ),
    (
        "cli/user_service.rs",
        "Command::new(",
        3,
        "operator CLI service verbs, run attached to the operator's own console",
    ),
    (
        "subprocess/supervisor.rs",
        PROCESS_COMMAND_IMPORT,
        1,
        "tokio's Command for the portable fallback above",
    ),
    (
        "cli/user_service.rs",
        PROCESS_COMMAND_IMPORT,
        1,
        "std's Command for the operator CLI service verbs above",
    ),
];

/// Signature for a `use` that brings a `process::Command` into scope under any name, so a
/// renamed import (`use std::process::Command as Proc`) cannot hide a spawner from the scan.
const PROCESS_COMMAND_IMPORT: &str = "use of process::Command";

/// Signature for a `process::Command` path written inline, outside a `use`.
const PROCESS_COMMAND_PATH: &str = "process::Command path";

/// Shapes that start a process, or undo the hidden-window default, without the shared request.
const SPAWN_SHAPES: &[&str] = &[
    "Command::new(",
    "CommandBuilder::new(",
    "CreateProcessW(",
    "CreateProcessAsUserW(",
    "ShellExecuteW(",
    "ProcessRequest {",
    "hide_window =",
    "hide_window:",
];

/// Out-of-line test modules and shared test fixtures are not host code.
fn is_test_file(relative: &str) -> bool {
    let name = relative.rsplit('/').next().unwrap_or(relative);
    name == "tests.rs"
        || name == "test_support.rs"
        || name.ends_with("_tests.rs")
        || relative.split('/').any(|part| part == "tests")
}

/// Declarations of the request type itself are not constructions of it.
fn is_declaration(line: &str, shape: &str) -> bool {
    let trimmed = line.trim_start();
    match shape {
        "ProcessRequest {" => {
            trimmed.starts_with("pub struct ")
                || trimmed.starts_with("impl ")
                || line.contains("-> ProcessRequest {")
        }
        "hide_window:" => trimmed.starts_with("pub hide_window:"),
        _ => false,
    }
}

/// Net `{`/`}` depth change of one line, ignoring braces inside string and char literals and
/// after a line comment. Good enough for this crate's formatted source: raw strings containing
/// an unbalanced brace would confuse it, and the balanced-at-EOF assertion below catches that.
fn brace_delta(line: &str) -> i64 {
    let mut delta = 0;
    let mut chars = line.chars().peekable();
    let mut in_string = false;
    while let Some(ch) = chars.next() {
        if in_string {
            match ch {
                '\\' => {
                    chars.next();
                }
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '/' if chars.peek() == Some(&'/') => break,
            '\'' => {
                // A char literal such as '{' or '\''; a lifetime has no closing quote nearby.
                let rest: String = chars.clone().take(3).collect();
                if rest.starts_with('\\') {
                    chars.nth(2);
                } else if rest.chars().nth(1) == Some('\'') {
                    chars.nth(1);
                }
            }
            '{' => delta += 1,
            '}' => delta -= 1,
            _ => {}
        }
    }
    delta
}

/// Whether an attribute line compiles its item only under `cfg(test)`: `#[cfg(test)]`, or an
/// `all(...)` that requires `test`. `any(test, ...)` also builds outside tests, so it is host code.
fn is_test_gate(attribute: &str) -> bool {
    if attribute.starts_with("#[cfg(test)]") {
        return true;
    }
    let Some(conditions) = attribute.strip_prefix("#[cfg(all(") else {
        return false;
    };
    conditions
        .split([',', ')'])
        .any(|condition| condition.trim() == "test")
}

/// Lines of `source` outside `#[cfg(test)]`-gated items, paired with their 1-based numbers.
fn host_lines(source: &str) -> Vec<(usize, &str)> {
    let mut kept = Vec::new();
    let mut pending_test_attribute = false;
    let mut skip_depth: Option<i64> = None;
    for (index, line) in source.lines().enumerate() {
        if let Some(depth) = skip_depth.as_mut() {
            *depth += brace_delta(line);
            if *depth <= 0 && line.contains('}') {
                skip_depth = None;
            }
            continue;
        }
        let trimmed = line.trim_start();
        if is_test_gate(trimmed) {
            pending_test_attribute = true;
            continue;
        }
        if pending_test_attribute {
            if trimmed.starts_with("#[") {
                continue;
            }
            pending_test_attribute = false;
            let delta = brace_delta(line);
            if delta > 0 {
                skip_depth = Some(delta);
            }
            // A single-line gated item (`mod tests;`, `use ...;`, `field: T,`) ends here.
            continue;
        }
        if trimmed.starts_with("//") {
            continue;
        }
        kept.push((index + 1, line));
    }
    assert!(
        skip_depth.is_none(),
        "expected every #[cfg(test)] block to close before end of file | received an open block; \
         the brace scanner in spawn_boundary.rs needs to learn a new literal form"
    );
    kept
}

/// Whether `text` names `Command` as a whole path segment, not `CommandExt` or `ControlCommand`.
fn names_command(text: &str) -> bool {
    text.split(|ch: char| !(ch.is_alphanumeric() || ch == '_'))
        .any(|token| token == "Command")
}

/// Whether a complete `use` statement imports a `process::Command`, directly, in a group, under
/// a rename, or through a `process::*` glob.
fn imports_process_command(statement: &str) -> bool {
    let compact: String = statement.split_whitespace().collect();
    compact.contains("process::") && (names_command(statement) || compact.contains("process::*"))
}

/// Whether a line outside a `use` spells a `process::Command` path.
fn has_process_command_path(line: &str) -> bool {
    line.match_indices("process::Command")
        .any(|(index, found)| {
            !line[index + found.len()..]
                .chars()
                .next()
                .is_some_and(|ch| ch.is_alphanumeric() || ch == '_')
        })
}

/// `(line, signature)` for every `process::Command` import or inline path in `lines`.
fn process_command_sites(lines: &[(usize, &str)]) -> Vec<(usize, &'static str)> {
    let mut sites = Vec::new();
    let mut statement: Option<(usize, String)> = None;
    for &(number, line) in lines {
        let trimmed = line.trim_start();
        let starts_use = trimmed.starts_with("use ")
            || trimmed.starts_with("pub use ")
            || trimmed.starts_with("pub(crate) use ")
            || trimmed.starts_with("pub(super) use ");
        if statement.is_none() && starts_use {
            statement = Some((number, String::new()));
        }
        if let Some((start, text)) = statement.as_mut() {
            text.push_str(line);
            text.push(' ');
            if line.contains(';') {
                if imports_process_command(text) {
                    sites.push((*start, PROCESS_COMMAND_IMPORT));
                }
                statement = None;
            }
            continue;
        }
        if has_process_command_path(line) {
            sites.push((number, PROCESS_COMMAND_PATH));
        }
    }
    sites
}

fn spawn_sites(src_dir: &Path) -> BTreeMap<(String, String), Vec<usize>> {
    let mut sites: BTreeMap<(String, String), Vec<usize>> = BTreeMap::new();
    let mut stack = vec![src_dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).expect("src/ is readable") {
            let path = entry.expect("dir entry reads").path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.extension().and_then(|ext| ext.to_str()) != Some("rs") {
                continue;
            }
            let relative = path
                .strip_prefix(src_dir)
                .expect("path is under src_dir")
                .to_string_lossy()
                .replace('\\', "/");
            if is_test_file(&relative) {
                continue;
            }
            let source = std::fs::read_to_string(&path).expect("source file reads as utf8");
            let lines = host_lines(&source);
            for (number, signature) in process_command_sites(&lines) {
                sites
                    .entry((relative.clone(), signature.to_string()))
                    .or_default()
                    .push(number);
            }
            for (number, line) in lines {
                for shape in SPAWN_SHAPES {
                    if line.contains(shape) && !is_declaration(line, shape) {
                        sites
                            .entry((relative.clone(), (*shape).to_string()))
                            .or_default()
                            .push(number);
                    }
                }
            }
        }
    }
    sites
}

#[test]
fn every_host_spawn_goes_through_the_hidden_window_request() {
    let src_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let found = spawn_sites(&src_dir);
    let expected: BTreeMap<(String, String), usize> = ALLOWED
        .iter()
        .map(|&(path, text, count, _)| ((path.to_string(), text.to_string()), count))
        .collect();

    let mut keys: Vec<&(String, String)> = found.keys().chain(expected.keys()).collect();
    keys.sort();
    keys.dedup();
    for key @ (relative, shape) in keys {
        let lines = found.get(key).cloned().unwrap_or_default();
        let Some(&expected_count) = expected.get(key) else {
            panic!(
                "expected no `{shape}` in host code outside the allowlist | received {} at \
                 src/{relative}:{lines:?}. Start the process through \
                 subprocess::ProcessRequest::new so it keeps CREATE_NO_WINDOW on Windows, or add \
                 the site to ALLOWED with the reason it cannot open a console window.",
                lines.len()
            );
        };
        assert_eq!(
            lines.len(),
            expected_count,
            "expected {expected_count} `{shape}` site(s) in src/{relative} | received {} at \
             lines {lines:?}. A grown count is a new spawn that bypasses \
             ProcessRequest::new; a shrunk count is a stale ALLOWED entry to drop.",
            lines.len()
        );
    }
}

#[test]
fn test_gated_blocks_are_not_host_code() {
    let source = "fn host() { Command::new(\"a\"); }\n\
                  #[cfg(test)]\n\
                  mod tests {\n    fn t() { let c = '{'; Command::new(\"b\"); }\n}\n\
                  fn after() { Command::new(\"c\"); }\n\
                  #[cfg(all(test, unix))]\n\
                  mod unix_tests {\n    fn t() { Command::new(\"d\"); }\n}\n\
                  #[cfg(any(test, windows))]\n\
                  fn shared() { Command::new(\"e\"); }\n";
    let kept: Vec<usize> = host_lines(source)
        .into_iter()
        .filter(|(_, line)| line.contains("Command::new("))
        .map(|(number, _)| number)
        .collect();
    assert_eq!(
        kept,
        vec![1, 6, 12],
        "expected host Command::new lines [1, 6, 12] | received {kept:?}"
    );
}

#[test]
fn a_renamed_or_grouped_process_command_import_is_still_a_spawn_site() {
    let source = "use std::process::Command as Proc;\n\
                  use std::process::{\n    Child,\n    Command,\n};\n\
                  use tokio::process::*;\n\
                  use std::os::unix::process::CommandExt;\n\
                  use crate::subprocess::ControlCommand;\n\
                  fn spawn() { std::process::Command::new(\"x\"); }\n\
                  fn trait_only() { let _ = std::process::CommandExt::exec; }\n";
    let lines = host_lines(source);
    let found = process_command_sites(&lines);
    assert_eq!(
        found,
        vec![
            (1, PROCESS_COMMAND_IMPORT),
            (2, PROCESS_COMMAND_IMPORT),
            (6, PROCESS_COMMAND_IMPORT),
            (9, PROCESS_COMMAND_PATH),
        ],
        "expected the rename, the group, the glob, and the inline path | received {found:?}"
    );
}
