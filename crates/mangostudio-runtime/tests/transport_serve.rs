//! End-to-end coverage for `transport::serve::run` over a real TCP socket:
//! bearer authentication, generation supersession, and a clean shutdown
//! that drains the active connection before returning.

use std::net::SocketAddr;
use std::time::Duration;

use mango_protocol::close::close_codes;
use mango_protocol::frame::PeerInfo;
use mango_protocol::session::{Session, SessionOptions, SessionState};
use mango_protocol::transports::deadline::ConnectDeadline;
use mango_protocol::transports::websocket::client::{WebSocketConnectOptions, connect_websocket};
use mangostudio_runtime::runtime_home::RuntimeSlot;
use mangostudio_runtime::transport::serve::run;
use tokio_util::sync::CancellationToken;

const TOKEN: &str = "test-serve-token";

fn hub_peer() -> PeerInfo {
    PeerInfo {
        name: "test-hub".into(),
        version: "0.0.0".into(),
        role: "hub".into(),
    }
}

async fn bind_ephemeral() -> (SocketAddr, tokio::net::TcpListener) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    (addr, listener)
}

fn scratch_home(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "mango-transport-serve-test-{name}-{}-{}",
        std::process::id(),
        line!()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

async fn dial(addr: SocketAddr, bearer: Option<&str>) -> Result<Session, u16> {
    let url = format!("ws://{addr}/");
    let mut options = WebSocketConnectOptions::default();
    if let Some(token) = bearer {
        options = options.with_bearer(token);
    }
    let deadline = ConnectDeadline::default().with_timeout(Duration::from_secs(5));
    match connect_websocket(&url, &options, &deadline).await {
        Ok(port) => {
            let (session, _driver) = Session::spawn(port, SessionOptions::new(hub_peer()));
            match session.ready().await {
                Ok(_) => Ok(session),
                Err(_) => {
                    let closure = session.closed().await;
                    Err(closure.code)
                }
            }
        }
        Err(_) => Err(0),
    }
}

/// A wrong bearer token is refused before any `hello` is sent, and refusing
/// it does not damage the listener: a subsequent, correctly authenticated
/// dial still succeeds.
#[tokio::test]
async fn a_bad_credential_is_refused_without_damaging_a_later_authorized_dial() {
    let (addr, listener) = bind_ephemeral().await;

    let cancel = CancellationToken::new();
    let home = scratch_home("bad-credential");
    let server = tokio::spawn(run(
        listener,
        TOKEN.to_string(),
        RuntimeSlot::Remote,
        home,
        "0.0.0".to_string(),
        cancel.clone(),
        |_message| {},
    ));

    let refused = dial(addr, Some("wrong-token")).await;
    assert!(refused.is_err(), "a wrong bearer token must be refused");

    let session = dial(addr, Some(TOKEN))
        .await
        .expect("the correct token must still be accepted afterwards");
    assert_eq!(session.remote().unwrap().peer.role, "runtime");

    cancel.cancel();
    server.await.unwrap().unwrap();
}

/// A second authorized dial supersedes the first: the first session closes
/// with `SUPERSEDED`, and the second becomes the active one.
#[tokio::test]
async fn a_second_dial_supersedes_the_first() {
    let (addr, listener) = bind_ephemeral().await;

    let cancel = CancellationToken::new();
    let home = scratch_home("supersede");
    let server = tokio::spawn(run(
        listener,
        TOKEN.to_string(),
        RuntimeSlot::Remote,
        home,
        "0.0.0".to_string(),
        cancel.clone(),
        |_message| {},
    ));

    let first = dial(addr, Some(TOKEN)).await.expect("first dial succeeds");
    let second = dial(addr, Some(TOKEN)).await.expect("second dial succeeds");

    let first_closure = first.closed().await;
    assert_eq!(
        first_closure.code,
        close_codes::SUPERSEDED,
        "the first session must close as superseded, not merely disconnect"
    );
    assert_eq!(second.state(), SessionState::Ready);

    cancel.cancel();
    server.await.unwrap().unwrap();
}

/// Cancelling the token drains the active connection (closing it with
/// `RELEASED`) before `run` returns — a caller awaiting `run`'s handle never
/// observes it finish while a session is still open.
#[tokio::test]
async fn cancellation_releases_the_active_connection_before_run_returns() {
    let (addr, listener) = bind_ephemeral().await;

    let cancel = CancellationToken::new();
    let home = scratch_home("shutdown-drains");
    let server = tokio::spawn(run(
        listener,
        TOKEN.to_string(),
        RuntimeSlot::Remote,
        home,
        "0.0.0".to_string(),
        cancel.clone(),
        |_message| {},
    ));

    let session = dial(addr, Some(TOKEN)).await.expect("dial succeeds");

    cancel.cancel();
    // `run` itself must complete: if the active connection were never
    // released, `owned.join_all_or_abort` would have to wait out its whole
    // grace period, or `run` would never observe an idle task set at all.
    tokio::time::timeout(Duration::from_secs(2), server)
        .await
        .expect("run must return promptly once cancelled")
        .unwrap()
        .unwrap();

    let closure = session.closed().await;
    assert_eq!(closure.code, close_codes::RELEASED);
}
