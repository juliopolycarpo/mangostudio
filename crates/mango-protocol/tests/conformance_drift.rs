//! Asserts `mango_protocol::testing::CONFORMANCE_CASES` matches, name for
//! name and in order, every `it('...')` block in `packages/protocol/src/
//! testing/conformance.ts` — so the Rust and TypeScript conformance suites
//! cannot silently drift apart in either direction (a case added to one
//! suite and not the other fails this check exactly as a renamed one would).
//! Skipped, not failed, when the TypeScript source is absent, so a `cargo
//! package` verification build — which does not carry the rest of the
//! repository — still succeeds.
#![cfg(feature = "testing")]

use std::path::Path;

use mango_protocol::testing::CONFORMANCE_CASES;

#[test]
fn every_rust_case_name_appears_verbatim_in_the_typescript_suite() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/protocol/src/testing/conformance.ts");
    let Ok(source) = std::fs::read_to_string(&path) else {
        eprintln!(
            "skipping conformance drift check: {} not found",
            path.display()
        );
        return;
    };

    let ts_case_names: Vec<&str> = source
        .lines()
        .filter_map(|line| {
            let after = line.trim_start().strip_prefix("it('")?;
            let end = after.find('\'')?;
            Some(&after[..end])
        })
        .collect();

    assert_eq!(
        ts_case_names,
        CONFORMANCE_CASES,
        "CONFORMANCE_CASES must match {}'s it(...) names, verbatim and in order",
        path.display()
    );
}
