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

fn scratch_mango_home(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "mango-runtime-binary-test-{name}-{}-{}",
        std::process::id(),
        line!()
    ))
}

/// `connect` on a slot with no answer yet is the "invocation is consent"
/// case, so this exercises the *other* refusal path: a stored config the
/// binary itself cannot read at all.
#[test]
fn connect_prints_the_setup_pending_signature_on_an_unreadable_config() {
    let home = scratch_mango_home("connect-unreadable");
    let remote_dir = home.join("runtime").join("remote");
    std::fs::create_dir_all(&remote_dir).unwrap();
    std::fs::write(remote_dir.join("runtime.json"), b"{ not json").unwrap();

    let output = Command::new(binary_path())
        .args(["connect", "--hub", "wss://hub.example"])
        .env("MANGO_HOME", &home)
        .env("MANGOSTUDIO_RUNTIME_TOKEN", "irrelevant")
        .output()
        .expect("the binary runs");

    assert!(!output.status.success());
    let stderr = String::from_utf8(output.stderr).unwrap().to_lowercase();
    assert!(
        stderr.contains("runtime setup is pending on this machine"),
        "the hub's ssh-failure classifier greps stderr for this exact sentence: {stderr:?}"
    );
}

/// `serve` refuses a slot an installer explicitly armed to `pending`,
/// printing the same signature — never auto-granting the way a genuinely
/// unanswered slot does.
#[test]
fn serve_prints_the_setup_pending_signature_on_a_slot_armed_pending() {
    let home = scratch_mango_home("serve-armed-pending");
    let remote_dir = home.join("runtime").join("remote");
    std::fs::create_dir_all(&remote_dir).unwrap();
    std::fs::write(
        remote_dir.join("runtime.json"),
        br#"{"schemaVersion":1,"slot":"remote","setup":{"state":"pending","at":"2024-01-01T00:00:00.000Z","by":"install"}}"#,
    )
    .unwrap();

    let output = Command::new(binary_path())
        .args(["serve", "--listen", "0"])
        .env("MANGO_HOME", &home)
        .env("MANGOSTUDIO_RUNTIME_SERVE_TOKEN", "irrelevant")
        .output()
        .expect("the binary runs");

    assert!(!output.status.success());
    let stderr = String::from_utf8(output.stderr).unwrap().to_lowercase();
    assert!(
        stderr.contains("runtime setup is pending on this machine"),
        "{stderr:?}"
    );
}

/// `setup --profile` writes a real answer non-interactively and exits `0`.
#[test]
fn setup_writes_a_profile_and_exits_zero() {
    let home = scratch_mango_home("setup-writes");
    let output = Command::new(binary_path())
        .args(["setup", "--slot", "remote", "--profile", "readonly"])
        .env("MANGO_HOME", &home)
        .output()
        .expect("the binary runs");
    assert!(output.status.success());
    let written = std::fs::read_to_string(home.join("runtime").join("remote").join("runtime.json"))
        .expect("setup wrote runtime.json");
    assert!(written.contains("\"readonly\""));
}
