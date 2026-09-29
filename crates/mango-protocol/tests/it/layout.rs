//! Guards the one registry this binary has: `main.rs`'s `mod` list.
//!
//! A test file dropped into `tests/it/` without a `mod` line compiles into nothing and reports no
//! failure, which is how a suite goes missing without anyone noticing.

use std::collections::BTreeSet;
use std::path::Path;

/// Names every `tests/it/<name>.rs` (other than `main.rs`) that `main_source` does not declare as
/// `mod <name>;`. Returns them sorted: files `a.rs` and `b.rs` against a source declaring only
/// `mod a;` give `["b"]`.
fn unregistered_modules(files: &[String], main_source: &str) -> Vec<String> {
    let declared: BTreeSet<&str> = main_source
        .lines()
        .filter_map(|line| line.trim().strip_prefix("mod ")?.strip_suffix(';'))
        .collect();
    let mut missing: Vec<String> = files
        .iter()
        .filter_map(|file| file.strip_suffix(".rs"))
        .filter(|stem| *stem != "main" && !declared.contains(stem))
        .map(str::to_owned)
        .collect();
    missing.sort();
    missing
}

#[test]
fn every_file_beside_main_rs_is_a_declared_module() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/it");
    let files: Vec<String> = std::fs::read_dir(&dir)
        .unwrap_or_else(|error| {
            panic!(
                "expected {} to be readable | received: {error}",
                dir.display()
            )
        })
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .collect();
    let main_source = std::fs::read_to_string(dir.join("main.rs")).expect("main.rs reads");

    assert_eq!(
        unregistered_modules(&files, &main_source),
        Vec::<String>::new(),
        "expected every tests/it/*.rs file to be declared as `mod <name>;` in tests/it/main.rs | \
         received these undeclared files, which would silently never run"
    );
}

#[test]
fn an_undeclared_file_is_reported_and_a_declared_or_main_file_is_not() {
    let files = ["a.rs".to_owned(), "b.rs".to_owned(), "main.rs".to_owned()];

    assert_eq!(unregistered_modules(&files, "mod a;\n    mod c;\n"), ["b"]);
}
