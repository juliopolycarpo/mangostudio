//! Enforces AGENTS.md's "one parsing point per host" rule for
//! *configuration*: every environment variable this host reads as
//! configuration is parsed in `src/config.rs`, and nowhere else.
//!
//! Machine probing is a named carve-out from that rule, not an exception to
//! it: a detector reading `PATH`, `$HOME`, or a full environment snapshot to
//! describe what is actually on this machine is not configuration, and
//! AGENTS.md names the sites explicitly. This test is what keeps that list
//! honest — a change that adds a fifth site fails here, not in review.

use std::path::Path;

/// `(path relative to `src/`, substring)` pairs AGENTS.md's carve-out names.
/// Keep this in sync with that list; a real new probing site is added here
/// *and* to AGENTS.md in the same change, never only here.
const ALLOWED: &[(&str, &str)] = &[
    ("health.rs", "env::var_os("),
    ("probing/host.rs", "env::vars("),
    ("runtime_home.rs", "env::home_dir("),
];

/// Patterns that read the process environment directly. `temp_dir` is
/// deliberately absent: a scratch directory under `std::env::temp_dir()` is
/// not an environment read in the sense this rule cares about.
const ENV_READ_PATTERNS: &[&str] = &["env::var(", "env::var_os(", "env::vars(", "env::home_dir("];

fn is_comment(line: &str) -> bool {
    line.trim_start().starts_with("//")
}

/// Every `(path relative to `src/`, matched pattern)` hit outside
/// `config.rs`, found by walking the crate's own `src/` tree.
fn env_reads_outside_config(src_dir: &Path) -> Vec<(String, String)> {
    let mut hits = Vec::new();
    let mut stack = vec![src_dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).expect("src/ is readable") {
            let entry = entry.expect("dir entry reads");
            let path = entry.path();
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
            if relative == "config.rs" {
                continue;
            }
            let contents = std::fs::read_to_string(&path).expect("source file reads as utf8");
            for line in contents.lines() {
                if is_comment(line) {
                    continue;
                }
                for pattern in ENV_READ_PATTERNS {
                    if line.contains(pattern) {
                        hits.push((relative.clone(), (*pattern).to_string()));
                    }
                }
            }
        }
    }
    hits
}

#[test]
fn every_environment_read_outside_config_rs_is_on_the_named_probing_allowlist() {
    let src_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let hits = env_reads_outside_config(&src_dir);

    for (relative, pattern) in &hits {
        let is_allowed = ALLOWED.iter().any(|(allowed_path, allowed_pattern)| {
            allowed_path == relative && allowed_pattern == pattern
        });
        assert!(
            is_allowed,
            "{relative} reads the process environment directly (`{pattern}`), outside \
             src/config.rs and off AGENTS.md's machine-probing allowlist. Either route it \
             through config.rs (it is configuration), or add it to both ALLOWED here and the \
             carve-out list in AGENTS.md (it is a new probing site)."
        );
    }

    for (allowed_path, allowed_pattern) in ALLOWED {
        assert!(
            hits.iter()
                .any(|(relative, pattern)| relative == allowed_path && pattern == allowed_pattern),
            "AGENTS.md's allowlist names {allowed_path} (`{allowed_pattern}`), but no such read \
             exists any more — drop the stale entry from both this test and AGENTS.md."
        );
    }
}
