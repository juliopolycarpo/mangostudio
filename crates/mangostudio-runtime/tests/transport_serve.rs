//! End-to-end coverage for `transport::serve::run` over a real TCP socket:
//! bearer authentication, generation supersession, a clean shutdown that
//! drains the active connection before returning, and the
//! pending-handshake bound that keeps an unauthenticated flood from costing
//! this process a task and a file descriptor per connection.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
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

/// A monotonic counter plus the wall clock, not just `process::id()` and
/// `line!()`: two calls from the *same* line (a loop, a helper called twice
/// in one test) collide on the old scheme, and so does a reused pid across
/// separate `cargo test` invocations sharing a persistent `/tmp` — both
/// degrade a test to silently reusing another run's leftover directory
/// rather than failing loudly.
fn unique_suffix() -> u128 {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    nanos.wrapping_add(u128::from(count))
}

fn scratch_home(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "mango-transport-serve-test-{name}-{}-{}",
        std::process::id(),
        unique_suffix()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A named log fake that actually records what it was told, rather than a
/// closure that discards it — so a test can assert on the message a code
/// path produces, not just that some path or other ran.
#[derive(Clone, Default)]
struct CollectingLog {
    messages: Arc<Mutex<Vec<String>>>,
}

impl CollectingLog {
    fn new() -> Self {
        Self::default()
    }

    fn sink(&self) -> impl Fn(&str) + Send + Sync + 'static {
        let messages = Arc::clone(&self.messages);
        move |message: &str| messages.lock().unwrap().push(message.to_string())
    }

    fn messages(&self) -> Vec<String> {
        self.messages.lock().unwrap().clone()
    }
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
    let log = CollectingLog::new();
    let server = tokio::spawn(run(
        listener,
        TOKEN.to_string(),
        RuntimeSlot::Remote,
        home,
        "0.0.0".to_string(),
        cancel.clone(),
        log.sink(),
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
/// with `SUPERSEDED`, the second becomes the active one, and the transport
/// actually logs the supersession — not just "some log call happened".
#[tokio::test]
async fn a_second_dial_supersedes_the_first() {
    let (addr, listener) = bind_ephemeral().await;

    let cancel = CancellationToken::new();
    let home = scratch_home("supersede");
    let log = CollectingLog::new();
    let server = tokio::spawn(run(
        listener,
        TOKEN.to_string(),
        RuntimeSlot::Remote,
        home,
        "0.0.0".to_string(),
        cancel.clone(),
        log.sink(),
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
    assert!(
        log.messages()
            .iter()
            .any(|message| message.contains("superseded")),
        "expected a supersession log line, got {:?}",
        log.messages()
    );

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

/// Partial exhaustion must not become full lockout: with one
/// pending-handshake slot still free, an authenticated dial racing in
/// behind idle peers succeeds promptly — proving the bound counts *mid-
/// upgrade* peers, not "any peer that has ever connected".
#[tokio::test]
async fn idle_peers_with_a_slot_still_free_do_not_block_an_authorized_dial() {
    use tokio::io::AsyncWriteExt as _;

    let (addr, listener) = bind_ephemeral().await;
    let cancel = CancellationToken::new();
    let home = scratch_home("idle-peers-partial");
    let log = CollectingLog::new();
    let server = tokio::spawn(run(
        listener,
        TOKEN.to_string(),
        RuntimeSlot::Remote,
        home,
        "0.0.0".to_string(),
        cancel.clone(),
        log.sink(),
    ));

    // One fewer than `MAX_PENDING_HANDSHAKES`: connections that complete the
    // TCP handshake and then say nothing at all — never even an HTTP
    // request line, so `accept_websocket` never has a request to read and
    // never reaches `authorize`.
    let mut idle_peers = Vec::new();
    for _ in 0..3 {
        idle_peers.push(tokio::net::TcpStream::connect(addr).await.unwrap());
    }

    let session = tokio::time::timeout(Duration::from_secs(5), dial(addr, Some(TOKEN)))
        .await
        .expect("an authorized dial must not be blocked out while a slot is free")
        .expect("the correct token must still be accepted");
    assert_eq!(session.remote().unwrap().peer.role, "runtime");

    // Keep the idle sockets alive until here, so they were genuinely still
    // open (not already reset by the OS) while the dial above ran.
    for peer in &mut idle_peers {
        let _ = peer.write_all(b"").await;
    }
    drop(idle_peers);

    cancel.cancel();
    server.await.unwrap().unwrap();
}

/// The defect this test exists to close: a peer that opens the TCP
/// connection and never sends a byte must not lock the listener, leak a
/// task or a file descriptor, or hold a pending-handshake permit forever.
/// Every slot is exhausted here, so an authenticated hub racing in behind
/// them genuinely has to wait — but only until the idle peers' own
/// `UPGRADE_TIMEOUT` expires, never permanently, and `run` still shuts down
/// cleanly (no aborted task) afterwards. Slow by design (a little over
/// `UPGRADE_TIMEOUT`): this is the bounded-degradation guarantee itself,
/// not something a shorter proxy assertion can stand in for.
#[tokio::test]
async fn full_exhaustion_recovers_within_the_upgrade_timeout_not_forever() {
    let (addr, listener) = bind_ephemeral().await;
    let cancel = CancellationToken::new();
    let home = scratch_home("idle-peers-full");
    let server = tokio::spawn(run(
        listener,
        TOKEN.to_string(),
        RuntimeSlot::Remote,
        home,
        "0.0.0".to_string(),
        cancel.clone(),
        |_message| {},
    ));

    let idle_peers: Vec<_> = {
        let mut peers = Vec::new();
        for _ in 0..4 {
            peers.push(tokio::net::TcpStream::connect(addr).await.unwrap());
        }
        peers
    };

    // Every slot is held, so each individual dial is refused immediately
    // (a hard TCP drop at admission, per the fix — never a queued wait) for
    // as long as the idle peers hold their permits. A real hub's own
    // reconnect loop is exactly this: retry on a cadence. Before the fix,
    // no dial would ever have succeeded here, because nothing ever
    // recovered the idle peers' permits at all; the bound below (a little
    // over the real 10s `UPGRADE_TIMEOUT`) is slack for "eventually
    // recovers", not a timing of the constant itself.
    let recovered = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            if let Ok(session) = dial(addr, Some(TOKEN)).await {
                return session;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("a full pending-handshake bound must recover once idle peers time out, not lock out forever");
    assert_eq!(recovered.remote().unwrap().peer.role, "runtime");

    drop(idle_peers);
    cancel.cancel();
    server.await.unwrap().unwrap();
}

/// The other half of the same bound: once every pending-handshake slot is
/// genuinely held, a peer beyond it is refused *before* any task is
/// spawned — proven by a fast, synchronous close (immediate EOF, no bytes)
/// rather than the connection lingering for `UPGRADE_TIMEOUT`.
#[tokio::test]
async fn a_peer_past_the_pending_handshake_bound_is_dropped_before_spawning() {
    use tokio::io::AsyncReadExt as _;

    let (addr, listener) = bind_ephemeral().await;
    let cancel = CancellationToken::new();
    let home = scratch_home("pending-handshake-bound");
    let server = tokio::spawn(run(
        listener,
        TOKEN.to_string(),
        RuntimeSlot::Remote,
        home,
        "0.0.0".to_string(),
        cancel.clone(),
        |_message| {},
    ));

    // Exhaust every permit with idle connections, exactly as above.
    let mut idle_peers = Vec::new();
    for _ in 0..4 {
        idle_peers.push(tokio::net::TcpStream::connect(addr).await.unwrap());
    }

    // A peer past the bound must be dropped promptly — well under
    // `UPGRADE_TIMEOUT` — proving the accept loop refused it at admission
    // rather than accepting it into a task that later times out.
    let mut fifth = tokio::net::TcpStream::connect(addr).await.unwrap();
    let mut buffer = [0_u8; 16];
    let read = tokio::time::timeout(Duration::from_secs(2), fifth.read(&mut buffer))
        .await
        .expect("a peer past the bound must be refused quickly, not held for UPGRADE_TIMEOUT");
    assert_eq!(
        read.unwrap(),
        0,
        "expected an immediate EOF: the stream was dropped before any WebSocket upgrade began"
    );

    drop(idle_peers);
    cancel.cancel();
    server.await.unwrap().unwrap();
}

/// `GET /health` answers over the same listener a hub upgrades on, exactly
/// like `serve.ts` does — a plain HTTP request, not a WebSocket upgrade
/// attempt, must never fall into `accept_websocket` and come back as a
/// failed handshake.
#[tokio::test]
async fn get_health_answers_status_and_version_over_the_same_listener() {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    let (addr, listener) = bind_ephemeral().await;
    let cancel = CancellationToken::new();
    let home = scratch_home("health-check");
    let server = tokio::spawn(run(
        listener,
        TOKEN.to_string(),
        RuntimeSlot::Remote,
        home,
        "1.2.3".to_string(),
        cancel.clone(),
        |_message| {},
    ));

    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();

    let mut response = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut response))
        .await
        .expect("a health check must answer promptly, not hang like an unauthorised upgrade")
        .unwrap();
    let response = String::from_utf8(response).unwrap();

    assert!(
        response.starts_with("HTTP/1.1 200 OK"),
        "expected a 200 status line: {response:?}"
    );
    let body_start = response
        .find("\r\n\r\n")
        .expect("a response has a header/body separator")
        + 4;
    let body: serde_json::Value = serde_json::from_str(&response[body_start..]).unwrap();
    assert_eq!(body["status"], "ok");
    assert_eq!(body["version"], "1.2.3");

    cancel.cancel();
    server.await.unwrap().unwrap();
}
