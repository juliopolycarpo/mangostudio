//! Named fakes and small helpers shared by this crate's integration tests.
//!
//! Each `tests/*.rs` binary compiles this module separately and only uses
//! part of it, so an unused item or import here is expected rather than a
//! mistake — mirrors `crates/mango-protocol/tests/support/mod.rs`.
#![allow(dead_code, unused_imports)]

use std::future::Future;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use mango_protocol::contract::Contract;
use mango_protocol::frame::PeerInfo;
use mango_protocol::port::port_pair;
use mango_protocol::session::{Session, SessionOptions};
use mangostudio_runtime::ports::authorization::Authorization;
use mangostudio_runtime::registry::Registry;
use mangostudio_runtime_contract::catalog::catalog;
use serde_json::{Value, json};

pub mod collecting_log;
pub mod granting_authorization;
pub mod panicking_audit;
pub mod panicking_authorization;
pub mod partially_granting_authorization;
pub mod recording_audit;

// The library's own `#[cfg(test)] mod test_support` is invisible here: an
// integration test binary links the library compiled *without* `cfg(test)`,
// so this includes the same source file by path instead of reaching for
// `mangostudio_runtime::test_support` (which does not exist in that build).
#[path = "../../src/test_support.rs"]
pub mod scratch;

pub use collecting_log::CollectingLog;
pub use granting_authorization::GrantingAuthorization;
pub use panicking_audit::PanickingAudit;
pub use panicking_authorization::PanickingAuthorization;
pub use partially_granting_authorization::PartiallyGrantingAuthorization;
pub use recording_audit::RecordingAudit;

/// Bounds a future so a regression that hangs (rather than fails) still ends
/// the test run. Mirrors `crates/mango-protocol/tests/support/mod.rs::within`.
pub async fn within<T>(what: &str, future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(5), future)
        .await
        .unwrap_or_else(|_| panic!("expected {what} to resolve within 5s; it did not"))
}

/// A `PeerInfo` for a test session under `role` ("hub" or "runtime").
pub fn peer(role: &str) -> PeerInfo {
    PeerInfo {
        name: format!("test-{role}"),
        version: "0.0.0".to_string(),
        role: role.to_string(),
    }
}

/// Opens two in-process sessions over a [`port_pair`] and waits for both
/// handshakes, so a test can register handlers on `runtime` and issue
/// requests from `hub` without repeating the handshake boilerplate.
pub async fn open_pair() -> (Session, Session) {
    let (port_a, port_b) = port_pair();
    let (hub, _driver_a) = Session::spawn(port_a, SessionOptions::new(peer("hub")));
    let (runtime, _driver_b) = Session::spawn(port_b, SessionOptions::new(peer("runtime")));
    within("hub's ready()", hub.ready())
        .await
        .expect("handshake succeeds");
    within("runtime's ready()", runtime.ready())
        .await
        .expect("handshake succeeds");
    (hub, runtime)
}

/// The embedded catalog compiled once per test binary, rather than once per
/// test.
static CONTRACT: LazyLock<Contract> = LazyLock::new(|| {
    Contract::from_catalog(catalog().clone()).expect("the embedded catalog compiles")
});

/// [`open_pair`], then serves `registry` on the runtime side behind
/// `authorization` as the `host` slot, so a test can go straight to issuing
/// requests from the returned hub.
pub async fn serve_pair(
    registry: Registry,
    authorization: Arc<dyn Authorization>,
) -> (Session, Session) {
    let (hub, runtime) = open_pair().await;
    mangostudio_runtime::serve::serve(&CONTRACT, &runtime, registry, authorization, "host")
        .expect("every method a test registry implements is declared by the catalog")
        .persist();
    (hub, runtime)
}

/// A minimal, schema-valid `runtime.health` result — `runtime.health` is the
/// only catalog method with no declared capabilities, which makes it the
/// method every test that needs "any zero-capability method with a real
/// result schema" reaches for.
pub fn health_result() -> Value {
    json!({
        "schemaVersion": 1,
        "slot": "host",
        "source": "bundled",
        "runtimeVersion": "0.0.0",
        "version": null,
        "binaryPath": null,
        "digest": null,
        "profile": "none",
        "allow": {
            "fsRead": false, "fsWrite": false, "shell": false, "git": false,
            "probing": false, "mcp": false, "library": false, "checkpoints": false,
            "update": false,
        },
        "setup": { "state": "pending" },
        "platform": "linux",
        "arch": "x86_64",
        "homeDir": "/home/mango",
        "shells": [],
        "git": { "available": false },
        "lastError": null,
    })
}
