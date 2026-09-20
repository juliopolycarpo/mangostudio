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

/// `serve` with no token anywhere — no `--token`, no
/// `MANGOSTUDIO_RUNTIME_SERVE_TOKEN`, nothing stored — generates one,
/// prints it exactly once, and persists it through the owner-only
/// credentials writer, mirroring `cli.ts`'s `resolveServeToken` falling
/// through to `bootstrapServeToken`.
#[test]
fn serve_with_no_token_anywhere_generates_one_prints_it_once_and_persists_it() {
    use std::io::{BufRead as _, BufReader};

    let home = scratch_mango_home("serve-bootstrap-token");
    let mut child = Command::new(binary_path())
        .args(["serve", "--listen", "0"])
        .env("MANGO_HOME", &home)
        .env_remove("MANGOSTUDIO_RUNTIME_SERVE_TOKEN")
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("the binary runs");

    let stderr = child.stderr.take().expect("stderr was piped");
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let found = line.contains("serve token (shown once):");
            let _ = sender.send(line);
            if found {
                break;
            }
        }
    });

    let mut printed_line = None;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while std::time::Instant::now() < deadline {
        match receiver.recv_timeout(std::time::Duration::from_millis(200)) {
            Ok(line) => {
                if line.contains("serve token (shown once):") {
                    printed_line = Some(line);
                    break;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();

    let printed_line = printed_line.expect("serve must print the generated token exactly once");
    let printed_token = printed_line
        .rsplit_once(": ")
        .map(|(_, token)| token.trim())
        .expect("the line names the token after a colon");

    let credentials =
        std::fs::read_to_string(home.join("runtime").join("remote").join("credentials.json"))
            .expect("bootstrap_serve_token must have written credentials.json");
    let stored: serde_json::Value = serde_json::from_str(&credentials).unwrap();
    assert_eq!(
        stored["serveToken"],
        serde_json::Value::String(printed_token.to_string()),
        "the printed token and the persisted one must be the same value"
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
