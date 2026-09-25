//! `AuthorizationGuard` through a real session: `DenyingAuthorization`
//! refuses a capability-bearing method and records the denial, and lets a
//! zero-capability method through untouched; `GrantingAuthorization` and
//! `PartiallyGrantingAuthorization` prove the guard actually consults its
//! port's answer rather than passing every call by construction. See
//! `tests/audit_isolation.rs` for `PanickingAuthorization` and
//! `PanickingAudit` exercised against this guard — that file is the home
//! for every "a port panics" audit-recording test, on both the
//! `Registry::implement` and `AuthorizationGuard` sides. The catalog tests at
//! the end pin the capability split the guard reads from the embedded
//! contract, where a read-only profile's "no writes" line is drawn.

#[path = "support/mod.rs"]
mod support;

use std::sync::Arc;

use mango_protocol::error::codes;
use mangostudio_runtime::consent::presets::consent_preset;
use mangostudio_runtime::ports::audit::Outcome;
use mangostudio_runtime::ports::authorization::DenyingAuthorization;
use mangostudio_runtime::ports::clock::SystemClock;
use mangostudio_runtime::registry::Registry;
use mangostudio_runtime_contract::catalog::capabilities_of;
use mangostudio_runtime_contract::manifest::ManifestProfile;
use serde_json::json;
use support::{
    GrantingAuthorization, PartiallyGrantingAuthorization, RecordingAudit, health_result,
    serve_pair, within,
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

    let (hub, _runtime) = serve_pair(registry, Arc::new(DenyingAuthorization)).await;

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

    let (hub, _runtime) = serve_pair(registry, Arc::new(DenyingAuthorization)).await;

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

    let (hub, _runtime) = serve_pair(registry, Arc::new(GrantingAuthorization)).await;

    let result = within("terminal.list", hub.request("terminal.list", json!({})))
        .await
        .expect("a granting port must let the call reach the handler");
    assert_eq!(result["sessions"], json!([]));
}

/// `snapshot.capture` declares both `checkpoints` and `fsRead`, so it proves
/// the guard evaluates each capability independently rather than treating
/// "some are granted" as "all are granted". Other catalog methods now have
/// multi-capability requirements too; this test needs one representative,
/// not a brittle claim that this is the only one.
#[tokio::test]
async fn partially_granting_authorization_names_only_the_ungranted_capability() {
    let registry = Registry::new().implement(
        "snapshot.capture",
        |_params: serde_json::Value, _context| async move {
            Ok::<_, mango_protocol::RemoteError>(json!({ "exists": false }))
        },
    );

    let (hub, _runtime) = serve_pair(
        registry,
        Arc::new(PartiallyGrantingAuthorization::new(["checkpoints"])),
    )
    .await;

    let denied = within(
        "snapshot.capture",
        hub.request("snapshot.capture", json!({ "path": "/tmp/x" })),
    )
    .await
    .expect_err("fsRead was not granted, even though checkpoints was");
    assert_eq!(denied.code, codes::DENIED);
    assert_eq!(denied.details.unwrap()["missing"], json!(["fsRead"]));
}

/// The declared capabilities of `method` in the embedded contract, as
/// borrowed strings, failing with a message that names the method when the
/// catalog does not know it.
fn declared(method: &str) -> Vec<&'static str> {
    capabilities_of(method)
        .unwrap_or_else(|| panic!("expected {method} in the embedded catalog | received: absent"))
        .iter()
        .map(String::as_str)
        .collect()
}

/// The guard reads the method name and never its params, so the catalog
/// split between `gh.exec` and `gh.mutate` is the only place a read-only
/// machine's "no writes" line can be drawn for the GitHub CLI: `readonly`
/// grants `git` and refuses `shell`, and a mutating `gh` that rode plain
/// `git` would open pull requests on it.
#[test]
fn gh_exec_needs_git_and_gh_mutate_needs_git_and_shell() {
    assert_eq!(
        declared("gh.exec"),
        ["git"],
        "expected gh.exec capabilities: [git] | received: {:?}",
        declared("gh.exec")
    );
    assert_eq!(
        declared("gh.mutate"),
        ["git", "shell"],
        "expected gh.mutate capabilities: [git, shell] | received: {:?}",
        declared("gh.mutate")
    );
    let readonly = consent_preset(ManifestProfile::Readonly);
    assert!(
        readonly.is_granted("git") && !readonly.is_granted("shell"),
        "expected readonly to grant git and refuse shell | received: {readonly:?}"
    );
}

/// `readonly` grants `library` and refuses `fsWrite`, so every catalog
/// method that writes files must name `fsWrite` too — listing only
/// `library` or `checkpoints` would let the "no writes" profile write.
#[test]
fn every_library_and_snapshot_writer_declares_fs_write() {
    for method in [
        "library.apply",
        "library.remove",
        "library.undo",
        "snapshot.revert",
    ] {
        let capabilities = declared(method);
        assert!(
            capabilities.contains(&"fsWrite"),
            "expected {method} capabilities to contain fsWrite | received: {capabilities:?}"
        );
    }
    let readonly = consent_preset(ManifestProfile::Readonly);
    assert!(
        readonly.is_granted("library") && !readonly.is_granted("fsWrite"),
        "expected readonly to grant library and refuse fsWrite | received: {readonly:?}"
    );
}
