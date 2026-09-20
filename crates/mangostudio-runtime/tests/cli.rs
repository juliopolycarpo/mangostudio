//! Exercises the thin `mangostudio-runtime` binary as a subprocess: only
//! `--version` and `--help` exist yet, real argument parsing is a later
//! change.

use std::process::Command;

fn binary_path() -> &'static str {
    env!("CARGO_BIN_EXE_mangostudio-runtime")
}

#[test]
fn version_flag_prints_the_crate_version_and_exits_zero() {
    let output = Command::new(binary_path())
        .arg("--version")
        .output()
        .expect("the binary runs");
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).expect("utf8 stdout");
    assert_eq!(
        stdout.trim(),
        format!("mangostudio-runtime {}", env!("CARGO_PKG_VERSION"))
    );
}

#[test]
fn help_flag_prints_usage_and_exits_zero() {
    let output = Command::new(binary_path())
        .arg("--help")
        .output()
        .expect("the binary runs");
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).expect("utf8 stdout");
    assert!(stdout.contains("Usage: mangostudio-runtime"));
}

#[test]
fn no_arguments_prints_usage_and_exits_zero() {
    let output = Command::new(binary_path())
        .output()
        .expect("the binary runs");
    assert!(output.status.success());
}

#[test]
fn an_unrecognised_argument_exits_non_zero() {
    let output = Command::new(binary_path())
        .arg("--not-a-real-flag")
        .output()
        .expect("the binary runs");
    assert!(!output.status.success());
}
