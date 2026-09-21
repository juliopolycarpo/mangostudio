//! The panic-isolation guarantee, proved through a real session over the
//! in-process port pair: two concurrent requests to the same method, one
//! panics, the other completes normally, the session stays open, and the
//! panicking request's `INTERNAL` carries neither the panic payload's text
//! nor a path.

#[path = "support/mod.rs"]
mod support;

use std::sync::Arc;

use mango_protocol::contract::Contract;
use mango_protocol::error::codes;
use mangostudio_runtime::ports::audit::Outcome;
use mangostudio_runtime::ports::authorization::DenyingAuthorization;
use mangostudio_runtime::ports::clock::SystemClock;
use mangostudio_runtime::registry::Registry;
use mangostudio_runtime_contract::catalog::catalog;
use serde::{Deserialize, Deserializer};
use serde_json::json;
use support::{RecordingAudit, health_result, open_pair, within};

/// `runtime.health`'s params schema declares no properties and no
/// `additionalProperties: false`, so it accepts this extra field without
/// failing schema validation — this test's only way to tell the handler
/// which of the two concurrent calls should panic.
#[derive(Debug, Deserialize)]
struct HealthParams {
    #[serde(default, rename = "triggerPanic")]
    trigger_panic: bool,
}

/// Deliberately requires a property that `runtime.health`'s permissive
/// params schema does not require. A schema-valid `{}` must therefore reach
/// the registry's protected decode path and become its ordinary `INTERNAL`
/// mismatch, rather than bypassing its audit and cleanup wrapper.
#[derive(Debug, Deserialize)]
struct IncompatibleHealthParams {
    _required_by_rust_only: String,
}

/// A hostile `Deserialize` implementation: a panic here used to escape the
/// registry wrapper because `ContractHandlers` decoded typed parameters
/// before invoking it. Keep the sensitive text distinct from the handler
/// panic below so this test proves the decode boundary itself is redacted.
struct PanickingHealthParams;

impl<'de> Deserialize<'de> for PanickingHealthParams {
    fn deserialize<D>(_deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        panic!("deserialize read /etc/shadow and token sk-secret-decode-canary");
    }
}

#[tokio::test]
async fn a_schema_valid_decode_failure_is_audited_as_internal() {
    let audit = Arc::new(RecordingAudit::new());
    let registry = Registry::with_ports(Arc::clone(&audit) as _, Arc::new(SystemClock)).implement(
        "runtime.health",
        |_params: IncompatibleHealthParams, _context| async move {
            Ok::<_, mango_protocol::RemoteError>(health_result())
        },
    );

    let (hub, runtime) = open_pair().await;
    let contract =
        Contract::from_catalog(catalog().clone()).expect("the embedded catalog compiles");
    let guard = mangostudio_runtime::serve::serve(
        &contract,
        &runtime,
        registry,
        Arc::new(DenyingAuthorization),
        "host",
    )
    .expect("runtime.health is declared by the catalog");
    guard.persist();

    let error = within(
        "the schema-valid decode failure",
        hub.request("runtime.health", json!({})),
    )
    .await
    .expect_err("a Rust parameter type that drifts from the schema becomes INTERNAL");
    assert_eq!(error.code, codes::INTERNAL);
    assert!(
        error
            .message
            .contains("passed their schema but failed to decode into the handler's Rust type"),
        "the decode failure keeps its specific diagnostic: {}",
        error.message
    );
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|details| details.get("method")),
        Some(&json!("runtime.health"))
    );

    let entries = audit.entries();
    assert_eq!(entries.len(), 1, "the decode failure must be audited once");
    assert_eq!(entries[0].outcome, Outcome::Error);
    assert_eq!(entries[0].code.as_deref(), Some(codes::INTERNAL));
}

#[tokio::test]
async fn a_panicking_parameter_decode_is_redacted_and_audited() {
    let audit = Arc::new(RecordingAudit::new());
    let registry = Registry::with_ports(Arc::clone(&audit) as _, Arc::new(SystemClock)).implement(
        "runtime.health",
        |_params: PanickingHealthParams, _context| async move {
            Ok::<_, mango_protocol::RemoteError>(health_result())
        },
    );

    let (hub, runtime) = open_pair().await;
    let contract =
        Contract::from_catalog(catalog().clone()).expect("the embedded catalog compiles");
    let guard = mangostudio_runtime::serve::serve(
        &contract,
        &runtime,
        registry,
        Arc::new(DenyingAuthorization),
        "host",
    )
    .expect("runtime.health is declared by the catalog");
    guard.persist();

    let error = within(
        "the panicking parameter decode",
        hub.request("runtime.health", json!({})),
    )
    .await
    .expect_err("a deserializer panic becomes a redacted INTERNAL error");
    assert_eq!(error.code, codes::INTERNAL);
    assert!(
        !error.message.contains("/etc/shadow"),
        "leaked a path: {}",
        error.message
    );
    assert!(
        !error.message.contains("sk-secret-decode-canary"),
        "leaked a token: {}",
        error.message
    );

    let entries = audit.entries();
    assert_eq!(
        entries.len(),
        1,
        "a panicking deserializer must still be audited exactly once"
    );
    assert_eq!(entries[0].outcome, Outcome::Error);
    assert_eq!(entries[0].code.as_deref(), Some(codes::INTERNAL));
}

#[tokio::test]
async fn a_panicking_concurrent_request_does_not_take_down_a_normal_one() {
    // A gate the "normal" handler blocks on until the test explicitly opens
    // it — the only way to prove the two requests were genuinely
    // in flight together, rather than merely sequenced by luck.
    let (release, released) = tokio::sync::watch::channel(false);
    // Fired by the normal handler the instant it starts running, so the test
    // can wait for proof that the handler *entered* — a fixed sleep only
    // proves time passed, not that the task was scheduled in time.
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel::<()>();
    let entered_tx = std::sync::Mutex::new(Some(entered_tx));

    let registry =
        Registry::new().implement("runtime.health", move |params: HealthParams, _context| {
            let mut released = released.clone();
            if !params.trigger_panic
                && let Some(sender) = entered_tx.lock().expect("never panics").take()
            {
                let _ = sender.send(());
            }
            async move {
                if params.trigger_panic {
                    panic!("the file contained /etc/shadow and token sk-secret-9f3a-canary");
                }
                released
                    .wait_for(|open| *open)
                    .await
                    .expect("the release channel is never dropped mid-test");
                Ok::<_, mango_protocol::RemoteError>(health_result())
            }
        });

    let (hub, runtime) = open_pair().await;
    let contract =
        Contract::from_catalog(catalog().clone()).expect("the embedded catalog compiles");
    let guard = mangostudio_runtime::serve::serve(
        &contract,
        &runtime,
        registry,
        Arc::new(DenyingAuthorization),
        "host",
    )
    .expect("runtime.health is declared by the catalog");
    guard.persist();

    // Starts first, but blocks on the gate — still in flight, not settled,
    // when the panicking request below resolves.
    let hub_for_normal = hub.clone();
    let normal = tokio::spawn(async move {
        hub_for_normal
            .request("runtime.health", json!({ "triggerPanic": false }))
            .await
    });
    within("the normal handler to start running", entered_rx)
        .await
        .expect("the handler fires its signal before awaiting the release gate");

    let panicked = within(
        "the panicking request",
        hub.request("runtime.health", json!({ "triggerPanic": true })),
    )
    .await
    .expect_err("a panic must become INTERNAL, not a propagated failure");
    assert_eq!(panicked.code, codes::INTERNAL);
    assert!(
        !panicked.message.contains("/etc/shadow"),
        "leaked a path: {}",
        panicked.message
    );
    assert!(
        !panicked.message.contains("sk-secret-9f3a-canary"),
        "leaked a token: {}",
        panicked.message
    );

    // Only now — after the panic has already settled — release the normal
    // request, proving it was genuinely concurrent rather than sequenced.
    release
        .send(true)
        .expect("the normal request is still waiting on it");

    let normal_result = within("the normal request", normal)
        .await
        .expect("the spawned task must not itself have panicked")
        .expect("a concurrent panic must not fail the unrelated normal request");
    assert_eq!(normal_result["slot"], json!("host"));

    // The session survives the panic and keeps answering requests.
    let after = within(
        "a request issued after the panic",
        hub.request("runtime.health", json!({})),
    )
    .await
    .expect("the session must still be open after a handler panic");
    assert_eq!(after["slot"], json!("host"));
}
