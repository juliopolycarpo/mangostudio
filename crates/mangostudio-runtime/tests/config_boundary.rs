//! Enforces AGENTS.md's "one parsing point per host" rule for
//! *configuration*: every environment variable this host reads as
//! configuration is parsed in `src/config.rs`, and nowhere else.
//!
//! Machine probing is a named carve-out from that rule, not an exception to
//! it: a detector reading `PATH`, `$HOME`, or a full environment snapshot to
//! describe what is actually on this machine is not configuration, and
//! AGENTS.md names the sites explicitly. This test is what keeps that list
//! honest — a change that adds a fifth site fails here, not in review.
//!
//! The allowlist pins the exact call text (including the literal being
//! read, e.g. `"PATH"`) *and* how many times it appears, not just which
//! file. A boolean "is this file on the list" check cannot catch a third
//! `env::var_os` call landing in an already-allowed file — including one
//! reading something that is genuinely configuration, like a token — since
//! the file is still on the list either way. Pinning the exact text also
//! catches a subtler case: swapping an allowed call's own literal argument
//! for a different one without adding a new line at all.

use std::collections::BTreeMap;
use std::path::Path;

/// `(path relative to `src/`, exact call text, expected occurrence count)`
/// triples AGENTS.md's carve-out names. Keep this in sync with that list; a
/// real new probing site — or a real change to an existing one's count — is
/// added here *and* to AGENTS.md in the same change, never only here.
const ALLOWED: &[(&str, &str, usize)] = &[
    ("health.rs", "env::var_os(\"PATH\")", 2),
    ("probing/host.rs", "env::vars()", 1),
    ("runtime_home.rs", "env::home_dir()", 1),
];

/// The call *shapes* this test scans for, independent of which literal (if
/// any) each one reads — this is deliberately broader than [`ALLOWED`]'s
/// exact texts, so a brand new site, or an allowed call whose literal
/// argument changed, still surfaces as a hit rather than going unseen.
/// `temp_dir` is absent: a scratch directory under `std::env::temp_dir()`
/// is not an environment read in the sense this rule cares about.
const ENV_READ_SHAPES: &[&str] = &["env::var(", "env::var_os(", "env::vars(", "env::home_dir("];

fn is_comment(line: &str) -> bool {
    line.trim_start().starts_with("//")
}

/// For a line already known to contain `shape`, the text this test
/// compares against [`ALLOWED`]: the first exact `ALLOWED` text the line
/// contains, or `shape` itself when the line matches no exact text (a new
/// call, or an allowed call whose literal changed) — either way, a value
/// that (deliberately) will not equal any `ALLOWED` entry's text unless the
/// call is byte-for-byte what AGENTS.md names.
fn signature_for(line: &str, shape: &'static str) -> String {
    ALLOWED
        .iter()
        .map(|&(_, exact, _)| exact)
        .find(|exact| line.contains(exact))
        .unwrap_or(shape)
        .to_string()
}

/// Every `(path relative to `src/`, signature)` hit outside `config.rs`,
/// found by walking the crate's own `src/` tree, folded into how many times
/// each pair occurred.
fn env_read_counts(src_dir: &Path) -> BTreeMap<(String, String), usize> {
    let mut counts = BTreeMap::new();
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
                if let Some(shape) = ENV_READ_SHAPES.iter().find(|shape| line.contains(**shape)) {
                    let signature = signature_for(line, shape);
                    *counts.entry((relative.clone(), signature)).or_insert(0) += 1;
                }
            }
        }
    }
    counts
}

#[test]
fn every_environment_read_outside_config_rs_matches_the_allowlists_exact_count() {
    let src_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let found = env_read_counts(&src_dir);

    let expected: BTreeMap<(String, String), usize> = ALLOWED
        .iter()
        .map(|&(path, text, count)| ((path.to_string(), text.to_string()), count))
        .collect();

    let mut keys: Vec<&(String, String)> = found.keys().chain(expected.keys()).collect();
    keys.sort();
    keys.dedup();

    for key @ (relative, signature) in keys {
        let found_count = found.get(key).copied().unwrap_or(0);
        let expected_count = expected.get(key).copied();
        match expected_count {
            None => panic!(
                "{relative} reads the process environment directly (`{signature}`) {found_count} \
                 time(s), outside src/config.rs and off AGENTS.md's machine-probing allowlist. \
                 Either route it through config.rs (it is configuration), or add it to both \
                 ALLOWED here and the carve-out list in AGENTS.md, with its exact call text and \
                 count (it is a new probing site)."
            ),
            Some(expected_count) => assert_eq!(
                found_count, expected_count,
                "{relative}'s `{signature}` read: expected {expected_count} occurrence(s) per \
                 AGENTS.md's allowlist, found {found_count}. A count that grew means a new call \
                 landed in an already-allowed file (update both this list and AGENTS.md if it is \
                 genuinely more probing, or route it through config.rs if it is configuration); \
                 a count that shrank means a stale entry to drop from both."
            ),
        }
    }
}
