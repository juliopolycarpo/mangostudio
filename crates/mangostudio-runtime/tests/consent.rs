//! `DenyingAuthorization` through a real session: it refuses a
//! capability-bearing method and records the denial, and it lets a
//! zero-capability method through untouched.

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
use serde_json::json;
use support::{RecordingAudit, health_result, open_pair, within};

#[tokio::test]
async fn denying_authorization_refuses_a_capability_bearing_method_and_records_it() {
    let audit = Arc::new(RecordingAudit::new());
    let registry = Registry::with_ports(Arc::clone(&audit) as _, Arc::new(SystemClock)).implement(
        "terminal.list",
        |_params: serde_json::Value, _context| async move {
            Ok::<_, mango_protocol::RemoteError>(json!({ "sessions": [] }))
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
    .expect("terminal.list is declared by the catalog");
    guard.persist();

    let denied = within("terminal.list", hub.request("terminal.list", json!({})))
        .await
        .expect_err("shell was never granted");
    assert_eq!(denied.code, codes::DENIED);
    let details = denied.details.expect("details present");
    assert_eq!(details["kind"], json!("consent_denied"));
    assert_eq!(details["method"], json!("terminal.list"));
    assert_eq!(details["missing"], json!(["shell"]));
    assert_eq!(details["slot"], json!("host"));
    assert_eq!(details["capability"], json!("shell"));

    let entries = audit.entries();
    assert_eq!(entries.len(), 1, "the denial must be recorded exactly once");
    assert_eq!(entries[0].method, "terminal.list");
    assert_eq!(entries[0].outcome, Outcome::Denied);
    assert_eq!(entries[0].capability.as_deref(), Some("shell"));
    assert_eq!(entries[0].code.as_deref(), Some(codes::DENIED));
}

#[tokio::test]
async fn a_zero_capability_method_passes_even_under_the_denying_default() {
    let registry = Registry::new().implement(
        "runtime.health",
        |_params: serde_json::Value, _context| async move {
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

    let result = within("runtime.health", hub.request("runtime.health", json!({})))
        .await
        .expect("a zero-capability method must pass even the denying default");
    assert_eq!(result["slot"], json!("host"));
}
