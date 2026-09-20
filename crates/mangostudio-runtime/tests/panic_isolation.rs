//! The panic-isolation guarantee, proved through a real session over the
//! in-process port pair: two concurrent requests to the same method, one
//! panics, the other completes normally, the session stays open, and the
//! panicking request's `INTERNAL` carries neither the panic payload's text
//! nor a path.

#[path = "support/mod.rs"]
mod support;

use std::sync::Arc;
use std::time::Duration;

use mango_protocol::contract::Contract;
use mango_protocol::error::codes;
use mangostudio_runtime::ports::authorization::DenyingAuthorization;
use mangostudio_runtime::registry::Registry;
use mangostudio_runtime_contract::catalog::catalog;
use serde::Deserialize;
use serde_json::json;
use support::{health_result, open_pair, within};

/// `runtime.health`'s params schema declares no properties and no
/// `additionalProperties: false`, so it accepts this extra field without
/// failing schema validation — this test's only way to tell the handler
/// which of the two concurrent calls should panic.
#[derive(Debug, Deserialize)]
struct HealthParams {
    #[serde(default, rename = "triggerPanic")]
    trigger_panic: bool,
}

#[tokio::test]
async fn a_panicking_concurrent_request_does_not_take_down_a_normal_one() {
    // A gate the "normal" handler blocks on until the test explicitly opens
    // it — the only way to prove the two requests were genuinely
    // in flight together, rather than merely sequenced by luck.
    let (release, released) = tokio::sync::watch::channel(false);

    let registry =
        Registry::new().implement("runtime.health", move |params: HealthParams, _context| {
            let mut released = released.clone();
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
    tokio::time::sleep(Duration::from_millis(20)).await;

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
