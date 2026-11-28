//! The release version is not a compile input.
//!
//! Distribution builds used to hand the release to rustc through `MANGOSTUDIO_RELEASE_VERSION`
//! (`option_env!`), so every canary, dry-run or release stamp recompiled the crate that read it
//! and relinked a binary that differed from the last one. Now `scripts/lib/runtime-stamp.ts`
//! writes the version into a slot of the linked binary (`RELEASE_STAMP` in `src/main.rs`), and
//! two commits with equal Rust inputs compile to the same bytes.
//!
//! That holds only while three things stay true, and this test pins each of them the way
//! `config_boundary.rs` pins environment reads, so a drift fails here and not in a build report:
//!
//! - no source of the runtime crate, or of a workspace crate it depends on, reads the release
//!   from the environment at compile or run time;
//! - the slot's magic occurs in `src/main.rs` and nowhere else in those crates, because the
//!   patcher refuses a binary holding it more or less than once, and a comparison against it
//!   would leave a second copy in the machine code;
//! - `src/main.rs` reads the slot through `black_box` and hands the result to the library, so the
//!   optimizer cannot fold the unstamped contents it sees at compile time.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// The variable distribution builds passed to rustc before the stamp moved into the binary.
const STAMP_VARIABLE: &str = "MANGOSTUDIO_RELEASE_VERSION";

/// The binary's entry point relative to the runtime crate, the one file that owns the slot.
const BINARY_ENTRY: &str = "src/main.rs";

/// The constant in the binary entry that holds the slot's magic.
const MAGIC_CONSTANT: &str = "STAMP_MAGIC";

/// The exact read by which the binary entry loads the slot at run time.
const BINARY_ENTRY_SLOT_READ: &str = "std::hint::black_box(&RELEASE_STAMP)";

/// The exact call by which the binary entry hands the release to the library.
const BINARY_ENTRY_HANDOFF: &str = "cli::run_with_version(&args, &ProcessEnv, version)";

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

/// The `(name relative to the workspace root, source)` of every Rust file under `directories` of
/// each crate in `crate_names`, plus each crate-root `build.rs` (the other way a stamp could
/// reach a crate).
fn crate_sources(
    crates_dir: &Path,
    crate_names: &BTreeSet<String>,
    directories: &[&str],
) -> Vec<(String, String)> {
    let root = crates_dir.parent().expect("crates/ has a parent");
    let mut files = Vec::new();
    for name in crate_names {
        let crate_dir = crates_dir.join(name);
        for directory in directories {
            files.extend(rust_files(&crate_dir.join(directory)));
        }
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

/// Every `file:line: text` among `sources` that reads the stamp variable.
///
/// Usage: `stamp_reads(&[("src/cli.rs".into(), "env!(\"MANGOSTUDIO_RELEASE_VERSION\")".into())])`
/// is `["src/cli.rs:1: env!(\"MANGOSTUDIO_RELEASE_VERSION\")"]`.
fn stamp_reads(sources: &[(String, String)]) -> Vec<String> {
    sources
        .iter()
        .flat_map(|(name, source)| {
            stamp_lines(source)
                .into_iter()
                .map(move |(line, text)| format!("{name}:{line}: {text}"))
        })
        .collect()
}

/// The bytes of [`MAGIC_CONSTANT`]'s array literal in `entry_source`, in the
/// `const STAMP_MAGIC: [u8; N] = [0x1a, 0x42, ...];` form, or `None` when there is none.
///
/// Usage: `magic_bytes("const STAMP_MAGIC: [u8; 2] = [0x01, 0xff];")` is `Some(vec![1, 255])`.
fn magic_bytes(entry_source: &str) -> Option<Vec<u8>> {
    let declaration = format!("const {MAGIC_CONSTANT}:");
    let after = &entry_source[entry_source.find(&declaration)? + declaration.len()..];
    let literal = &after[after.find("= [")? + 3..];
    literal[..literal.find("];")?]
        .split(',')
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(|token| u8::from_str_radix(token.strip_prefix("0x")?, 16).ok())
        .collect()
}

/// The names of the `sources` whose code spells `magic` as a byte-array literal (`0x1a, 0x42, ...`,
/// whatever the whitespace), except `entry`, which owns it.
///
/// Usage: `magic_copies(&[("a.rs".into(), "[0x01, 0xff]".into())], &[1, 255], "main.rs")` is
/// `["a.rs"]`.
fn magic_copies(sources: &[(String, String)], magic: &[u8], entry: &str) -> Vec<String> {
    let spelled = magic
        .iter()
        .map(|byte| format!("0x{byte:02x}"))
        .collect::<Vec<_>>()
        .join(",");
    sources
        .iter()
        .filter(|(name, _)| name != entry)
        .filter(|(_, source)| {
            let squeezed: String = source
                .lines()
                .map(code_of)
                .collect::<String>()
                .chars()
                .filter(|character| !character.is_whitespace())
                .collect();
            squeezed.to_lowercase().contains(&spelled)
        })
        .map(|(name, _)| name.clone())
        .collect()
}

fn runtime_crate() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// The runtime crate's directory name and every workspace crate directory it depends on.
fn runtime_closure() -> (PathBuf, String, BTreeSet<String>) {
    let runtime = runtime_crate();
    let crates_dir = runtime
        .parent()
        .expect("the runtime crate is under crates/")
        .to_path_buf();
    let runtime_name = runtime
        .file_name()
        .and_then(|name| name.to_str())
        .expect("the runtime crate directory has a name")
        .to_owned();
    let closure = runtime_crate_closure(&crates_dir, &runtime_name);
    (crates_dir, runtime_name, closure)
}

/// The binary entry's source, for the tests that pin what it contains.
fn binary_entry_source() -> String {
    std::fs::read_to_string(runtime_crate().join(BINARY_ENTRY))
        .expect("the binary entry reads as utf8")
}

#[test]
fn no_crate_of_the_runtime_reads_the_release_from_the_environment() {
    let (crates_dir, _, closure) = runtime_closure();

    let reads = stamp_reads(&crate_sources(&crates_dir, &closure, &["src"]));

    assert!(
        reads.is_empty(),
        "expected release-stamp reads in {closure:?}: none (the release is stamped into the linked \
         binary by scripts/lib/runtime-stamp.ts, never compiled in) | received: {reads:?}"
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
fn the_magic_is_spelled_in_the_binary_entry_and_nowhere_else() {
    let (crates_dir, runtime_name, closure) = runtime_closure();
    let entry_source = binary_entry_source();
    let magic = magic_bytes(&entry_source).unwrap_or_default();
    assert_eq!(
        magic.len(),
        16,
        "expected {BINARY_ENTRY} `const {MAGIC_CONSTANT}: [u8; 16] = [0x.., ...];` holding 16 \
         bytes | received: {magic:?}"
    );

    let entry = format!("crates/{runtime_name}/{BINARY_ENTRY}");
    let sources = crate_sources(&crates_dir, &closure, &["src", "tests", "examples"]);
    let copies = magic_copies(&sources, &magic, &entry);

    assert!(
        copies.is_empty(),
        "expected the release-stamp magic in {entry} only (the patcher requires exactly one copy \
         in the binary) | received it also in: {copies:?}"
    );
}

#[test]
fn the_magic_constant_is_only_copied_into_the_slot() {
    let source = binary_entry_source();
    let uses = source
        .lines()
        .map(|line| code_of(line).trim())
        .filter(|code| code.contains(MAGIC_CONSTANT) && !code.starts_with("const "))
        .collect::<Vec<_>>();

    assert_eq!(
        uses,
        ["slot[index] = STAMP_MAGIC[index];"],
        "expected {BINARY_ENTRY} to use `{MAGIC_CONSTANT}` only to build the static slot (a \
         comparison against it leaves a second copy of the magic in the machine code) | \
         received: {uses:?}"
    );
}

#[test]
fn the_binary_entry_reads_the_slot_through_black_box_exactly_once() {
    let source = binary_entry_source();
    let reads = source
        .lines()
        .map(|line| code_of(line).trim())
        .filter(|code| code.contains(BINARY_ENTRY_SLOT_READ))
        .count();
    let declaration = source
        .lines()
        .map(|line| code_of(line).trim())
        .collect::<Vec<_>>();
    let used_before_static = declaration
        .windows(2)
        .any(|pair| pair[0] == "#[used]" && pair[1].starts_with("static RELEASE_STAMP:"));

    assert_eq!(
        reads, 1,
        "expected {BINARY_ENTRY} reads the slot through `{BINARY_ENTRY_SLOT_READ}`: 1 | received: \
         {reads} (without it the optimizer folds the unstamped zero length into the binary)"
    );
    assert!(
        used_before_static,
        "expected {BINARY_ENTRY} declares `#[used]` directly above `static RELEASE_STAMP:` | \
         received: {declaration:?}"
    );
}

#[test]
fn the_binary_entry_hands_the_release_to_the_library() {
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
fn the_magic_literal_is_read_from_the_declaration_and_found_only_outside_the_entry() {
    let entry_source = "/// docs\n\
                        const STAMP_MAGIC: [u8; 3] = [\n    0x1a, 0x42,\n    0xff,\n];\n";
    assert_eq!(magic_bytes(entry_source), Some(vec![0x1a, 0x42, 0xff]));
    assert_eq!(magic_bytes("const OTHER: [u8; 1] = [0x01];"), None);

    let sources = [
        (
            "crates/rt/src/main.rs".to_owned(),
            "[0x1a, 0x42, 0xff]".to_owned(),
        ),
        (
            "crates/rt/src/other.rs".to_owned(),
            "let m = [\n 0x1A,0x42,\n 0xFF ];".to_owned(),
        ),
        (
            "crates/rt/tests/prose.rs".to_owned(),
            "// [0x1a, 0x42, 0xff] in a comment".to_owned(),
        ),
        (
            "crates/rt/tests/different.rs".to_owned(),
            "[0x1a, 0x42, 0xfe]".to_owned(),
        ),
    ];

    assert_eq!(
        magic_copies(&sources, &[0x1a, 0x42, 0xff], "crates/rt/src/main.rs"),
        ["crates/rt/src/other.rs"],
        "expected only the code copy outside the entry (not a comment, not a different array)"
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
fn a_read_is_found_in_every_file_including_the_binary_entry() {
    let read = format!("const V: &str = option_env!(\"{STAMP_VARIABLE}\");");
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
        stamp_reads(&sources),
        [
            format!("crates/rt/src/main.rs:1: {read}"),
            format!("crates/rt/src/nested/cli.rs:1: {read}"),
            format!("crates/dep/build.rs:1: {read}"),
        ],
        "expected the scan to report the binary entry's read too: no file may read the release"
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
