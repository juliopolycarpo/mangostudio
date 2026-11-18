//! Pins which packages the release profile builds for size and which it keeps at speed.
//!
//! The shipped binary is built with the workspace `[profile.release]` (`opt-level = 3`) plus
//! per-package overrides in the root `Cargo.toml`. The overrides trade speed for size on code a
//! runtime call rarely runs; a package that later becomes hot, or a new dependency that should
//! shrink, is a deliberate edit of both the manifest and the lists below, not a drive-by.
//! Nothing at test time builds the release profile, so this reads the manifest text.

use std::collections::BTreeSet;

use toml::Table;

/// Packages built with `opt-level = "s"`: the JSON Schema validator family, then the network,
/// TLS, parsing, adapter and contract crates the runtime spends its time waiting on, and
/// `mangostudio-runtime-cold`, the host's own MCP, external-agent, probing and command code.
const SIZE_OPTIMISED: &[&str] = &[
    "agent-client-protocol-schema",
    "aho-corasick",
    "cap-primitives",
    "cap-std",
    "chrono",
    "fancy-regex",
    "globset",
    "hyper",
    "hyper-util",
    "icu_collator",
    "icu_normalizer",
    "idna",
    "jsonschema",
    "jsonschema-regex",
    "jsonschema-value",
    "mango-agent-acp",
    "mango-agent-claude",
    "mango-agent-codex",
    "mangostudio-runtime-cold",
    "mangostudio-runtime-contract",
    "referencing",
    "regex-automata",
    "regex-syntax",
    "reqwest",
    "rmcp",
    "rustls",
    "rustls-webpki",
    "serde_with",
    "sse-stream",
    "tokio-tungstenite",
    "toml",
    "toml_parser",
    "tungstenite",
    "url",
];

/// Packages that must keep the profile's `opt-level = 3`, and why:
///
/// - `mangostudio-runtime`: `fs.grep`'s walk and `fs.list-directory` run in its code. At `s` the
///   1,000-file grep measured about 9% slower.
/// - `mangostudio-runtime-core`: the registry that dispatches every request, the bounded
///   blocking pool and the subprocess runner the PTY and `git` paths use. Hot paths, so it
///   stays with the binary crate at speed; only the cold half is built for size.
/// - `mango-external-agents`: its per-character text bounding ran 66% slower at `s`.
/// - `mango-protocol`: frame encode and decode for every request and response. At `s` a multi-MiB
///   answer (an 8 MiB `fs.list-directory`, a 50,000-entry `fs.glob`) took 3% to 4% longer, and the
///   small-event and error paths in the external-agent boundary benchmark 4% to 5%.
/// - `memchr`: the line and literal scans under `fs.grep`.
/// - `serde_json`, `tokio`: every request and response passes through them.
/// - `rquickjs-sys`: C built by cc-rs, which reads the optimisation level from the package
///   profile, so `s` would compile the regex engine `fs.grep` runs per line with `-Os`.
const SPEED_CRITICAL: &[&str] = &[
    "mangostudio-runtime",
    "mangostudio-runtime-core",
    "mango-external-agents",
    "mango-protocol",
    "memchr",
    "serde_json",
    "tokio",
    "rquickjs-sys",
];

/// A TOML value as it is written in the manifest: `"s"` keeps its quotes and `3` has none, so
/// the string `"3"` and the integer `3` stay different.
fn render_level(level: &toml::Value) -> String {
    match level {
        toml::Value::String(text) => format!("\"{text}\""),
        toml::Value::Integer(number) => number.to_string(),
        other => format!("{other:?}"),
    }
}

/// The `[profile.release.package.<name>] opt-level` values in `manifest_source`, as
/// `(name, rendered value)` pairs: a manifest with `[profile.release.package.rmcp]` and
/// `opt-level = "s"` gives `("rmcp", "\"s\"")`. A package table without an `opt-level` is absent.
fn release_package_opt_levels(manifest_source: &str) -> Vec<(String, String)> {
    let manifest: Table = manifest_source
        .parse()
        .expect("the manifest parses as TOML");
    let packages = manifest
        .get("profile")
        .and_then(|profile| profile.get("release"))
        .and_then(|release| release.get("package"))
        .and_then(|packages| packages.as_table());
    let Some(packages) = packages else {
        return Vec::new();
    };
    packages
        .iter()
        .filter_map(|(name, settings)| {
            let level = settings.get("opt-level")?;
            Some((name.clone(), render_level(level)))
        })
        .collect()
}

fn root_manifest_source() -> (String, String) {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../Cargo.toml").to_owned();
    let source = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("expected {path} to be readable | received: {error}"));
    (path, source)
}

#[test]
fn the_release_profile_defaults_to_opt_level_3() {
    let (path, source) = root_manifest_source();
    let manifest: Table = source.parse().expect("the workspace manifest parses");
    let level = manifest
        .get("profile")
        .and_then(|profile| profile.get("release"))
        .and_then(|release| release.get("opt-level"))
        .map(render_level);

    assert_eq!(
        level.as_deref(),
        Some("3"),
        "expected [profile.release] opt-level = 3 in {path} | received: {level:?}"
    );
}

#[test]
fn exactly_the_measured_packages_are_built_for_size() {
    let (path, source) = root_manifest_source();
    let actual: BTreeSet<String> = release_package_opt_levels(&source)
        .into_iter()
        .filter(|(_, level)| level == "\"s\"")
        .map(|(name, _)| name)
        .collect();
    let expected: BTreeSet<String> = SIZE_OPTIMISED
        .iter()
        .map(|name| (*name).to_owned())
        .collect();

    let unexpected: Vec<&String> = actual.difference(&expected).collect();
    let missing: Vec<&String> = expected.difference(&actual).collect();
    assert!(
        unexpected.is_empty() && missing.is_empty(),
        "expected the [profile.release.package.*] opt-level = \"s\" set in {path} to equal \
         SIZE_OPTIMISED | received unexpected: {unexpected:?}, missing: {missing:?}"
    );
}

#[test]
fn every_package_override_is_either_s_or_3() {
    let (path, source) = root_manifest_source();
    let others: Vec<(String, String)> = release_package_opt_levels(&source)
        .into_iter()
        .filter(|(_, level)| level != "\"s\"" && level != "3")
        .collect();

    assert!(
        others.is_empty(),
        "expected every [profile.release.package.*] opt-level in {path} to be \"s\" or 3 | \
         received: {others:?}"
    );
}

#[test]
fn hot_packages_keep_opt_level_3() {
    let (path, source) = root_manifest_source();
    let levels = release_package_opt_levels(&source);
    let lowered: Vec<&(String, String)> = levels
        .iter()
        .filter(|(name, level)| SPEED_CRITICAL.contains(&name.as_str()) && level != "3")
        .collect();

    assert!(
        lowered.is_empty(),
        "expected no [profile.release.package.*] opt-level other than 3 for {SPEED_CRITICAL:?} \
         in {path} | received: {lowered:?}"
    );
}

/// `mangostudio-runtime` owns the binary target. A build with `opt-level = "s"` set for that
/// package (through `--config`, on linux-x64) left the symbol table in the binary, 5.4 MB of
/// `.symtab` and `.strtab`, although `[profile.release]` says `strip = true`. The cause was not
/// traced, so any override table on this package is refused until a release build is shown to
/// stay stripped with it.
#[test]
fn the_binary_package_has_no_release_override() {
    let (path, source) = root_manifest_source();
    let manifest: Table = source.parse().expect("the workspace manifest parses");
    let table = manifest
        .get("profile")
        .and_then(|profile| profile.get("release"))
        .and_then(|release| release.get("package"))
        .and_then(|packages| packages.get("mangostudio-runtime"));

    assert!(
        table.is_none(),
        "expected no [profile.release.package.mangostudio-runtime] table in {path}: an override \
         on the binary's own package left the symbol table in the stripped release build | \
         received: {table:?}"
    );
}

#[test]
fn the_two_lists_do_not_overlap() {
    let overlap: Vec<&&str> = SIZE_OPTIMISED
        .iter()
        .filter(|name| SPEED_CRITICAL.contains(name))
        .collect();

    assert!(
        overlap.is_empty(),
        "expected SIZE_OPTIMISED and SPEED_CRITICAL to share no package | received: {overlap:?}"
    );
}

#[test]
fn package_opt_levels_are_read_from_a_manifest_text() {
    let manifest = r#"
[profile.release]
opt-level = 3

[profile.release.package.rmcp]
opt-level = "s"

[profile.release.package.tokio]
opt-level = 3

[profile.release.package.url]
debug = false

[profile.dev.package.reqwest]
opt-level = 1
"#;

    assert_eq!(
        release_package_opt_levels(manifest),
        [
            ("rmcp".to_owned(), "\"s\"".to_owned()),
            ("tokio".to_owned(), "3".to_owned()),
        ],
        "expected the release package opt-levels in name order, skipping a table without an \
         opt-level and any dev profile | received a different list"
    );
    assert!(release_package_opt_levels("[profile.release]\nopt-level = 3\n").is_empty());
}
