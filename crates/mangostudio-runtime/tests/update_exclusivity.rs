//! Update exclusivity end to end, through a real session: an update call and
//! an ordinary call each refuse while the other is genuinely in flight, and
//! each becomes possible again once the other has actually settled — proving
//! the claim `AuthorizationGuard` takes and the release
//! `Registry::implement`'s wrapper performs are wired to the same tracker.
//! See `crate::ports::exclusivity` for the unit-level proof of the tracker's
//! own refusal rules; this file is the one proof that the split between
//! where a claim is taken and where it is released actually holds together
//! under `mango_protocol`'s real dispatch pipeline.

#[path = "support/mod.rs"]
mod support;

use std::sync::Arc;

use mango_protocol::contract::Contract;
use mangostudio_runtime::ports::clock::SystemClock;
use mangostudio_runtime::ports::exclusivity::{NotUpdating, UpdateExclusivityTracker};
use mangostudio_runtime::registry::Registry;
use mangostudio_runtime_contract::catalog::catalog;
use mangostudio_runtime_contract::errors::RUNTIME_UPDATE_REFUSED;
use serde::Deserialize;
use serde_json::{Value, json};
use support::{GrantingAuthorization, health_result, open_pair, within};

/// A gate a handler blocks on until the test explicitly opens it, plus a
/// one-shot signal fired the instant the handler starts running — the same
/// two-part rendezvous `tests/panic_isolation.rs` uses, needed here for the
/// same reason: proving two requests were genuinely in flight together
/// rather than merely sequenced by luck.
struct Rendezvous {
    release: tokio::sync::watch::Sender<bool>,
    released: tokio::sync::watch::Receiver<bool>,
    entered_tx: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

impl Rendezvous {
    fn new() -> (Arc<Self>, tokio::sync::oneshot::Receiver<()>) {
        let (release, released) = tokio::sync::watch::channel(false);
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        (
            Arc::new(Self {
                release,
                released,
                entered_tx: std::sync::Mutex::new(Some(entered_tx)),
            }),
            entered_rx,
        )
    }

    fn enter(&self) {
        if let Some(sender) = self.entered_tx.lock().expect("never panics").take() {
            let _ = sender.send(());
        }
    }

    async fn wait_for_release(&self) {
        let mut released = self.released.clone();
        released
            .wait_for(|open| *open)
            .await
            .expect("the release channel is never dropped mid-test");
    }

    fn open(&self) {
        self.release
            .send(true)
            .expect("the blocked request is still waiting on it");
    }
}

fn update_begin_params() -> Value {
    json!({ "version": "0.1.0", "digest": "sha256:deadbeef", "totalBytes": 0 })
}

/// `runtime.health` permits `{}` under its wire schema, but this deliberately
/// drifting Rust type cannot decode it. The integration test below proves
/// the registry wrapper still releases the guard's claim after that error.
#[derive(Deserialize)]
struct IncompatibleHealthParams {
    _required_by_rust_only: String,
}

#[tokio::test]
async fn an_update_call_refuses_while_an_ordinary_call_is_genuinely_in_flight() {
    let (rendezvous, entered_rx) = Rendezvous::new();
    let health_rendezvous = Arc::clone(&rendezvous);

    let exclusivity = Arc::new(UpdateExclusivityTracker::new(Arc::new(NotUpdating)));
    let registry = Registry::with_ports_and_exclusivity(
        Arc::new(mangostudio_runtime::ports::audit::NoopAudit),
        Arc::new(SystemClock),
        exclusivity,
    )
    .implement("runtime.health", move |_params: Value, _context| {
        let health_rendezvous = Arc::clone(&health_rendezvous);
        async move {
            health_rendezvous.enter();
            health_rendezvous.wait_for_release().await;
            Ok::<_, mango_protocol::RemoteError>(health_result())
        }
    })
    .implement(
        "runtime.update.begin",
        |_params: Value, _context| async move {
            Ok::<_, mango_protocol::RemoteError>(
                json!({ "sessionId": "s1", "maxChunkBytes": 1024 }),
            )
        },
    );

    let (hub, runtime) = open_pair().await;
    let contract =
        Contract::from_catalog(catalog().clone()).expect("the embedded catalog compiles");
    let guard = mangostudio_runtime::serve::serve(
        &contract,
        &runtime,
        registry,
        Arc::new(GrantingAuthorization),
        "host",
    )
    .expect("both methods are declared by the catalog");
    guard.persist();

    let hub_for_health = hub.clone();
    let health =
        tokio::spawn(async move { hub_for_health.request("runtime.health", json!({})).await });
    within("runtime.health to start running", entered_rx)
        .await
        .expect("the handler fires its signal before awaiting the release gate");

    let refused = within(
        "the update call while runtime.health is in flight",
        hub.request("runtime.update.begin", update_begin_params()),
    )
    .await
    .expect_err("an ordinary call is already in flight");
    assert_eq!(refused.code, RUNTIME_UPDATE_REFUSED);
    let details = refused.details.expect("details present");
    assert_eq!(details["kind"], json!("runtime_update_refused"));
    assert_eq!(details["reason"], json!("call_in_flight"));

    rendezvous.open();
    let health_result_value = within("runtime.health", health)
        .await
        .expect("the spawned task must not itself have panicked")
        .expect("runtime.health was never refused");
    assert_eq!(health_result_value["slot"], json!("host"));

    // Now that the ordinary call has actually settled (not merely been
    // told to release), the claim it held is gone and the update may run.
    let accepted = within(
        "the update call once runtime.health has settled",
        hub.request("runtime.update.begin", update_begin_params()),
    )
    .await
    .expect("the ordinary call's claim was released when it settled");
    assert_eq!(accepted["sessionId"], json!("s1"));
}

#[tokio::test]
async fn an_ordinary_call_refuses_while_an_update_call_is_genuinely_in_flight() {
    let (rendezvous, entered_rx) = Rendezvous::new();
    let update_rendezvous = Arc::clone(&rendezvous);

    let exclusivity = Arc::new(UpdateExclusivityTracker::new(Arc::new(NotUpdating)));
    let registry = Registry::with_ports_and_exclusivity(
        Arc::new(mangostudio_runtime::ports::audit::NoopAudit),
        Arc::new(SystemClock),
        exclusivity,
    )
    .implement("runtime.health", |_params: Value, _context| async move {
        Ok::<_, mango_protocol::RemoteError>(health_result())
    })
    .implement("runtime.update.begin", move |_params: Value, _context| {
        let update_rendezvous = Arc::clone(&update_rendezvous);
        async move {
            update_rendezvous.enter();
            update_rendezvous.wait_for_release().await;
            Ok::<_, mango_protocol::RemoteError>(
                json!({ "sessionId": "s1", "maxChunkBytes": 1024 }),
            )
        }
    });

    let (hub, runtime) = open_pair().await;
    let contract =
        Contract::from_catalog(catalog().clone()).expect("the embedded catalog compiles");
    let guard = mangostudio_runtime::serve::serve(
        &contract,
        &runtime,
        registry,
        Arc::new(GrantingAuthorization),
        "host",
    )
    .expect("both methods are declared by the catalog");
    guard.persist();

    let hub_for_update = hub.clone();
    let update = tokio::spawn(async move {
        hub_for_update
            .request("runtime.update.begin", update_begin_params())
            .await
    });
    within("runtime.update.begin to start running", entered_rx)
        .await
        .expect("the handler fires its signal before awaiting the release gate");

    let refused = within(
        "an ordinary call while the update is in flight",
        hub.request("runtime.health", json!({})),
    )
    .await
    .expect_err("an update call is already in flight");
    assert_eq!(refused.code, RUNTIME_UPDATE_REFUSED);
    assert_eq!(
        refused.details.expect("details present")["reason"],
        json!("update_in_progress")
    );

    rendezvous.open();
    let update_result = within("runtime.update.begin", update)
        .await
        .expect("the spawned task must not itself have panicked")
        .expect("the update call was never refused");
    assert_eq!(update_result["sessionId"], json!("s1"));

    let accepted = within(
        "an ordinary call once the update has settled",
        hub.request("runtime.health", json!({})),
    )
    .await
    .expect("the update's claim was released when it settled");
    assert_eq!(accepted["slot"], json!("host"));
}

#[tokio::test]
async fn a_decode_failure_releases_an_ordinary_claim_before_an_update_starts() {
    let exclusivity = Arc::new(UpdateExclusivityTracker::new(Arc::new(NotUpdating)));
    let registry = Registry::with_ports_and_exclusivity(
        Arc::new(mangostudio_runtime::ports::audit::NoopAudit),
        Arc::new(SystemClock),
        exclusivity,
    )
    .implement(
        "runtime.health",
        |_params: IncompatibleHealthParams, _context| async move {
            Ok::<_, mango_protocol::RemoteError>(health_result())
        },
    )
    .implement(
        "runtime.update.begin",
        |_params: Value, _context| async move {
            Ok::<_, mango_protocol::RemoteError>(
                json!({ "sessionId": "s1", "maxChunkBytes": 1024 }),
            )
        },
    );

    let (hub, runtime) = open_pair().await;
    let contract =
        Contract::from_catalog(catalog().clone()).expect("the embedded catalog compiles");
    let guard = mangostudio_runtime::serve::serve(
        &contract,
        &runtime,
        registry,
        Arc::new(GrantingAuthorization),
        "host",
    )
    .expect("both methods are declared by the catalog");
    guard.persist();

    let decode_error = within(
        "the schema-valid decode failure",
        hub.request("runtime.health", json!({})),
    )
    .await
    .expect_err("the Rust-only required property cannot decode from an empty object");
    assert_eq!(decode_error.code, mango_protocol::error::codes::INTERNAL);

    let accepted = within(
        "the update call after the failed ordinary decode",
        hub.request("runtime.update.begin", update_begin_params()),
    )
    .await
    .expect("a failed decode must release the ordinary call's exclusivity claim");
    assert_eq!(accepted["sessionId"], json!("s1"));
}
