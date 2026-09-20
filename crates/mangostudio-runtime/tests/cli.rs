//! Exercises the real `mangostudio-runtime` binary as a subprocess:
//! `--version`/`--help`, `setup`, and the setup-pending and serve-token
//! bootstrap paths of `serve`/`connect`.

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

/// A monotonic counter plus the wall clock, not just `process::id()` and
/// `line!()`: a reused pid across separate `cargo test` invocations sharing
/// a persistent `/tmp` degrades a test to silently reusing another run's
/// leftover directory rather than failing loudly.
fn unique_suffix() -> u128 {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let count = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    nanos.wrapping_add(u128::from(count))
}

fn scratch_mango_home(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "mango-runtime-binary-test-{name}-{}-{}",
        std::process::id(),
        unique_suffix()
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
/// written `credentials.json` on the way to refusing.
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
