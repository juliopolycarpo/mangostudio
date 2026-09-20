//! `AuthorizationGuard` through a real session: `DenyingAuthorization`
//! refuses a capability-bearing method and records the denial, and lets a
//! zero-capability method through untouched; `GrantingAuthorization` and
//! `PartiallyGrantingAuthorization` prove the guard actually consults its
//! port's answer rather than passing every call by construction;
//! `PanickingAuthorization` proves a misbehaving port still leaves an audit
//! entry behind.

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
use support::{
    GrantingAuthorization, PanickingAuthorization, PartiallyGrantingAuthorization, RecordingAudit,
    health_result, open_pair, within,
};

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

#[tokio::test]
async fn granting_authorization_lets_a_capability_bearing_method_through() {
    let registry = Registry::new().implement(
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
        Arc::new(GrantingAuthorization),
        "host",
    )
    .expect("terminal.list is declared by the catalog");
    guard.persist();

    let result = within("terminal.list", hub.request("terminal.list", json!({})))
        .await
        .expect("a granting port must let the call reach the handler");
    assert_eq!(result["sessions"], json!([]));
}

/// `snapshot.capture` is the catalog's only method declaring two
/// capabilities (`checkpoints` and `fsRead`), which makes it the one method
/// that can prove the guard evaluates each capability independently rather
/// than treating "some are granted" as "all are granted".
#[tokio::test]
async fn partially_granting_authorization_names_only_the_ungranted_capability() {
    let registry = Registry::new().implement(
        "snapshot.capture",
        |_params: serde_json::Value, _context| async move {
            Ok::<_, mango_protocol::RemoteError>(json!({ "exists": false }))
        },
    );

    let (hub, runtime) = open_pair().await;
    let contract =
        Contract::from_catalog(catalog().clone()).expect("the embedded catalog compiles");
    let guard = mangostudio_runtime::serve::serve(
        &contract,
        &runtime,
        registry,
        Arc::new(PartiallyGrantingAuthorization::new(["checkpoints"])),
        "host",
    )
    .expect("snapshot.capture is declared by the catalog");
    guard.persist();

    let denied = within(
        "snapshot.capture",
        hub.request("snapshot.capture", json!({ "path": "/tmp/x" })),
    )
    .await
    .expect_err("fsRead was not granted, even though checkpoints was");
    assert_eq!(denied.code, codes::DENIED);
    assert_eq!(denied.details.unwrap()["missing"], json!(["fsRead"]));
}

#[tokio::test]
async fn a_panicking_authorization_port_still_produces_an_audit_entry() {
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
        Arc::new(PanickingAuthorization),
        "host",
    )
    .expect("terminal.list is declared by the catalog");
    guard.persist();

    let error = within("terminal.list", hub.request("terminal.list", json!({})))
        .await
        .expect_err("a panicking authorization port becomes INTERNAL");
    assert_eq!(error.code, codes::INTERNAL);

    let entries = audit.entries();
    assert_eq!(
        entries.len(),
        1,
        "a panicking Authorization port must still leave exactly one audit entry, got {entries:?}"
    );
    assert_eq!(entries[0].outcome, Outcome::Error);
    assert_eq!(entries[0].code.as_deref(), Some(codes::INTERNAL));
}
