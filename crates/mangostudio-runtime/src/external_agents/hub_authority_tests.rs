use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use mango_protocol::error::{RemoteError, codes};
use mango_protocol::frame::PeerInfo;
use mango_protocol::port::port_pair;
use mango_protocol::session::{Session, SessionOptions};
use serde_json::{Value, json};

use super::{HUB_AUTHORIZE_TIMEOUT, HubWorkspaceAuthority};
use crate::external_agents::supervisor::WorkspaceAuthority;
use mangostudio_runtime_contract::hub::HUB_WORKSPACE_AUTHORIZE;

fn peer(role: &str) -> PeerInfo {
    PeerInfo {
        name: "hub-authority-test".into(),
        version: "0.1.0".into(),
        role: role.into(),
    }
}

/// A handshaken (hub, runtime) pair over an in-memory port.
async fn handshaken_pair() -> (Session, Session) {
    let (hub_port, runtime_port) = port_pair();
    let (hub, _hub_driver) = Session::spawn(hub_port, SessionOptions::new(peer("hub")));
    let (runtime, _runtime_driver) =
        Session::spawn(runtime_port, SessionOptions::new(peer("runtime")));
    tokio::time::timeout(Duration::from_secs(5), hub.ready())
        .await
        .expect("hub handshake within 5 s")
        .expect("hub handshake succeeds");
    tokio::time::timeout(Duration::from_secs(5), runtime.ready())
        .await
        .expect("runtime handshake within 5 s")
        .expect("runtime handshake succeeds");
    (hub, runtime)
}

/// A fake hub that answers `hub.workspace.authorize` with a fixed result and
/// records every params object it received.
struct AnsweringHub {
    received: Arc<Mutex<Vec<Value>>>,
}

impl AnsweringHub {
    fn serve(hub: &Session, answer: Result<Value, RemoteError>) -> Self {
        let received = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&received);
        hub.handle(HUB_WORKSPACE_AUTHORIZE, move |params: Value, _context| {
            log.lock().unwrap().push(params);
            let answer = answer.clone();
            async move { answer }
        })
        .persist();
        Self { received }
    }

    fn received(&self) -> Vec<Value> {
        self.received.lock().unwrap().clone()
    }
}

/// A fake hub that accepts the question and never answers it.
fn serve_stalling_hub(hub: &Session) {
    hub.handle(HUB_WORKSPACE_AUTHORIZE, |_params: Value, _context| async {
        std::future::pending::<Result<Value, RemoteError>>().await
    })
    .persist();
}

fn authority() -> HubWorkspaceAuthority {
    HubWorkspaceAuthority::new(HUB_AUTHORIZE_TIMEOUT)
}

async fn answer_for(result: Value) -> (bool, Vec<Value>) {
    let (hub, runtime) = handshaken_pair().await;
    let fake = AnsweringHub::serve(&hub, Ok(result));
    let admitted = authority()
        .authorize(&runtime, Path::new("/work/project"))
        .await;
    (admitted, fake.received())
}

#[tokio::test]
async fn an_explicit_yes_admits_and_sends_the_declared_question() {
    let (admitted, received) = answer_for(json!({ "authorized": true })).await;
    assert!(admitted, "expected admitted: true | received: false");
    assert_eq!(
        received,
        [json!({ "canonicalPath": "/work/project", "purpose": "external-agent" })],
        "expected exactly one declared question"
    );
}

#[tokio::test]
async fn anything_but_an_explicit_schema_valid_yes_refuses() {
    for (label, result) in [
        ("an explicit no", json!({ "authorized": false })),
        ("a string yes", json!({ "authorized": "true" })),
        (
            "an undeclared member",
            json!({ "authorized": true, "extra": 1 }),
        ),
        ("no member", json!({})),
        ("a bare true", json!(true)),
    ] {
        let (admitted, _received) = answer_for(result).await;
        assert!(
            !admitted,
            "expected admitted: false for {label} | received: true"
        );
    }
}

#[tokio::test]
async fn an_older_hub_without_the_method_refuses() {
    let (_hub, runtime) = handshaken_pair().await;
    let admitted = authority().authorize(&runtime, Path::new("/work")).await;
    assert!(
        !admitted,
        "expected admitted: false against METHOD_UNSUPPORTED | received: true"
    );
}

#[tokio::test]
async fn a_hub_error_refuses() {
    let (hub, runtime) = handshaken_pair().await;
    let _fake = AnsweringHub::serve(
        &hub,
        Err(RemoteError::new(codes::INVALID_PARAMS, "refused")),
    );
    assert!(!authority().authorize(&runtime, Path::new("/work")).await);
}

#[tokio::test]
async fn a_stalling_hub_refuses_once_the_bound_passes() {
    let (hub, runtime) = handshaken_pair().await;
    serve_stalling_hub(&hub);
    let bounded = HubWorkspaceAuthority::new(Duration::from_millis(50));
    let answer = tokio::time::timeout(
        Duration::from_secs(5),
        bounded.authorize(&runtime, Path::new("/work")),
    )
    .await
    .expect(
        "expected the authority to give up at its own 50 ms bound | received: still waiting at 5 s",
    );
    assert!(
        !answer,
        "expected admitted: false on timeout | received: true"
    );
}

#[tokio::test]
async fn a_closed_session_refuses() {
    let (hub, runtime) = handshaken_pair().await;
    let fake = AnsweringHub::serve(&hub, Ok(json!({ "authorized": true })));
    runtime.close(1000, Some("test")).await;
    assert!(
        !authority().authorize(&runtime, Path::new("/work")).await,
        "expected admitted: false on a closed session | received: true"
    );
    assert!(fake.received().is_empty());
}

#[tokio::test]
async fn a_path_the_catalog_refuses_is_never_sent() {
    let (hub, runtime) = handshaken_pair().await;
    let fake = AnsweringHub::serve(&hub, Ok(json!({ "authorized": true })));
    let long = format!("/{}", "a".repeat(4096));
    assert!(!authority().authorize(&runtime, Path::new(&long)).await);
    assert!(
        fake.received().is_empty(),
        "expected no request for an over-long path | received: {:?}",
        fake.received().len()
    );
}

#[cfg(unix)]
#[tokio::test]
async fn a_path_that_is_not_utf8_is_never_sent() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    let (hub, runtime) = handshaken_pair().await;
    let fake = AnsweringHub::serve(&hub, Ok(json!({ "authorized": true })));
    let path = Path::new(OsStr::from_bytes(b"/work/\xff"));
    assert!(
        !authority().authorize(&runtime, path).await,
        "expected admitted: false for a non-UTF-8 path | received: true"
    );
    assert!(fake.received().is_empty(), "expected no lossy request");
}
