//! Exercises the real `mangostudio-runtime` binary as a subprocess:
//! `--version`/`--help`, `setup`, and the setup-pending and serve-token
//! bootstrap paths of `serve`/`connect`.

use std::process::Command;

mod support;

use support::scratch::scratch_path;

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

fn scratch_mango_home(name: &str) -> support::scratch::ScratchDir {
    scratch_path(&format!("runtime-binary-test-{name}"))
}

#[test]
fn setup_reports_when_it_replaces_an_unusable_runtime_config_without_printing_its_contents() {
    let home = scratch_mango_home("setup-replaced-config");
    let remote_dir = home.join("runtime").join("remote");
    std::fs::create_dir_all(&remote_dir).unwrap();
    let secret = "private-consent-marker";
    std::fs::write(remote_dir.join("runtime.json"), format!("{{ {secret}")).unwrap();

    let output = Command::new(binary_path())
        .args(["setup", "--slot", "remote", "--profile", "readonly"])
        .env("MANGO_HOME", &home)
        .output()
        .expect("the binary runs");

    assert!(output.status.success());
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.contains("replaced unusable") && stderr.contains("runtime.json"),
        "the replacement must be reported: {stderr:?}"
    );
    assert!(
        !stderr.contains(secret),
        "the old contents must stay private"
    );
}

#[test]
fn serve_and_connect_report_replaced_credentials_without_printing_stored_values() {
    use std::io::{BufRead as _, BufReader};

    for (name, args) in [
        ("serve", vec!["serve", "--listen", "0"]),
        ("connect", vec!["connect", "--hub", "ws://127.0.0.1:1/"]),
    ] {
        let home = scratch_mango_home(&format!("{name}-replaced-credentials"));
        let setup = Command::new(binary_path())
            .args(["setup", "--slot", "remote", "--profile", "readonly"])
            .env("MANGO_HOME", &home)
            .output()
            .unwrap();
        assert!(setup.status.success());

        let secret = "private-credential-marker";
        let credentials = home.join("runtime").join("remote").join("credentials.json");
        std::fs::write(
            &credentials,
            format!(
                r#"{{"schemaVersion":1,"slot":"remote","pairingToken":"{secret}","serveToken":42}}"#
            ),
        )
        .unwrap();

        let mut child = Command::new(binary_path())
            .args(args)
            .env("MANGO_HOME", &home)
            .env("MANGOSTUDIO_RUNTIME_TOKEN", "replacement-token")
            .env_remove("MANGOSTUDIO_RUNTIME_SERVE_TOKEN")
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("the binary runs");
        let stderr = child.stderr.take().unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if sender.send(line).is_err() {
                    break;
                }
            }
        });

        let mut lines = Vec::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while std::time::Instant::now() < deadline {
            match receiver.recv_timeout(std::time::Duration::from_millis(100)) {
                Ok(line) => {
                    let reported =
                        line.contains("replaced unusable") && line.contains("credentials.json");
                    lines.push(line);
                    if reported {
                        break;
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        let _ = child.kill();
        let _ = child.wait();
        assert!(
            lines.iter().any(|line| line.contains("replaced unusable") && line.contains("credentials.json")),
            "{name} must report the replacement: {lines:?}"
        );
        assert!(
            !lines.join("\n").contains(secret),
            "old credentials must stay private"
        );
    }
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

    // Collects *every* line for the whole window, rather than stopping at
    // the first match: a reader that stops as soon as it sees one
    // occurrence cannot tell "printed once" apart from "printed twice, and
    // we only looked at the first" — the earlier version of this test made
    // exactly that mistake.
    let stderr = child.stderr.take().expect("stderr was piped");
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if sender.send(line).is_err() {
                break;
            }
        }
    });

    let mut lines = Vec::new();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while std::time::Instant::now() < deadline {
        match receiver.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok(line) => lines.push(line),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();

    let token_lines: Vec<&String> = lines
        .iter()
        .filter(|line| line.contains("serve token (shown once):"))
        .collect();
    assert_eq!(
        token_lines.len(),
        1,
        "expected exactly one token line, got {token_lines:?} in {lines:?}"
    );
    let printed_token = token_lines[0]
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

/// `--token env`/`--token stdin` with nothing to read from that source must
/// refuse outright — never falling back to generating one (that fallback
/// is `EnvOrStored`-only) — and, just as importantly, must never have
/// written `credentials.json` or recorded invocation consent on the way to
/// refusing.
#[test]
fn an_empty_explicit_token_source_refuses_without_writing_credentials() {
    let home = scratch_mango_home("serve-empty-explicit-token-env");
    let output = Command::new(binary_path())
        .args(["serve", "--listen", "0", "--token", "env"])
        .env("MANGO_HOME", &home)
        .env_remove("MANGOSTUDIO_RUNTIME_SERVE_TOKEN")
        .output()
        .expect("the binary runs");
    assert!(!output.status.success());
    assert!(
        !home
            .join("runtime")
            .join("remote")
            .join("credentials.json")
            .exists(),
        "an explicit --token env that found nothing must never write a generated credential"
    );
    assert!(
        !home
            .join("runtime")
            .join("remote")
            .join("runtime.json")
            .exists(),
        "an explicit --token env that found nothing must refuse before recording consent"
    );

    let home = scratch_mango_home("serve-empty-explicit-token-stdin");
    let output = Command::new(binary_path())
        .args(["serve", "--listen", "0", "--token", "stdin"])
        .env("MANGO_HOME", &home)
        // A closed stdin (immediate EOF), not `Stdio::piped()` left
        // unwritten and unclosed: the latter would leave `read_line`
        // blocked forever waiting for input `output()` never sends,
        // deadlocking this test rather than exercising the empty-input
        // refusal.
        .stdin(std::process::Stdio::null())
        .output()
        .expect("the binary runs");
    assert!(!output.status.success());
    assert!(
        !home
            .join("runtime")
            .join("remote")
            .join("credentials.json")
            .exists(),
        "an explicit --token stdin that found nothing must never write a generated credential"
    );
    assert!(
        !home
            .join("runtime")
            .join("remote")
            .join("runtime.json")
            .exists(),
        "an explicit --token stdin that found nothing must refuse before recording consent"
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

/// A never-before-answered `remote` slot is the "invocation is consent"
/// case — but only once the invocation actually has something to grant
/// consent *for*. `connect` with no usable pairing token anywhere must
/// refuse over the missing token, not silently record a `full` grant on a
/// slot that, in the end, never connected to anything: token resolution
/// has to run before consent, not after, or a `pending` slot is
/// permanently converted by an invocation that failed regardless.
#[test]
fn connect_with_no_token_on_a_fresh_slot_refuses_without_recording_consent() {
    let home = scratch_mango_home("connect-no-token-fresh-slot");
    let output = Command::new(binary_path())
        .args(["connect", "--hub", "wss://hub.example"])
        .env("MANGO_HOME", &home)
        .env_remove("MANGOSTUDIO_RUNTIME_TOKEN")
        .stdin(std::process::Stdio::null())
        .output()
        .expect("the binary runs");

    assert!(!output.status.success());
    let stderr = String::from_utf8(output.stderr).unwrap().to_lowercase();
    assert!(
        stderr.contains("no pairing token"),
        "a missing token must be the refusal reason, not a consent gate that never ran: {stderr:?}"
    );
    assert!(
        !stderr.contains("runtime setup is pending on this machine"),
        "token resolution runs before consent now, so this refusal must never reach the \
         setup-pending message at all: {stderr:?}"
    );

    let runtime_json = home.join("runtime").join("remote").join("runtime.json");
    assert!(
        !runtime_json.exists(),
        "a token-less connect must never record a grant on a slot it failed to serve at all"
    );
}

/// A `connect` that actually has a token persists it through the same
/// owner-only credentials writer `serve`'s bootstrapped token uses, not
/// only the plaintext `hubUrl` — the write happens before the dial loop
/// ever starts, so this does not need a real hub to answer.
#[test]
fn connect_with_a_token_persists_it_before_dialling() {
    let home = scratch_mango_home("connect-persists-token");
    let mut child = Command::new(binary_path())
        .args(["connect", "--hub", "ws://127.0.0.1:1/"])
        .env("MANGO_HOME", &home)
        .env("MANGOSTUDIO_RUNTIME_TOKEN", "the-pairing-token")
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("the binary runs");

    let credentials = home.join("runtime").join("remote").join("credentials.json");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::time::Instant::now() < deadline && !credentials.exists() {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();

    let written = std::fs::read_to_string(&credentials)
        .expect("connect must persist the pairing token before it ever dials");
    let stored: serde_json::Value = serde_json::from_str(&written).unwrap();
    assert_eq!(stored["pairingToken"], "the-pairing-token");
}

/// A fresh slot's invocation-is-consent grant reports a command the
/// operator can actually run: this crate's own `setup` takes no
/// interactive input, so a bare `mangostudio-runtime setup` (what `cli.ts`
/// can get away with, since it prompts) only ever answers "setup needs
/// --profile full|readonly|none" — a dead end reintroduced here minutes
/// after being removed from `setup_pending_message`.
#[test]
fn connect_on_a_fresh_slot_reports_a_setup_command_that_actually_works() {
    use std::io::{BufRead as _, BufReader};

    let home = scratch_mango_home("connect-recorded-grant-message");
    let mut child = Command::new(binary_path())
        .args(["connect", "--hub", "ws://127.0.0.1:1/"])
        .env("MANGO_HOME", &home)
        .env("MANGOSTUDIO_RUNTIME_TOKEN", "irrelevant-token")
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("the binary runs");

    let stderr = child.stderr.take().expect("stderr was piped");
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if sender.send(line).is_err() {
                break;
            }
        }
    });

    let mut lines = Vec::new();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while std::time::Instant::now() < deadline {
        match receiver.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok(line) => {
                let found_it = line.contains("recorded full permissions");
                lines.push(line);
                if found_it {
                    break;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();

    let recorded_line = lines
        .iter()
        .find(|line| line.contains("recorded full permissions"))
        .unwrap_or_else(|| panic!("a fresh slot must report the recorded grant: {lines:?}"));
    assert!(
        recorded_line.contains("--profile"),
        "the reported command must name --profile, or it is the same dead end \
         setup_pending_message was fixed for: {recorded_line:?}"
    );
}
