//! Audit recording must survive a panicking handler, and must never be able
//! to corrupt a wire result if the sink itself panics.
//!
//! `Registry::implement`'s wrapper isolates the handler (plus serialisation
//! and the result check) from the audit-recording call in two separate
//! `catch_panics` boundaries, so the two failure directions below cannot
//! happen: a panicking handler silently dropping its audit line, or a
//! panicking sink turning an already-successful result into `INTERNAL`.

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
use support::{PanickingAudit, RecordingAudit, health_result, open_pair, within};

#[tokio::test]
async fn a_panicking_handler_still_produces_an_audit_entry() {
    let audit = Arc::new(RecordingAudit::new());
    let registry = Registry::with_ports(Arc::clone(&audit) as _, Arc::new(SystemClock)).implement(
        "runtime.health",
        |_params: serde_json::Value, _context| async move {
            panic!("the handler misbehaved and must still be audited");
            #[allow(unreachable_code)]
            let unreachable: Result<serde_json::Value, mango_protocol::RemoteError> =
                Ok(health_result());
            unreachable
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
        "the panicking request",
        hub.request("runtime.health", json!({})),
    )
    .await
    .expect_err("a panic becomes INTERNAL");
    assert_eq!(error.code, codes::INTERNAL);

    let entries = audit.entries();
    assert_eq!(
        entries.len(),
        1,
        "a panicking handler must still produce exactly one audit entry, got {entries:?}"
    );
    assert_eq!(entries[0].method, "runtime.health");
    assert_eq!(entries[0].outcome, Outcome::Error);
    assert_eq!(entries[0].code.as_deref(), Some(codes::INTERNAL));
}

#[tokio::test]
async fn a_panicking_audit_sink_leaves_a_successful_result_untouched_on_the_wire() {
    let registry = Registry::with_ports(Arc::new(PanickingAudit), Arc::new(SystemClock)).implement(
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

    let result = within("the request", hub.request("runtime.health", json!({})))
        .await
        .expect("a panicking audit sink must not turn a successful result into an error");
    assert_eq!(result["slot"], json!("host"));
}
