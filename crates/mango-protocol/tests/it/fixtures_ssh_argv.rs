//! `spec/fixtures/1/ssh-argv.json` run against this crate's `ssh` preset.
//!
//! The corpus is generated from the TypeScript builder, so this file passing
//! is the proof that both SDKs hand the operating system the same command line
//! for the same inputs — down to the quoting of the remote path.
#![cfg(feature = "spawn")]

use mango_protocol::transports::ssh::{SshArgv, ssh_argv};
use serde_json::Value;

/// The corpus, read at compile time so a `cargo package` build carries it.
const CORPUS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../spec/fixtures/1/ssh-argv.json"
));

/// Reject cases this crate's types refuse outright, so `ssh_argv` is never
/// reached for them.
///
/// Named rather than skipped. A case that quietly falls out of the run is one
/// nothing cross-checks, which is exactly what `n_port_above_the_range` did
/// while the exclusion was implicit: the reject test counted it as passing
/// without ever calling `ssh_argv` on it. The test below fails both ways —
/// when a case it cannot express is missing from this list, and when a case on
/// this list turns out to be expressible after all and should simply be run.
const REFUSED_BY_TYPE: &[&str] = &["n_port_above_the_range"];

fn cases() -> Vec<Value> {
    let document: Value = serde_json::from_str(CORPUS).expect("ssh-argv.json is valid JSON");
    let cases = document["cases"].as_array().expect("a cases array").clone();
    assert!(!cases.is_empty(), "expected at least one case");
    cases
}

fn strings(value: &Value, member: &str) -> Vec<String> {
    value[member]
        .as_array()
        .unwrap_or_else(|| panic!("case member {member} is not an array: {value}"))
        .iter()
        .map(|word| {
            word.as_str()
                .unwrap_or_else(|| panic!("case member {member} holds a non-string: {value}"))
                .to_owned()
        })
        .collect()
}

/// Builds the options a case describes, or `None` when the case names a value
/// this crate's types cannot hold — a port outside `1..=65535`, say, which
/// `u16` refuses before any check of ours runs.
fn options_of(case: &Value) -> Option<SshArgv> {
    let raw = &case["options"];
    let host = raw["host"].as_str().expect("every case names a host");
    let mut options = SshArgv::new(host, strings(raw, "command"));

    if let Some(user) = raw.get("user").and_then(Value::as_str) {
        options = options.with_user(user);
    }
    if let Some(identity_file) = raw.get("identityFile").and_then(Value::as_str) {
        options = options.with_identity_file(identity_file);
    }
    if let Some(port) = raw.get("port").and_then(Value::as_u64) {
        options = options.with_port(u16::try_from(port).ok()?);
    }
    if let Some(seconds) = raw.get("connectTimeoutSeconds").and_then(Value::as_u64) {
        options = options.with_connect_timeout_seconds(u32::try_from(seconds).ok()?);
    }
    Some(options)
}

#[test]
fn every_accept_case_builds_the_argv_the_corpus_holds() {
    let mut ran = 0;
    for case in cases() {
        if case["verdict"] != "accept" {
            continue;
        }
        let name = case["name"].as_str().expect("a name");
        let options = options_of(&case).unwrap_or_else(|| {
            panic!("{name}: an accept case must be expressible in this crate's types")
        });
        let argv = ssh_argv(&options).unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(argv, strings(&case, "argv"), "{name}");
        ran += 1;
    }
    assert!(ran > 0, "the corpus holds no accept cases");
}

#[test]
fn every_reject_case_is_refused_for_the_reason_the_corpus_names() {
    let mut ran = 0;
    let mut refused_by_type: Vec<String> = Vec::new();
    for case in cases() {
        if case["verdict"] != "reject" {
            continue;
        }
        let name = case["name"].as_str().expect("a name").to_owned();
        let reason = case["reason"]
            .as_str()
            .expect("a reject case names a field");

        let Some(options) = options_of(&case) else {
            assert!(
                REFUSED_BY_TYPE.contains(&name.as_str()),
                "{name}: this crate's types cannot express the case, so `ssh_argv` never sees it. \
                 Make it expressible, or name it in REFUSED_BY_TYPE saying which type refuses it."
            );
            refused_by_type.push(name);
            ran += 1;
            continue;
        };
        let error =
            ssh_argv(&options).expect_err(&format!("{name}: expected a refusal, got an argv"));
        assert_eq!(error.reason(), reason, "{name}: {error}");
        ran += 1;
    }
    assert!(ran > 0, "the corpus holds no reject cases");

    refused_by_type.sort();
    let mut expected: Vec<String> = REFUSED_BY_TYPE
        .iter()
        .map(|&name| name.to_owned())
        .collect();
    expected.sort();
    assert_eq!(
        refused_by_type, expected,
        "a case named in REFUSED_BY_TYPE is expressible now; run it rather than excluding it"
    );
}
