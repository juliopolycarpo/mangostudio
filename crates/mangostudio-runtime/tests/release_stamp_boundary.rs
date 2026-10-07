//! The release stamp is the binary's, not the library's.
//!
//! `MANGOSTUDIO_RELEASE_VERSION` is a compile-time value (`option_env!`). Cargo recompiles
//! whatever crate reads it whenever the value changes, so a read inside the library recompiles
//! the whole 121,000-line crate for every canary, dry-run or release stamp, while a read in
//! `src/main.rs` recompiles only the entry point and relinks. The library takes the version as an
//! argument (`cli::run_with_version`) and never reads the stamp itself.
//!
//! This test scans the crate's own source, the way `config_boundary.rs` pins environment reads,
//! so a read that drifts back into the library fails here and not in a build-time report.

use std::path::{Path, PathBuf};

/// The compile-time variable `scripts/build.ts` stamps a distribution with.
const STAMP_VARIABLE: &str = "MANGOSTUDIO_RELEASE_VERSION";

/// The one file allowed to read [`STAMP_VARIABLE`], relative to `src/`: the binary's entry point.
const BINARY_ENTRY: &str = "main.rs";

/// The exact read the binary entry must contain, so the stamp stays a compile-time value.
const BINARY_ENTRY_READ: &str = "option_env!(\"MANGOSTUDIO_RELEASE_VERSION\")";

/// The `(1-based line, trimmed text)` of every non-comment line of `source` that names the stamp.
///
/// Usage: `stamp_lines("// MANGOSTUDIO_RELEASE_VERSION\nlet v = env!(\"MANGOSTUDIO_RELEASE_VERSION\");")`
/// is `[(2, "let v = env!(\"MANGOSTUDIO_RELEASE_VERSION\");")]`.
fn stamp_lines(source: &str) -> Vec<(usize, String)> {
    source
        .lines()
        .enumerate()
        .filter(|(_, line)| !line.trim_start().starts_with("//"))
        .filter(|(_, line)| line.contains(STAMP_VARIABLE))
        .map(|(index, line)| (index + 1, line.trim().to_owned()))
        .collect()
}

/// Every `.rs` file under `dir`, recursively.
fn rust_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).expect("src/ is readable") {
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

/// `path` relative to `root`, with `/` separators on every platform.
fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .expect("path is under root")
        .to_string_lossy()
        .replace('\\', "/")
}

/// The `(name relative to the crate root, source)` of every file the library is compiled from:
/// all of `src/` plus a crate-root `build.rs` (the other way a stamp could reach the library).
fn crate_sources(crate_root: &Path) -> Vec<(String, String)> {
    let mut files = rust_files(&crate_root.join("src"));
    let build_script = crate_root.join("build.rs");
    if build_script.exists() {
        files.push(build_script);
    }
    files
        .into_iter()
        .map(|path| {
            let source = std::fs::read_to_string(&path).expect("source file reads as utf8");
            (relative(crate_root, &path), source)
        })
        .collect()
}

/// Every `file:line: text` among `sources` that names the stamp, except in the binary entry.
///
/// Usage: `library_stamp_reads(&[("src/cli.rs".into(), "env!(\"MANGOSTUDIO_RELEASE_VERSION\")".into())])`
/// is `["src/cli.rs:1: env!(\"MANGOSTUDIO_RELEASE_VERSION\")"]`.
fn library_stamp_reads(sources: &[(String, String)]) -> Vec<String> {
    let entry = format!("src/{BINARY_ENTRY}");
    sources
        .iter()
        .filter(|(name, _)| *name != entry)
        .flat_map(|(name, source)| {
            stamp_lines(source)
                .into_iter()
                .map(move |(line, text)| format!("{name}:{line}: {text}"))
        })
        .collect()
}

#[test]
fn the_library_never_reads_the_release_stamp() {
    let crate_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let reads = library_stamp_reads(&crate_sources(crate_root));
    assert!(
        reads.is_empty(),
        "expected library release-stamp reads: none outside src/{BINARY_ENTRY} (the library \
         takes the version through `cli::run_with_version`) | received: {reads:?}"
    );
}

#[test]
fn the_binary_entry_reads_the_release_stamp_exactly_once_at_compile_time() {
    let entry = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join(BINARY_ENTRY);
    let source = std::fs::read_to_string(&entry).expect("the binary entry reads as utf8");
    let compile_time_reads = stamp_lines(&source)
        .into_iter()
        .filter(|(_, text)| text.contains(BINARY_ENTRY_READ))
        .count();
    assert_eq!(
        compile_time_reads, 1,
        "expected src/{BINARY_ENTRY} compile-time release-stamp reads (`{BINARY_ENTRY_READ}`): 1 \
         | received: {compile_time_reads}"
    );
}

#[test]
fn a_code_read_is_reported_with_its_line_and_a_comment_is_not() {
    let source = "// MANGOSTUDIO_RELEASE_VERSION in prose\n\
                  const V: &str = env!(\"MANGOSTUDIO_RELEASE_VERSION\");\n\
                  /// MANGOSTUDIO_RELEASE_VERSION in a doc comment\n";

    assert_eq!(
        stamp_lines(source),
        [(
            2,
            "const V: &str = env!(\"MANGOSTUDIO_RELEASE_VERSION\");".to_owned()
        )],
        "expected exactly the code line (line 2) to be reported | received a different set"
    );
}

#[test]
fn a_library_read_is_found_and_the_binary_entrys_is_not() {
    let read = format!("const V: &str = {BINARY_ENTRY_READ};");
    let sources = [
        ("src/main.rs".to_owned(), read.clone()),
        ("src/nested/cli.rs".to_owned(), read.clone()),
        ("build.rs".to_owned(), "fn main() {}".to_owned()),
    ];

    assert_eq!(
        library_stamp_reads(&sources),
        [format!("src/nested/cli.rs:1: {read}")],
        "expected the scan to report only the library read, not the binary entry's"
    );
}
