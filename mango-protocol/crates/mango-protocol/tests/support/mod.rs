//! Named fakes shared by the session and contract integration tests.
//!
//! Each `tests/*.rs` binary compiles this module separately and only uses
//! part of it, so an unused item or import here is expected rather than a
//! mistake.
#![allow(dead_code, unused_imports)]

use std::future::Future;
use std::time::Duration;

pub mod raw_peer;
pub mod recording_guard;
pub mod refusing_port;
pub mod scripted_port;

pub use raw_peer::RawPeer;
pub use recording_guard::RecordingGuard;
pub use refusing_port::RefusingPort;
pub use scripted_port::ScriptedPort;

/// Bounds a future so a regression that hangs (rather than fails) still ends
/// the test run instead of burning the CI timeout across every OS in the
/// matrix. Cooperates with `#[tokio::test(start_paused = true)]`: the timeout
/// itself is a timer, so it participates in that runtime's auto-advance.
pub async fn within<T>(what: &str, future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(5), future)
        .await
        .unwrap_or_else(|_| panic!("expected {what} to resolve within 5s; it did not"))
}
