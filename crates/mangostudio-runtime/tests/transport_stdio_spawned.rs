//! Spawns the real `mangostudio-runtime stdio` binary as an OS child and
//! completes a handshake over its actual stdin/stdout pipes — the one thing
//! an in-process `NdjsonPort` test cannot prove: that stdout carries
//! protocol frames and nothing else, end to end through a real process.

use std::time::Duration;

use mango_protocol::close::close_codes;
use mango_protocol::frame::PeerInfo;
use mango_protocol::session::{Session, SessionOptions};
use mango_protocol::transports::spawn::{SpawnOptions, sanitized_env, spawn_port};

fn binary_path() -> String {
    env!("CARGO_BIN_EXE_mangostudio-runtime").to_string()
}

fn scratch_home(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "mango-transport-stdio-spawn-test-{name}-{}-{}",
        std::process::id(),
        line!()
    ))
}

fn hub_peer() -> PeerInfo {
    PeerInfo {
        name: "test-hub".into(),
        version: "0.0.0".into(),
        role: "hub".into(),
    }
}

/// A fresh `MANGO_HOME` with nothing in it at all resolves to the `host`
/// slot (the binary is not under any `<mango_home>/runtime/<slot>` tree),
/// which starts pre-consented — so the child completes its handshake with
/// no `setup` step required first.
#[tokio::test]
async fn a_spawned_stdio_child_completes_the_handshake_over_real_pipes() {
    let home = scratch_home("handshake");
    let env = sanitized_env([(
        "MANGO_HOME".to_string(),
        home.to_string_lossy().into_owned(),
    )]);
    let options = SpawnOptions::new([binary_path(), "stdio".to_string()]).with_env(env);
    let (port, launched) = spawn_port(options).expect("the argv names a real binary");

    let (session, driver) = Session::spawn(port, SessionOptions::new(hub_peer()));
    let remote = tokio::time::timeout(Duration::from_secs(10), session.ready())
        .await
        .expect("the child must say hello within the timeout")
        .expect("the handshake succeeds");
    assert_eq!(remote.peer.name, "mangostudio-runtime");
    assert_eq!(remote.peer.role, "runtime");
    assert!(launched.pid().is_some());

    // Release cleanly: the hub side closes, the child exits 0 (see the
    // stdio consent tests in `tests/cli.rs` for the refusal path).
    session
        .close(close_codes::RELEASED, Some("test done"))
        .await;
    let _ = driver.await;
}
