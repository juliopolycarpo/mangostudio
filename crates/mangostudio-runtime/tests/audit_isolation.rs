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

use mango_protocol::error::codes;
use mangostudio_runtime::ports::audit::Outcome;
use mangostudio_runtime::ports::authorization::DenyingAuthorization;
use mangostudio_runtime::ports::clock::SystemClock;
use mangostudio_runtime::registry::Registry;
use serde_json::json;
use support::{
    PanickingAudit, PanickingAuthorization, RecordingAudit, health_result, serve_pair, within,
};

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

    let (hub, _runtime) = serve_pair(registry, Arc::new(DenyingAuthorization)).await;

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
async fn a_successful_call_records_outcome_ok() {
    let audit = Arc::new(RecordingAudit::new());
    let registry = Registry::with_ports(Arc::clone(&audit) as _, Arc::new(SystemClock)).implement(
        "runtime.health",
        |_params: serde_json::Value, _context| async move {
            Ok::<_, mango_protocol::RemoteError>(health_result())
        },
    );

    let (hub, _runtime) = serve_pair(registry, Arc::new(DenyingAuthorization)).await;

    let result = within("the request", hub.request("runtime.health", json!({})))
        .await
        .expect("a valid result succeeds");
    assert_eq!(result["slot"], json!("host"));

    let entries = audit.entries();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].outcome, Outcome::Ok);
    assert_eq!(entries[0].code, None);
}

/// The central ordering invariant this crate exists to enforce: a result the
/// contract's own schema refuses must never be recorded as `Outcome::Ok`,
/// and must never reach the wire as anything but `INTERNAL`.
///
/// Demonstrated to matter: swapping `Registry::implement`'s own
/// `check_result` call for `ServeOptions::validate_results = true` (the
/// refactor `crate::result_check`'s docblock exists to forbid) makes every
/// other test in this crate keep passing while this one starts failing,
/// because that refactor validates only *after* `Contract::serve`'s own
/// pipeline has already returned the unchecked value to this wrapper, which
/// has already told the audit port `Outcome::Ok`.
#[tokio::test]
async fn a_schema_invalid_result_is_never_recorded_as_ok() {
    let audit = Arc::new(RecordingAudit::new());
    // `terminal.list`'s result requires `sessions` to be an array; returning
    // a string is a value this handler's own `R` type (`serde_json::Value`)
    // happily serialises, so only the schema check catches it.
    let registry = Registry::with_ports(Arc::clone(&audit) as _, Arc::new(SystemClock)).implement(
        "terminal.list",
        |_params: serde_json::Value, _context| async move {
            Ok::<_, mango_protocol::RemoteError>(json!({ "sessions": "not-an-array" }))
        },
    );

    // `terminal.list` needs `shell`; grant it so the request reaches the
    // handler at all — this test is about the result check, not consent.
    let (hub, _runtime) = serve_pair(registry, Arc::new(support::GrantingAuthorization)).await;

    let error = within("the request", hub.request("terminal.list", json!({})))
        .await
        .expect_err("a schema-invalid result must never reach the wire as success");
    assert_eq!(error.code, codes::INTERNAL);

    let entries = audit.entries();
    assert_eq!(
        entries.len(),
        1,
        "the invalid result must be recorded exactly once, got {entries:?}"
    );
    assert_eq!(
        entries[0].outcome,
        Outcome::Error,
        "a schema-invalid result must never be recorded as Outcome::Ok"
    );
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

    let (hub, _runtime) = serve_pair(registry, Arc::new(DenyingAuthorization)).await;

    let result = within("the request", hub.request("runtime.health", json!({})))
        .await
        .expect("a panicking audit sink must not turn a successful result into an error");
    assert_eq!(result["slot"], json!("host"));
}

/// The same panicking-sink corruption as above, but on `AuthorizationGuard`'s
/// side of the pipeline, where it is the more important half: `334b28a2`
/// named this exact case — a panicking sink turning an already-built
/// `DENIED` into a redacted `INTERNAL` — as one of the two directions that
/// bug fixed. Nothing in `tests/consent.rs` exercises a failing sink, only a
/// healthy `RecordingAudit`, so this was unguarded until now. `serve()`
/// builds `AuthorizationGuard` from the registry's own `Audit` port (see
/// `serve.rs`), so a `PanickingAudit`-backed registry exercises it directly:
/// the denial happens before the handler ever runs, so this registry's
/// `terminal.list` implementation is never reached.
#[tokio::test]
async fn a_panicking_audit_sink_leaves_a_denial_as_denied_not_internal() {
    let registry = Registry::with_ports(Arc::new(PanickingAudit), Arc::new(SystemClock)).implement(
        "terminal.list",
        |_params: serde_json::Value, _context| async move {
            Ok::<_, mango_protocol::RemoteError>(json!({ "sessions": [] }))
        },
    );

    let (hub, _runtime) = serve_pair(registry, Arc::new(DenyingAuthorization)).await;

    let error = within("the request", hub.request("terminal.list", json!({})))
        .await
        .expect_err("shell was never granted");
    assert_eq!(
        error.code,
        codes::DENIED,
        "a panicking audit sink must not turn an already-built DENIED into INTERNAL"
    );
}

/// The mirror case: a panicking `Authorization` port itself (not the sink)
/// must still leave exactly one audit entry, correctly classified as
/// `Outcome::Error` rather than `Outcome::Denied` — the guard never decided
/// a real denial, so it must not be recorded as one.
#[tokio::test]
async fn a_panicking_authorization_port_records_error_not_denied() {
    let audit = Arc::new(RecordingAudit::new());
    let registry = Registry::with_ports(Arc::clone(&audit) as _, Arc::new(SystemClock)).implement(
        "terminal.list",
        |_params: serde_json::Value, _context| async move {
            Ok::<_, mango_protocol::RemoteError>(json!({ "sessions": [] }))
        },
    );

    let (hub, _runtime) = serve_pair(registry, Arc::new(PanickingAuthorization)).await;

    let error = within("the request", hub.request("terminal.list", json!({})))
        .await
        .expect_err("a panicking authorization port becomes INTERNAL");
    assert_eq!(error.code, codes::INTERNAL);

    let entries = audit.entries();
    assert_eq!(
        entries.len(),
        1,
        "a panicking Authorization port must still leave exactly one audit entry, got {entries:?}"
    );
    assert_eq!(
        entries[0].outcome,
        Outcome::Error,
        "a panic in the authorization check is not a real denial"
    );
}
