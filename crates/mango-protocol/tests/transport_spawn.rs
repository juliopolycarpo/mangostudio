//! The spawn launcher against a real child: the `conformance_peer` example,
//! speaking stdio through the pipes this launcher wired up.
//!
//! The conformance suite cannot run here — it drives both sessions, and one of
//! a launcher's two sessions lives in another process — so these are the
//! launcher's own guarantees: the pipes carry a session, the termination
//! sequence starts at the end of stdin, and a child that ignores that is
//! escalated past it.
#![cfg(all(feature = "spawn", feature = "testing", feature = "websocket"))]

use std::path::PathBuf;
use std::time::Duration;

use mango_protocol::close::close_codes;
use mango_protocol::session::Session;
use mango_protocol::testing::{conformance_a, conformance_options};
use mango_protocol::transports::spawn::{SpawnOptions, spawn_port};
use serde_json::json;

/// Where `cargo test --all-targets` leaves the example binary: beside the
/// test binary's own directory, one level up.
fn peer_binary() -> Option<PathBuf> {
    let test_binary = std::env::current_exe().ok()?;
    let target = test_binary.parent()?.parent()?;
    let name = if cfg!(windows) {
        "conformance_peer.exe"
    } else {
        "conformance_peer"
    };
    let path = target.join("examples").join(name);
    path.is_file().then_some(path)
}

/// Skips, rather than fails, when the example has not been built — the same
/// reasoning as `conformance_drift.rs`, so a run that did not ask for every
/// target still succeeds.
macro_rules! peer_or_skip {
    () => {
        match peer_binary() {
            Some(path) => path,
            None => {
                eprintln!(
                    "skipping: build the example first (cargo build --example conformance_peer \
                     --features testing,websocket,spawn)"
                );
                return;
            }
        }
    };
}

#[tokio::test]
async fn a_launched_child_completes_the_handshake_and_answers_over_its_pipes() {
    let peer = peer_or_skip!();
    let (port, launched) = spawn_port(SpawnOptions::new([
        peer.to_string_lossy().into_owned(),
        "--stdio".to_owned(),
    ]))
    .expect("the argv names a command");

    let (session, driver) = Session::spawn(port, conformance_options(conformance_a()));
    let remote = session.ready().await.expect("the child says hello");
    assert_eq!(remote.peer.name, "conformance-b");
    assert!(launched.pid().is_some(), "the child is a real process");

    let echoed = session
        .request("test.echo", json!({ "over": "pipes" }))
        .await
        .expect("the child answers");
    assert_eq!(echoed, json!({ "over": "pipes" }));

    // Step 1 of the termination sequence is the end of the child's stdin, and
    // closing the session is what performs it. A conforming peer leaves on
    // that alone, so the status carries no signal.
    session.close(close_codes::RELEASED, Some("done")).await;
    let _ = driver.await;

    let status = tokio::time::timeout(Duration::from_secs(10), launched.terminate())
        .await
        .expect("the child leaves on the end of its stdin")
        .expect("the exit grace did not run out on a child that already left");
    assert_eq!(status.signal, None, "no signal was needed: {status}");
    assert_eq!(status.code, Some(0), "{status}");
}

#[tokio::test]
async fn a_child_that_ignores_the_end_of_its_stdin_is_escalated_past_it() {
    let peer = peer_or_skip!();
    let options = SpawnOptions::new([
        peer.to_string_lossy().into_owned(),
        "--stdio".to_owned(),
        "--ignore-stdin".to_owned(),
    ]);
    let (port, launched) = spawn_port(SpawnOptions {
        // Short graces: this child never leaves on its own, so the test is
        // only waiting for the launcher to stop being polite.
        terminate_grace: Duration::from_millis(200),
        kill_grace: Duration::from_millis(200),
        ..options
    })
    .expect("the argv names a command");

    // Nothing will ever answer, so the port is closed without a handshake.
    let (session, driver) = Session::spawn(port, conformance_options(conformance_a()));
    session.close_now(close_codes::RELEASED, None);
    let _ = driver.await;

    let status = tokio::time::timeout(Duration::from_secs(10), launched.terminate())
        .await
        .expect("the launcher escalates rather than waiting for ever")
        .expect("SIGKILL reaches this child inside the default exit grace");

    if cfg!(unix) {
        // SIGTERM: the step the end of file did not achieve.
        assert_eq!(status.signal, Some(15), "{status}");
    } else {
        // Windows has no signals; both steps collapse into terminating it.
        assert!(status.code.is_some(), "{status}");
    }
}

#[tokio::test]
async fn a_command_that_does_not_exist_names_what_the_launcher_observed() {
    let (port, launched) = spawn_port(SpawnOptions::new([
        "mango-no-such-command-exists-anywhere",
        "--stdio",
    ]))
    .expect("the argv names a command, even one nothing answers to");

    let (session, driver) = Session::spawn(port, conformance_options(conformance_a()));
    let refusal = session
        .ready()
        .await
        .expect_err("a child that never started never says hello");
    assert_eq!(refusal.code, "UNAVAILABLE");
    let _ = driver.await;

    let why = launched.start_error(Some(Duration::from_millis(250))).await;
    assert_eq!(why.spawn_error, Some(std::io::ErrorKind::NotFound));
    assert!(launched.pid().is_none());
    assert!(!why.stderr_line.is_empty(), "the launcher says what it saw");
}
