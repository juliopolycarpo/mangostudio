//! Named fakes and small helpers shared by this crate's integration tests.
//!
//! Each `tests/*.rs` binary compiles this module separately and only uses
//! part of it, so an unused item or import here is expected rather than a
//! mistake — mirrors `crates/mango-protocol/tests/support/mod.rs`.
#![allow(dead_code, unused_imports)]

use std::future::Future;
use std::time::Duration;

use mango_protocol::frame::PeerInfo;
use mango_protocol::port::port_pair;
use mango_protocol::session::{Session, SessionOptions};
use serde_json::{Value, json};

pub mod panicking_audit;
pub mod recording_audit;

pub use panicking_audit::PanickingAudit;
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
