//! End-to-end coverage for `transport::connect::run` against a minimal fake
//! hub: fatal-close short-circuiting, retry-then-succeed, and cancellation.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use mango_protocol::close::close_codes;
use mango_protocol::session::{Session, SessionOptions};
use mango_protocol::transports::websocket::WebSocketOptions;
use mango_protocol::transports::websocket::server::{AcceptOptions, accept_websocket};
use mangostudio_runtime::runtime_home::RuntimeSlot;
use mangostudio_runtime::transport::connect::{ConnectConfig, ConnectOutcome, FixedJitter, run};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

mod support;

use support::CollectingLog;
use support::scratch::{ScratchDir, scratch_dir};

fn scratch_home(name: &str) -> ScratchDir {
    scratch_dir(&format!("transport-connect-test-{name}"))
}

/// Accepts exactly one connection and closes it with `code` the instant the
/// handshake completes — a fake hub that refuses right after the upgrade,
/// the same shape a real hub uses for both an authorization refusal and a
/// takeover.
async fn fake_hub_closing_with(listener: TcpListener, code: u16) {
    let (stream, _addr) = listener.accept().await.unwrap();
    let port = accept_websocket(
        stream,
        AcceptOptions::from(WebSocketOptions::default()),
        |_upgrade| Ok(()),
    )
    .await
    .unwrap();
    let (session, _driver) = Session::spawn(port, SessionOptions::new(support::peer("hub")));
    let _ = session.ready().await;
    session.close(code, Some("test hub closing")).await;
}

/// Refuses the connection outright the first `refusals` times (drops the
/// TCP connection before any WebSocket upgrade), then accepts normally and
/// keeps the session open until told to stop.
async fn fake_hub_retrying_then_accepting(
    listener: TcpListener,
    refusals: usize,
    accepted: Arc<AtomicUsize>,
) {
    for _ in 0..refusals {
        let (stream, _addr) = listener.accept().await.unwrap();
        drop(stream); // refuse before any upgrade at all
    }
    let (stream, _addr) = listener.accept().await.unwrap();
    let port = accept_websocket(
        stream,
        AcceptOptions::from(WebSocketOptions::default()),
        |_upgrade| Ok(()),
    )
    .await
    .unwrap();
    let (session, _driver) = Session::spawn(port, SessionOptions::new(support::peer("hub")));
    session
        .ready()
        .await
        .expect("the accepted dial completes its handshake");
    accepted.fetch_add(1, Ordering::SeqCst);
    // Held open until the client side stops it (mirrors a real hub that
    // does not close its end of an accepted, healthy session on its own).
    session.closed().await;
}

fn create_definition_slot() -> (RuntimeSlot, ScratchDir) {
    (RuntimeSlot::Remote, scratch_home("connect"))
}

/// A fatal close from the hub (here: `UNAUTHORIZED`, standing in for a
/// revoked pairing token) stops the loop immediately — no backoff, no
/// further dial — rather than retrying a credential that will never be
/// accepted.
#[tokio::test]
async fn a_fatal_close_stops_the_loop_without_retrying() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let hub = tokio::spawn(fake_hub_closing_with(listener, close_codes::UNAUTHORIZED));

    let (slot, home) = create_definition_slot();
    let cancel = CancellationToken::new();
    let jitter = FixedJitter(0.5);
    let log = CollectingLog::new();
    let outcome = tokio::time::timeout(
        Duration::from_secs(5),
        run(
            ConnectConfig {
                hub_url: format!("ws://{addr}/"),
                token: "irrelevant-token".to_string(),
                slot,
                mango_home: home.to_path_buf(),
                runtime_version: "0.0.0".to_string(),
            },
            cancel,
            &jitter,
            log.sink(),
        ),
    )
    .await
    .expect("a fatal close must not hang the loop in a retry wait");

    match outcome {
        ConnectOutcome::Refused { message } => {
            assert!(message.contains("pairing token"), "{message}");
        }
        other => panic!("expected Refused, got {other:?}"),
    }
    hub.await.unwrap();

    let messages = log.messages();
    assert!(
        messages.iter().any(|m| m.starts_with("Connected to ")),
        "the dial succeeded before the hub closed it, so a real connection was logged: {messages:?}"
    );
    assert!(
        !messages.iter().any(|m| m.contains("Reconnecting")),
        "a fatal close must not log a reconnect attempt it never makes: {messages:?}"
    );
}

/// A transient refusal (the hub not accepting the TCP connection at all) is
/// retried, and the loop succeeds once the hub starts accepting — proving
/// this is a real retry loop, not a one-shot dial.
#[tokio::test]
async fn a_transient_refusal_is_retried_until_the_hub_accepts() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let accepted = Arc::new(AtomicUsize::new(0));
    let hub = tokio::spawn(fake_hub_retrying_then_accepting(
        listener,
        2,
        Arc::clone(&accepted),
    ));

    let (slot, home) = create_definition_slot();
    let cancel = CancellationToken::new();
    let cancel_for_run = cancel.clone();
    let jitter = FixedJitter(0.0); // the fastest end of the backoff window
    let log = CollectingLog::new();
    let log_for_run = log.clone();
    let run_handle = tokio::spawn(async move {
        run(
            ConnectConfig {
                hub_url: format!("ws://{addr}/"),
                token: "irrelevant-token".to_string(),
                slot,
                mango_home: home.to_path_buf(),
                runtime_version: "0.0.0".to_string(),
            },
            cancel_for_run,
            &jitter,
            log_for_run.sink(),
        )
        .await
    });

    // Wait for the hub to actually accept a session (proving the retries
    // happened), then stop the loop cleanly.
    tokio::time::timeout(Duration::from_secs(10), async {
        while accepted.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the loop must eventually reach an accepting hub");

    cancel.cancel();
    let outcome = tokio::time::timeout(Duration::from_secs(5), run_handle)
        .await
        .expect("run must return promptly once cancelled")
        .unwrap();
    assert_eq!(outcome, ConnectOutcome::Stopped);
    hub.await.unwrap();

    let messages = log.messages();
    let reconnect_lines = messages
        .iter()
        .filter(|m| m.contains("Reconnecting"))
        .count();
    assert_eq!(
        reconnect_lines, 2,
        "both refused dials must be logged as a reconnect, not silently swallowed: {messages:?}"
    );
    assert!(
        messages.iter().any(|m| m.starts_with("Connected to ")),
        "the accepted dial must be logged too, proving the retry actually reached the hub: {messages:?}"
    );
}

/// Cancelling mid-connection releases the session (`RELEASED`) and returns
/// `Stopped` promptly, rather than waiting for the hub to close its end.
#[tokio::test]
async fn cancellation_stops_the_loop_and_releases_the_session() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let accepted = Arc::new(AtomicUsize::new(0));
    let hub = tokio::spawn(fake_hub_retrying_then_accepting(
        listener,
        0,
        Arc::clone(&accepted),
    ));

    let (slot, home) = create_definition_slot();
    let cancel = CancellationToken::new();
    let cancel_for_run = cancel.clone();
    let jitter = FixedJitter(0.0);
    let log = CollectingLog::new();
    let log_for_run = log.clone();
    let run_handle = tokio::spawn(async move {
        run(
            ConnectConfig {
                hub_url: format!("ws://{addr}/"),
                token: "irrelevant-token".to_string(),
                slot,
                mango_home: home.to_path_buf(),
                runtime_version: "0.0.0".to_string(),
            },
            cancel_for_run,
            &jitter,
            log_for_run.sink(),
        )
        .await
    });

    tokio::time::timeout(Duration::from_secs(5), async {
        while accepted.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the dial must complete before cancelling it");

    cancel.cancel();
    let outcome = tokio::time::timeout(Duration::from_secs(2), run_handle)
        .await
        .expect("cancellation must not require waiting out the backoff")
        .unwrap();
    assert_eq!(outcome, ConnectOutcome::Stopped);
    hub.await.unwrap();

    let messages = log.messages();
    assert!(
        messages.iter().any(|m| m.starts_with("Connected to ")),
        "the dial must be logged before cancellation tears it down: {messages:?}"
    );
    assert!(
        !messages.iter().any(|m| m.contains("Reconnecting")),
        "a clean cancellation is not a failure to reconnect from: {messages:?}"
    );
}

/// Polls `slot`'s audit log until it holds a line, then returns the last
/// line's `hub` field.
async fn last_audited_hub(slot: RuntimeSlot, home: &std::path::Path) -> String {
    let path = mangostudio_runtime::runtime_home::slot_audit_log_path(slot, home);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let contents = std::fs::read_to_string(&path).unwrap_or_default();
            if let Some(line) = contents.lines().last() {
                let line: serde_json::Value = serde_json::from_str(line).unwrap();
                return line["hub"].as_str().unwrap_or_default().to_string();
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "expected an audit line in {} | received: none",
            path.display()
        )
    })
}

/// Accepts one connection announcing `capabilities`, makes one
/// `runtime.health` call, and returns the hub field of the audit line that
/// call wrote.
async fn audited_hub_after_a_hello_with(capabilities: serde_json::Value) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (slot, home) = create_definition_slot();
    let cancel = CancellationToken::new();
    let cancel_for_run = cancel.clone();
    let home_for_run = home.to_path_buf();
    let run_handle = tokio::spawn(async move {
        run(
            ConnectConfig {
                hub_url: format!("ws://{addr}/"),
                token: "irrelevant-token".to_string(),
                slot,
                mango_home: home_for_run,
                runtime_version: "0.0.0".to_string(),
            },
            cancel_for_run,
            &FixedJitter(0.0),
            CollectingLog::new().sink(),
        )
        .await
    });

    let (stream, _addr) = listener.accept().await.unwrap();
    let port = accept_websocket(
        stream,
        AcceptOptions::from(WebSocketOptions::default()),
        |_upgrade| Ok(()),
    )
    .await
    .unwrap();
    let options = SessionOptions::new(support::peer("hub"))
        .with_capabilities(capabilities.as_object().unwrap().clone());
    let (session, _driver) = Session::spawn(port, options);
    session.ready().await.expect("the handshake completes");
    let _ = session
        .request("runtime.health", serde_json::json!({}))
        .await;
    let hub = last_audited_hub(slot, &home).await;

    cancel.cancel();
    let _ = tokio::time::timeout(Duration::from_secs(5), run_handle).await;
    hub
}

/// The hub's `hello.capabilities.hub` names every audit line written after
/// the handshake, as `session.ts` did through `setHub`.
#[tokio::test]
async fn a_hub_hello_identity_names_the_next_audit_line() {
    let hub = audited_hub_after_a_hello_with(
        serde_json::json!({ "hub": { "user": "bob", "host": "desk" } }),
    )
    .await;
    assert!(
        hub == "bob@desk",
        "expected audit hub: bob@desk | received: {hub}"
    );
}

/// A hub identity that fails `HubIdentitySchema` is not trusted.
#[tokio::test]
async fn an_invalid_hub_hello_identity_leaves_the_audit_line_unidentified() {
    let hub =
        audited_hub_after_a_hello_with(serde_json::json!({ "hub": { "user": "bob", "host": "" } }))
            .await;
    assert!(
        hub == "unidentified hub",
        "expected audit hub: unidentified hub | received: {hub}"
    );
}
