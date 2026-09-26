//! End-to-end coverage for `transport::serve::run` over a real TCP socket:
//! bearer authentication, generation supersession, a clean shutdown that
//! drains the active connection before returning, and the
//! pending-handshake bound that keeps an unauthenticated flood from costing
//! this process a task and a file descriptor per connection.

use std::net::SocketAddr;
use std::time::Duration;

use mango_protocol::close::close_codes;
use mango_protocol::session::{Session, SessionOptions, SessionState};
use mango_protocol::transports::deadline::ConnectDeadline;
use mango_protocol::transports::websocket::client::{WebSocketConnectOptions, connect_websocket};
use mangostudio_runtime::runtime_home::RuntimeSlot;
use mangostudio_runtime::transport::serve::run;
use mangostudio_runtime_contract::strings::binding;
use tokio_util::sync::CancellationToken;

mod support;

use support::CollectingLog;
use support::scratch::{ScratchDir, scratch_dir};

const TOKEN: &str = "test-serve-token";

/// Bounds a wait so a regression that hangs still ends the run. Never the
/// thing a test asserts on: every wait below is for an event (a log line, a
/// close, an EOF), and this is only how long a broken build may take to
/// show it, generous enough that a loaded Windows runner cannot reach it.
const HANG_GUARD: Duration = Duration::from_secs(60);

/// Awaits `future` under [`HANG_GUARD`], naming `what` if it hangs.
async fn until<T>(what: &str, future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(HANG_GUARD, future)
        .await
        .unwrap_or_else(|_| panic!("expected {what} within {HANG_GUARD:?} | received: a hang"))
}

/// Asserts every idle peer is still open — no EOF, no reset, nothing to
/// read — so each still holds the pending-handshake permit it took at
/// accept. `when` names the moment being checked.
fn assert_idle_peers_still_open(idle_peers: &[tokio::net::TcpStream], when: &str) {
    for (index, peer) in idle_peers.iter().enumerate() {
        let mut probe = [0_u8; 1];
        let state = peer.try_read(&mut probe);
        assert!(
            matches!(&state, Err(error) if error.kind() == std::io::ErrorKind::WouldBlock),
            "expected idle peer {index} still open, holding its permit, {when} | received: \
             {state:?}"
        );
    }
}

/// Two well-formed binding keys: 64 lowercase hex characters each.
const RECORD_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RECORD_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

async fn bind_ephemeral() -> (SocketAddr, tokio::net::TcpListener) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    (addr, listener)
}

fn scratch_home(name: &str) -> ScratchDir {
    scratch_dir(&format!("transport-serve-test-{name}"))
}

async fn dial(addr: SocketAddr, bearer: Option<&str>) -> Result<Session, u16> {
    dial_bound(addr, bearer, None).await
}

/// Dials as a hub sending `binding_key` (or none, like an older hub) in the
/// binding header of its upgrade request.
async fn dial_bound(
    addr: SocketAddr,
    bearer: Option<&str>,
    binding_key: Option<&str>,
) -> Result<Session, u16> {
    let url = format!("ws://{addr}/");
    let mut options = WebSocketConnectOptions::default();
    if let Some(token) = bearer {
        options = options.with_bearer(token);
    }
    if let Some(key) = binding_key {
        options = options.with_header(binding::HEADER, key);
    }
    let deadline = ConnectDeadline::default().with_timeout(HANG_GUARD);
    match connect_websocket(&url, &options, &deadline).await {
        Ok(port) => {
            let (session, _driver) =
                Session::spawn(port, SessionOptions::new(support::peer("hub")));
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
        home.to_path_buf(),
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
        home.to_path_buf(),
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
        "the first session must close as superseded, not merely disconnect | received code {} \
         with reason {:?}",
        first_closure.code,
        first_closure.reason
    );
    assert_eq!(second.state(), SessionState::Ready);
    // Already logged: the runtime logs the supersession before it starts the
    // second session, and the second dial returned only once that session
    // was ready.
    assert!(
        log.messages()
            .iter()
            .any(|message| message.contains("superseded")),
        "expected a supersession log line | received: {:?}",
        log.messages()
    );

    cancel.cancel();
    server.await.unwrap().unwrap();
}

fn spawn_serve(
    listener: tokio::net::TcpListener,
    name: &str,
    cancel: &CancellationToken,
    log: &CollectingLog,
) -> (ScratchDir, tokio::task::JoinHandle<std::io::Result<()>>) {
    let home = scratch_home(name);
    let server = tokio::spawn(run(
        listener,
        TOKEN.to_string(),
        RuntimeSlot::Remote,
        home.to_path_buf(),
        "0.0.0".to_string(),
        cancel.clone(),
        log.sink(),
    ));
    (home, server)
}

fn count_logged(log: &CollectingLog, needle: &str) -> usize {
    log.messages()
        .iter()
        .filter(|message| message.contains(needle))
        .count()
}

/// Waits for the runtime to log `needle` — its own signal that a
/// connection task reached that point.
async fn logged(log: &CollectingLog, needle: &str) {
    until(
        &format!("a log line containing {needle:?}"),
        log.wait_for(needle),
    )
    .await;
}

/// A live connection bound to one environment record refuses a dial for a
/// different record with the already-bound close code, and is itself left
/// alone: it still answers a request afterwards and was never superseded.
#[tokio::test]
async fn a_dial_for_another_binding_is_refused_and_the_incumbent_keeps_answering() {
    let (addr, listener) = bind_ephemeral().await;
    let cancel = CancellationToken::new();
    let log = CollectingLog::new();
    let (_home, server) = spawn_serve(listener, "binding-refused", &cancel, &log);

    let first = dial_bound(addr, Some(TOKEN), Some(RECORD_A))
        .await
        .expect("the first record's dial succeeds");
    let refused = dial_bound(addr, Some(TOKEN), Some(RECORD_B)).await;
    assert_eq!(
        refused.as_ref().err().copied(),
        Some(binding::ALREADY_BOUND_CLOSE_CODE),
        "expected the second record refused with {} | received: {}",
        binding::ALREADY_BOUND_CLOSE_CODE,
        match &refused {
            Ok(_) => "an admitted session".to_owned(),
            Err(code) => format!("close code {code}"),
        }
    );

    let health = first
        .request("runtime.health", serde_json::json!({}))
        .await
        .expect("the incumbent still answers after the refusal");
    assert!(
        health.get("runtimeVersion").is_some(),
        "expected a runtime.health result | received: {health}"
    );
    assert_eq!(first.state(), SessionState::Ready);
    assert_eq!(count_logged(&log, "already bound"), 1);
    assert_eq!(count_logged(&log, "superseded"), 0);

    cancel.cancel();
    server.await.unwrap().unwrap();
}

/// The same record reconnecting — its old socket not yet noticed dead —
/// supersedes the old connection exactly as before binding keys.
#[tokio::test]
async fn a_dial_for_the_same_binding_supersedes_the_incumbent() {
    let (addr, listener) = bind_ephemeral().await;
    let cancel = CancellationToken::new();
    let log = CollectingLog::new();
    let (_home, server) = spawn_serve(listener, "binding-same", &cancel, &log);

    let first = dial_bound(addr, Some(TOKEN), Some(RECORD_A))
        .await
        .expect("first dial succeeds");
    let second = dial_bound(addr, Some(TOKEN), Some(RECORD_A))
        .await
        .expect("the same record's reconnect is admitted");

    assert_eq!(first.closed().await.code, close_codes::SUPERSEDED);
    assert_eq!(second.state(), SessionState::Ready);

    cancel.cancel();
    server.await.unwrap().unwrap();
}

/// A hub that announces no binding key (built before binding keys) still
/// supersedes a bound incumbent: either side lacking a key keeps the old
/// behaviour.
#[tokio::test]
async fn a_dial_without_a_binding_supersedes_a_bound_incumbent() {
    let (addr, listener) = bind_ephemeral().await;
    let cancel = CancellationToken::new();
    let log = CollectingLog::new();
    let (_home, server) = spawn_serve(listener, "binding-legacy", &cancel, &log);

    let first = dial_bound(addr, Some(TOKEN), Some(RECORD_A))
        .await
        .expect("first dial succeeds");
    let second = dial_bound(addr, Some(TOKEN), None)
        .await
        .expect("a keyless dial is admitted");

    assert_eq!(first.closed().await.code, close_codes::SUPERSEDED);
    assert_eq!(second.state(), SessionState::Ready);

    cancel.cancel();
    server.await.unwrap().unwrap();
}

/// Once the incumbent's hub has gone away and the runtime has let go of it,
/// a dial for another record is admitted — the refusal only protects a live
/// connection.
#[tokio::test]
async fn a_dial_for_another_binding_succeeds_once_the_incumbent_is_gone() {
    let (addr, listener) = bind_ephemeral().await;
    let cancel = CancellationToken::new();
    let log = CollectingLog::new();
    let (_home, server) = spawn_serve(listener, "binding-released", &cancel, &log);

    let first = dial_bound(addr, Some(TOKEN), Some(RECORD_A))
        .await
        .expect("first dial succeeds");
    first.close(close_codes::RELEASED, Some("done")).await;
    logged(&log, "Hub connection ended.").await;

    let second = dial_bound(addr, Some(TOKEN), Some(RECORD_B))
        .await
        .expect("another record is admitted once the incumbent is gone");
    assert_eq!(second.state(), SessionState::Ready);
    assert_eq!(count_logged(&log, "already bound"), 0);

    cancel.cancel();
    server.await.unwrap().unwrap();
}

/// A binding header that is present but not a key is refused, not read as
/// "no key" — and the refusal leaves a live incumbent alone.
#[tokio::test]
async fn a_malformed_binding_is_refused_without_superseding_the_incumbent() {
    let (addr, listener) = bind_ephemeral().await;
    let cancel = CancellationToken::new();
    let log = CollectingLog::new();
    let (_home, server) = spawn_serve(listener, "binding-malformed", &cancel, &log);

    let first = dial_bound(addr, Some(TOKEN), Some(RECORD_A))
        .await
        .expect("first dial succeeds");
    let refused = dial_bound(addr, Some(TOKEN), Some("NOT-A-KEY")).await;
    assert_eq!(
        refused.as_ref().err().copied(),
        Some(close_codes::PROTOCOL_ERROR),
        "expected a malformed binding refused with {} | received: {}",
        close_codes::PROTOCOL_ERROR,
        match &refused {
            Ok(_) => "an admitted session".to_owned(),
            Err(code) => format!("close code {code}"),
        }
    );
    assert_eq!(first.state(), SessionState::Ready);
    assert_eq!(count_logged(&log, "must be 64 lowercase hex characters"), 1);
    assert_eq!(count_logged(&log, "superseded"), 0);

    cancel.cancel();
    server.await.unwrap().unwrap();
}

/// An unauthenticated dialler learns nothing about the binding: against a
/// runtime bound to one record, a wrong bearer with another record's key or
/// with a malformed key is refused with exactly `UNAUTHORIZED`, never the
/// already-bound or malformed-binding code — and the incumbent stays.
#[tokio::test]
async fn a_wrong_bearer_is_refused_as_unauthorized_whatever_binding_it_sends() {
    let (addr, listener) = bind_ephemeral().await;
    let cancel = CancellationToken::new();
    let log = CollectingLog::new();
    let (_home, server) = spawn_serve(listener, "binding-unauthorized", &cancel, &log);

    let first = dial_bound(addr, Some(TOKEN), Some(RECORD_A))
        .await
        .expect("first dial succeeds");
    for (label, key) in [
        ("another record's key", RECORD_B),
        ("a malformed key", "NOT-A-KEY"),
    ] {
        let refused = dial_bound(addr, Some("wrong-token"), Some(key)).await;
        assert_eq!(
            refused.as_ref().err().copied(),
            Some(close_codes::UNAUTHORIZED),
            "expected a wrong bearer with {label} refused with exactly {} | received: {}",
            close_codes::UNAUTHORIZED,
            match &refused {
                Ok(_) => "an admitted session".to_owned(),
                Err(code) => format!("close code {code}"),
            }
        );
    }
    assert_eq!(first.state(), SessionState::Ready);
    assert_eq!(count_logged(&log, "Refused a hub connection"), 0);

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
    let log = CollectingLog::new();
    let server = tokio::spawn(run(
        listener,
        TOKEN.to_string(),
        RuntimeSlot::Remote,
        home.to_path_buf(),
        "0.0.0".to_string(),
        cancel.clone(),
        log.sink(),
    ));

    let session = dial(addr, Some(TOKEN)).await.expect("dial succeeds");

    cancel.cancel();
    // `run` itself must complete, and by releasing the connection rather
    // than outwaiting it: had the active connection never been released,
    // `owned.join_all_or_abort` would have waited out its whole grace period
    // and then aborted the task, which `run` logs. So the proof is that log
    // line's absence once `run` returns, not how long `run` took.
    until("run to return once cancelled", server)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        count_logged(&log, "outlived the shutdown grace"),
        0,
        "expected the connection released, not aborted after the grace | received: {:?}",
        log.messages()
    );

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
        home.to_path_buf(),
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

    let session = until(
        "an authorized dial while a slot is free",
        dial(addr, Some(TOKEN)),
    )
    .await
    .expect("the correct token must still be accepted");
    assert_eq!(session.remote().unwrap().peer.role, "runtime");

    // The dial got through *while* the idle peers held their slots, not
    // after their `UPGRADE_TIMEOUT` freed them: they are all still open. That
    // ordering, not a speed, is what shows the bound counts mid-upgrade peers
    // only.
    assert_idle_peers_still_open(&idle_peers, "after the authorized dial succeeded");
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
        home.to_path_buf(),
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
    // recovered the idle peers' permits at all. The hang guard is what
    // "not forever" means here; the idle peers' own end of stream below is
    // what shows the recovery came from their `UPGRADE_TIMEOUT`.
    let recovered = until("a dial to succeed once the idle peers time out", async {
        loop {
            if let Ok(session) = dial(addr, Some(TOKEN)).await {
                return session;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await;
    assert_eq!(recovered.remote().unwrap().peer.role, "runtime");
    // Recovery came from the runtime dropping the idle peers at their own
    // `UPGRADE_TIMEOUT`, which freed their permits: each one reads the end
    // of its stream.
    for (index, mut peer) in idle_peers.into_iter().enumerate() {
        use tokio::io::AsyncReadExt as _;
        let mut probe = [0_u8; 1];
        let read = until("an idle peer's end of stream", peer.read(&mut probe)).await;
        assert!(
            matches!(&read, Ok(0))
                || matches!(&read, Err(error) if matches!(
                    error.kind(),
                    std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
                )),
            "expected idle peer {index} dropped by the runtime | received: {read:?}"
        );
    }

    cancel.cancel();
    server.await.unwrap().unwrap();
}

/// The other half of the same bound: once every pending-handshake slot is
/// genuinely held, a peer beyond it is refused *before* any task is
/// spawned — proven by it being dropped (no bytes) while every idle peer
/// still holds its slot, rather than lingering for `UPGRADE_TIMEOUT`.
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
        home.to_path_buf(),
        "0.0.0".to_string(),
        cancel.clone(),
        |_message| {},
    ));

    // Exhaust every permit with idle connections, exactly as above.
    let mut idle_peers = Vec::new();
    for _ in 0..4 {
        idle_peers.push(tokio::net::TcpStream::connect(addr).await.unwrap());
    }

    // A peer past the bound is dropped at admission, which is an ordering,
    // not a speed: the accept loop takes the backlog in order, so the four
    // idle peers each hold a permit before the fifth is accepted, and they
    // keep it until their own `UPGRADE_TIMEOUT`. So the fifth must end while
    // every idle peer is still open. Had it been spawned into a task instead,
    // it could only end at its own `UPGRADE_TIMEOUT`, after the idle peers'
    // (accepted earlier) had already dropped them. No wall-clock threshold
    // decides this; the bound below only keeps a broken build from hanging.
    let mut fifth = tokio::net::TcpStream::connect(addr).await.unwrap();
    let mut buffer = [0_u8; 16];
    let read = until("the fifth peer to be dropped", fifth.read(&mut buffer)).await;
    // Dropped without a byte either way: a clean EOF, or a reset where the
    // platform aborts a connection it never read from.
    assert!(
        matches!(&read, Ok(0))
            || matches!(&read, Err(error) if matches!(
                error.kind(),
                std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
            )),
        "expected the fifth peer dropped without any bytes (EOF or reset) | received: {read:?}"
    );
    assert_idle_peers_still_open(
        &idle_peers,
        "when the fifth was dropped, proving the fifth never reached a task",
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
        home.to_path_buf(),
        "1.2.3".to_string(),
        cancel.clone(),
        |_message| {},
    ));

    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();

    // Assert on the bytes that actually arrived, not on `read_to_end`
    // itself reporting a clean `Ok`: `read_to_end` still appends whatever
    // it read before an error, and a platform that closes with unread
    // data still pending answers with an RST instead of a FIN, which
    // `read_to_end` on the client surfaces as `ConnectionReset` even
    // though the bytes we care about already arrived. What must hold is
    // that the response was received; how the connection ended afterwards
    // is the server-side fix above, not this test's assertion.
    let mut response = Vec::new();
    let read_to_end = until(
        "the health response to end",
        stream.read_to_end(&mut response),
    )
    .await;
    let response = String::from_utf8(response).unwrap();

    assert!(
        response.starts_with("HTTP/1.1 200 OK"),
        "expected a 200 status line | received: {response:?}, with the read ending in \
         {read_to_end:?}"
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

/// Writes `remote`'s `runtime.json` with setup answered and `audit.enabled`.
fn configure_remote_audit(home: &std::path::Path, enabled: bool) {
    mangostudio_runtime::runtime_home::write_runtime_slot_config(
        RuntimeSlot::Remote,
        home,
        &[
            (
                "setup",
                Some(serde_json::json!({"state": "configured", "by": "cli"})),
            ),
            ("audit", Some(serde_json::json!({ "enabled": enabled }))),
        ],
    )
    .unwrap();
}

/// Serves one session on `home`, announcing `capabilities`, makes one
/// `runtime.health` call and returns once `run` has shut down.
async fn serve_one_health_call(home: &std::path::Path, capabilities: serde_json::Value) {
    let (addr, listener) = bind_ephemeral().await;
    let cancel = CancellationToken::new();
    let server = tokio::spawn(run(
        listener,
        TOKEN.to_string(),
        RuntimeSlot::Remote,
        home.to_path_buf(),
        "0.0.0".to_string(),
        cancel.clone(),
        |_message| {},
    ));
    let options = WebSocketConnectOptions::default().with_bearer(TOKEN);
    let deadline = ConnectDeadline::default().with_timeout(HANG_GUARD);
    let port = connect_websocket(&format!("ws://{addr}/"), &options, &deadline)
        .await
        .expect("the dial reaches the listener");
    let options = SessionOptions::new(support::peer("hub"))
        .with_capabilities(capabilities.as_object().unwrap().clone());
    let (session, _driver) = Session::spawn(port, options);
    session.ready().await.expect("the handshake completes");
    session
        .request("runtime.health", serde_json::json!({}))
        .await
        .expect("runtime.health answers");
    cancel.cancel();
    server.await.unwrap().unwrap();
}

/// A slot whose `runtime.json` turns audit off writes no `audit.log`, and
/// one that turns it on does, as `createRuntimeAuditSink`'s disabled sink.
#[tokio::test]
async fn audit_log_follows_the_slots_audit_setting() {
    for enabled in [false, true] {
        let home = scratch_home(&format!("audit-enabled-{enabled}"));
        configure_remote_audit(&home, enabled);
        serve_one_health_call(&home, serde_json::json!({})).await;
        let path =
            mangostudio_runtime::runtime_home::slot_audit_log_path(RuntimeSlot::Remote, &home);
        let lines = std::fs::read_to_string(&path)
            .map(|contents| contents.lines().count())
            .unwrap_or(0);
        let expected = usize::from(enabled);
        assert!(
            lines == expected,
            "audit.enabled={enabled}: expected audit lines: {expected} | received: {lines}"
        );
    }
}

/// The hub's `hello.capabilities.hub` names every audit line written after
/// the handshake, as `session.ts` did through `setHub`.
#[tokio::test]
async fn a_hub_hello_identity_names_the_next_audit_line() {
    let home = scratch_home("hub-identity");
    configure_remote_audit(&home, true);
    serve_one_health_call(
        &home,
        serde_json::json!({ "hub": { "user": "bob", "host": "desk" } }),
    )
    .await;
    let path = mangostudio_runtime::runtime_home::slot_audit_log_path(RuntimeSlot::Remote, &home);
    let contents = std::fs::read_to_string(&path).unwrap_or_default();
    let hub = contents
        .lines()
        .last()
        .map(|line| {
            let line: serde_json::Value = serde_json::from_str(line).unwrap();
            line["hub"].as_str().unwrap_or_default().to_string()
        })
        .unwrap_or_else(|| {
            panic!(
                "expected an audit line in {} | received: none",
                path.display()
            )
        });
    assert!(
        hub == "bob@desk",
        "expected audit hub: bob@desk | received: {hub}"
    );
}
