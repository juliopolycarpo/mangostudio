//! The release stamp is the binary's, not the library's.
//!
//! `MANGOSTUDIO_RELEASE_VERSION` is a compile-time value (`option_env!`). Cargo recompiles
//! whatever crate reads it whenever the value changes, and everything that depends on that crate
//! with it, so a read inside the library, or inside a workspace crate the library depends on,
//! recompiles the whole 121,000-line runtime for every canary, dry-run or release stamp, while a
//! read in `src/main.rs` recompiles only the entry point and relinks. The library takes the
//! version as an argument (`cli::run_with_version`) and never reads the stamp itself.
//!
//! This test scans the source of the runtime crate and of every workspace crate it depends on,
//! the way `config_boundary.rs` pins environment reads, so a read that drifts back into any of
//! them fails here and not in a build-time report.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// The compile-time variable `scripts/build.ts` stamps a distribution with.
const STAMP_VARIABLE: &str = "MANGOSTUDIO_RELEASE_VERSION";

/// The one file allowed to read [`STAMP_VARIABLE`], relative to the runtime crate: the binary's
/// entry point.
const BINARY_ENTRY: &str = "src/main.rs";

/// The exact read the binary entry must contain, so the stamp stays a compile-time value.
const BINARY_ENTRY_READ: &str = "option_env!(\"MANGOSTUDIO_RELEASE_VERSION\")";

/// The exact call by which the binary entry hands the stamp to the library.
const BINARY_ENTRY_HANDOFF: &str = "cli::run_with_version(&args, &ProcessEnv, VERSION)";

/// `line` without its trailing `//` comment, ignoring a `//` inside a string literal.
///
/// Usage: `code_of("let x = 1; // note")` is `"let x = 1; "`.
fn code_of(line: &str) -> &str {
    let bytes = line.as_bytes();
    let mut in_string = false;
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' if in_string => index += 1,
            b'"' => in_string = !in_string,
            b'/' if !in_string && bytes.get(index + 1) == Some(&b'/') => return &line[..index],
            _ => {}
        }
        index += 1;
    }
    line
}

/// Whether `code` reads the stamp: the variable as an exact string literal (the argument of
/// `option_env!`, `env!` or `std::env::var`), or named by a build script's `rustc-env` or
/// `rerun-if-env-changed` directive. A longer message that merely mentions the variable is not a
/// read.
fn reads_stamp(code: &str) -> bool {
    [
        format!("\"{STAMP_VARIABLE}\""),
        format!("rustc-env={STAMP_VARIABLE}"),
        format!("rerun-if-env-changed={STAMP_VARIABLE}"),
    ]
    .iter()
    .any(|pattern| code.contains(pattern.as_str()))
}

/// The `(1-based line, trimmed code)` of every line of `source` that reads the stamp, with
/// comments (whole-line and trailing) left out.
///
/// Usage: `stamp_lines("let v = env!(\"MANGOSTUDIO_RELEASE_VERSION\"); // read")` is
/// `[(1, "let v = env!(\"MANGOSTUDIO_RELEASE_VERSION\");")]`.
fn stamp_lines(source: &str) -> Vec<(usize, String)> {
    source
        .lines()
        .enumerate()
        .map(|(index, line)| (index + 1, code_of(line).trim()))
        .filter(|(_, code)| !code.is_empty() && reads_stamp(code))
        .map(|(line, code)| (line, code.to_owned()))
        .collect()
}

/// The directories under `crates/` whose crates `manifest` names as dependencies, as `name = ...`,
/// `name.workspace = true` or `name.path = ...` keys.
///
/// Usage: with `candidates` `["a", "b"]`, a manifest holding the line `a.workspace = true` gives
/// `["a"]`.
fn dependencies_in(manifest: &str, candidates: &BTreeSet<String>) -> Vec<String> {
    let keys: BTreeSet<&str> = manifest
        .lines()
        .map(str::trim)
        .filter(|line| !line.starts_with('#'))
        .filter_map(|line| line.split_once('=').map(|(key, _)| key.trim()))
        .filter_map(|key| key.split('.').next())
        .collect();
    candidates
        .iter()
        .filter(|name| keys.contains(name.as_str()))
        .cloned()
        .collect()
}

/// The runtime crate and every workspace crate it depends on, directly or through another one,
/// as directory names under `crates/`.
fn runtime_crate_closure(crates_dir: &Path, runtime: &str) -> BTreeSet<String> {
    let siblings: BTreeSet<String> = std::fs::read_dir(crates_dir)
        .expect("crates/ is readable")
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter(|name| crates_dir.join(name).join("Cargo.toml").exists())
        .collect();
    let mut closure = BTreeSet::from([runtime.to_owned()]);
    let mut pending = vec![runtime.to_owned()];
    while let Some(name) = pending.pop() {
        let manifest = std::fs::read_to_string(crates_dir.join(&name).join("Cargo.toml"))
            .expect("a workspace crate's manifest reads");
        let others: BTreeSet<String> = siblings.difference(&closure).cloned().collect();
        for dependency in dependencies_in(&manifest, &others) {
            closure.insert(dependency.clone());
            pending.push(dependency);
        }
    }
    closure
}

/// Every `.rs` file under `dir`, recursively and sorted; none when `dir` does not exist.
fn rust_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries {
            let path = entry.expect("dir entry reads").path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().and_then(|ext| ext.to_str()) == Some("rs") {
                files.push(path);
            }
        }
    }
    files.sort();
    files
}

/// The `(name relative to the workspace root, source)` of every file `crate_names` are compiled
/// from: each crate's `src/` plus its crate-root `build.rs` (the other way a stamp could reach it).
fn crate_sources(crates_dir: &Path, crate_names: &BTreeSet<String>) -> Vec<(String, String)> {
    let root = crates_dir.parent().expect("crates/ has a parent");
    let mut files = Vec::new();
    for name in crate_names {
        let crate_dir = crates_dir.join(name);
        files.extend(rust_files(&crate_dir.join("src")));
        let build_script = crate_dir.join("build.rs");
        if build_script.exists() {
            files.push(build_script);
        }
    }
    files
        .into_iter()
        .map(|path| {
            let source = std::fs::read_to_string(&path).expect("source file reads as utf8");
            let name = path
                .strip_prefix(root)
                .expect("path is under the workspace root")
                .to_string_lossy()
                .replace('\\', "/");
            (name, source)
        })
        .collect()
}

/// Every `file:line: text` among `sources` that reads the stamp, except in `entry`.
///
/// Usage: `library_stamp_reads(&[("src/cli.rs".into(), "env!(\"MANGOSTUDIO_RELEASE_VERSION\")".into())], "src/main.rs")`
/// is `["src/cli.rs:1: env!(\"MANGOSTUDIO_RELEASE_VERSION\")"]`.
fn library_stamp_reads(sources: &[(String, String)], entry: &str) -> Vec<String> {
    sources
        .iter()
        .filter(|(name, _)| name != entry)
        .flat_map(|(name, source)| {
            stamp_lines(source)
                .into_iter()
                .map(move |(line, text)| format!("{name}:{line}: {text}"))
        })
        .collect()
}

fn runtime_crate() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// The binary entry's source, for the two tests that pin what it contains.
fn binary_entry_source() -> String {
    std::fs::read_to_string(runtime_crate().join(BINARY_ENTRY))
        .expect("the binary entry reads as utf8")
}

#[test]
fn neither_the_library_nor_a_crate_it_depends_on_reads_the_release_stamp() {
    let runtime = runtime_crate();
    let crates_dir = runtime
        .parent()
        .expect("the runtime crate is under crates/");
    let runtime_name = runtime
        .file_name()
        .and_then(|name| name.to_str())
        .expect("the runtime crate directory has a name");
    let closure = runtime_crate_closure(crates_dir, runtime_name);
    let entry = format!("crates/{runtime_name}/{BINARY_ENTRY}");

    let reads = library_stamp_reads(&crate_sources(crates_dir, &closure), &entry);

    assert!(
        reads.is_empty(),
        "expected release-stamp reads in {closure:?}: none outside {entry} (the library takes the \
         version through `cli::run_with_version`) | received: {reads:?}"
    );
}

#[test]
fn the_scan_covers_the_runtime_and_the_workspace_crates_it_depends_on() {
    let runtime = runtime_crate();
    let crates_dir = runtime
        .parent()
        .expect("the runtime crate is under crates/");

    let closure = runtime_crate_closure(crates_dir, "mangostudio-runtime");

    assert!(
        [
            "mangostudio-runtime",
            "mango-protocol",
            "mangostudio-runtime-contract"
        ]
        .iter()
        .all(|name| closure.contains(*name)),
        "expected the scanned crates to include mangostudio-runtime, mango-protocol and \
         mangostudio-runtime-contract | received: {closure:?}"
    );
}

#[test]
fn the_binary_entry_reads_the_release_stamp_exactly_once_at_compile_time() {
    let source = binary_entry_source();
    let compile_time_reads = stamp_lines(&source)
        .into_iter()
        .filter(|(_, text)| text.contains(BINARY_ENTRY_READ))
        .count();
    assert_eq!(
        compile_time_reads, 1,
        "expected {BINARY_ENTRY} compile-time release-stamp reads (`{BINARY_ENTRY_READ}`): 1 | \
         received: {compile_time_reads}"
    );
}

#[test]
fn the_binary_entry_hands_its_stamp_to_the_library() {
    let source = binary_entry_source();
    let handoffs = source
        .lines()
        .map(|line| code_of(line).trim())
        .filter(|code| code.contains(BINARY_ENTRY_HANDOFF))
        .count();
    assert_eq!(
        handoffs, 1,
        "expected {BINARY_ENTRY} calls `{BINARY_ENTRY_HANDOFF}`: 1 | received: {handoffs} (a call \
         that passes another version reports it from the shipped binary)"
    );
}

#[test]
fn a_code_read_is_reported_with_its_line_and_prose_is_not() {
    let source = "// MANGOSTUDIO_RELEASE_VERSION in prose\n\
                  const V: &str = env!(\"MANGOSTUDIO_RELEASE_VERSION\");\n\
                  /// MANGOSTUDIO_RELEASE_VERSION in a doc comment\n\
                  let a = 1; // reads \"MANGOSTUDIO_RELEASE_VERSION\" nowhere\n\
                  let b = \"set MANGOSTUDIO_RELEASE_VERSION to a release\";\n\
                  let c = \"// not a comment\"; let d = option_env!(\"MANGOSTUDIO_RELEASE_VERSION\");\n\
                  println!(\"cargo:rerun-if-env-changed=MANGOSTUDIO_RELEASE_VERSION\");\n";

    let lines: Vec<usize> = stamp_lines(source)
        .into_iter()
        .map(|(line, _)| line)
        .collect();

    assert_eq!(
        lines,
        [2, 6, 7],
        "expected reads on lines [2, 6, 7] (code only: not prose, a trailing comment, or a longer \
         message) | received: {lines:?}"
    );
}

#[test]
fn a_library_read_is_found_and_the_binary_entrys_is_not() {
    let read = format!("const V: &str = {BINARY_ENTRY_READ};");
    let sources = [
        ("crates/rt/src/main.rs".to_owned(), read.clone()),
        ("crates/rt/src/nested/cli.rs".to_owned(), read.clone()),
        ("crates/dep/build.rs".to_owned(), format!("{read} // stamp")),
        (
            "crates/dep/src/lib.rs".to_owned(),
            "fn main() {}".to_owned(),
        ),
    ];

    assert_eq!(
        library_stamp_reads(&sources, "crates/rt/src/main.rs"),
        [
            format!("crates/rt/src/nested/cli.rs:1: {read}"),
            format!("crates/dep/build.rs:1: {read}"),
        ],
        "expected the scan to report the library and dependency reads, not the binary entry's"
    );
}

#[test]
fn dependencies_are_found_by_their_manifest_keys_not_by_prose() {
    let candidates = BTreeSet::from(["alpha".to_owned(), "beta".to_owned(), "gamma".to_owned()]);
    let manifest = "[dependencies]\n\
                    alpha = { workspace = true, features = [\"x\"] }\n\
                    # beta = \"1\"\n\
                    gamma.workspace = true\n\
                    delta = \"1\"\n";

    assert_eq!(
        dependencies_in(manifest, &candidates),
        ["alpha", "gamma"],
        "expected the dependencies [alpha, gamma] (not the commented beta) | received a different set"
    );
}
