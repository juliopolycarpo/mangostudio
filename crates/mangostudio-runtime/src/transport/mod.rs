//! The three CLI transport entry points: [`stdio`], [`serve`], and
//! [`connect`].
//!
//! Each mirrors one `apps/runtime/src` module (`cli.ts`'s `serveStdio`,
//! `serve.ts`, `connect.ts`) and wires the same building blocks —
//! [`crate::registry::Registry`], [`crate::consent`], [`crate::serve::serve`]
//! — onto one of `mango_protocol`'s transports. See [`crate::supervisor`]
//! for the ownership and state-transition model all three share, and this
//! module's own [`runtime_peer`]/`build_host` for what they share
//! literally.
//!
//! Out of scope for every transport here, matching the crate's own current
//! scope: no machine method groups (an empty [`crate::registry::Registry`]
//! answers every catalog method with `METHOD_UNSUPPORTED`), so
//! `hello.capabilities` is left empty rather than wired to
//! [`crate::manifest::build_features`] — there is nothing yet for that
//! manifest to describe.

pub mod connect;
pub mod serve;
pub mod stdio;

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use mango_protocol::frame::PeerInfo;
use mango_protocol::session::{EventInput, Session};
use tokio_util::sync::CancellationToken;

use crate::consent::authorization::ConsentAuthorization;
use crate::consent::source::ConsentSource;
use crate::ports::audit::Audit;
use crate::ports::authorization::Authorization;
use crate::ports::clock::SystemClock;
use crate::ports::wall_clock::{SystemWallClock, format_iso8601_millis};
use crate::registry::Registry;
use crate::runtime_home::{RuntimeSlot, slot_audit_log_path};

/// This binary's role on the wire, announced in every `hello`.
pub const RUNTIME_PEER_ROLE: &str = "runtime";
/// This binary's name on the wire, announced in every `hello`.
pub const RUNTIME_PEER_NAME: &str = "mangostudio-runtime";

/// The event topic `serve` and `connect` both publish their keep-alive on.
///
/// Mirrors `apps/shared/src/runtime-contract/events.ts`'s
/// `RUNTIME_HEARTBEAT_TOPIC` (`"runtime.heartbeat"`) — hand-typed rather than
/// imported from `mangostudio_runtime_contract::strings`, because that
/// module mirrors only `strings.json` (generated from `strings.ts`); the
/// event-topic contract lives in a sibling TypeScript file with no Rust
/// mirror of its own yet. Whoever gives `mangostudio-runtime-contract` a
/// generated home for event topics should replace this literal with it,
/// the same way every runtime-home name already goes through
/// `mangostudio_runtime_contract::strings::runtime_home`.
pub(crate) const RUNTIME_HEARTBEAT_TOPIC: &str = "runtime.heartbeat";

/// Constant-time bearer-token comparison, mirroring `serve.ts`'s
/// `tokensEqual` (`Buffer` lengths compared first — Node's own
/// `timingSafeEqual` throws on a length mismatch rather than timing it —
/// then a constant-time byte comparison of the equal-length remainder).
///
/// # Example
///
/// ```
/// use mangostudio_runtime::transport::tokens_equal;
///
/// assert!(tokens_equal(b"s3cret", b"s3cret"));
/// assert!(!tokens_equal(b"s3cret", b"wrong!"));
/// assert!(!tokens_equal(b"short", b"a-longer-token"));
/// ```
#[must_use]
pub fn tokens_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (a, b) in left.iter().zip(right.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

/// Builds the `hello` identity every transport announces.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::transport::runtime_peer;
///
/// let peer = runtime_peer("0.1.1");
/// assert_eq!(peer.role, "runtime");
/// assert_eq!(peer.name, "mangostudio-runtime");
/// assert_eq!(peer.version, "0.1.1");
/// ```
#[must_use]
pub fn runtime_peer(runtime_version: &str) -> PeerInfo {
    PeerInfo {
        name: RUNTIME_PEER_NAME.to_string(),
        version: runtime_version.to_string(),
        role: RUNTIME_PEER_ROLE.to_string(),
    }
}

/// One connection's worth of what [`crate::serve::serve`] needs beyond the
/// session itself: an empty [`Registry`] (methods are out of scope; the
/// catalog's `rpc.discover` answer and `METHOD_UNSUPPORTED` are all this
/// serves) recording through a real, on-disk [`crate::audit::FileAudit`],
/// and the real [`ConsentAuthorization`] reading `slot`'s `runtime.json`
/// fresh on every call.
///
/// A fresh [`Registry`] every time, never shared across connections:
/// [`Registry::into_contract_handlers`] consumes it, matching one call to
/// [`crate::serve::serve`] per session — a reconnect (`connect`'s redial, a
/// new hub connection superseding the old one in `serve`) builds a new one,
/// mirroring `apps/runtime/src/session.ts`'s `createRuntimeSession`, which
/// takes a fresh `RuntimeHostDefinition` per call for the same reason.
pub(crate) struct SessionHost {
    pub registry: Registry,
    pub authorization: Arc<dyn Authorization>,
}

/// Builds one [`SessionHost`] for `slot` under `mango_home`.
pub(crate) fn build_host(slot: RuntimeSlot, mango_home: &Path) -> SessionHost {
    let audit: Arc<dyn Audit> = Arc::new(crate::audit::FileAudit::new(
        slot_audit_log_path(slot, mango_home),
        Arc::new(SystemWallClock),
    ));
    let registry = Registry::with_ports(Arc::clone(&audit), Arc::new(SystemClock));
    let source = ConsentSource::new(slot, mango_home.to_path_buf());
    let authorization: Arc<dyn Authorization> = Arc::new(ConsentAuthorization::new(source));
    SessionHost {
        registry,
        authorization,
    }
}

/// Publishes [`RUNTIME_HEARTBEAT_TOPIC`] on `interval`, until `cancel`
/// fires. Shared by `serve` and `connect` — both publish the identical
/// event, at the identical cadence, and stop it the identical way (from
/// their own owned scope, before that scope awaits the session's driver a
/// second time; never a detached, fire-and-forget timer).
pub(crate) async fn heartbeat_loop(
    session: Session,
    interval: Duration,
    cancel: CancellationToken,
) {
    let mut ticks = tokio::time::interval(interval);
    // The first tick fires immediately; consumed so the beat below waits a
    // full interval before the first one goes out.
    ticks.tick().await;
    loop {
        tokio::select! {
            biased;
            () = cancel.cancelled() => return,
            _ = ticks.tick() => {
                let _ = session.emit(EventInput {
                    topic: RUNTIME_HEARTBEAT_TOPIC.to_string(),
                    payload: serde_json::json!({ "at": format_iso8601_millis(std::time::SystemTime::now()) }),
                    stream_id: None,
                    end: false,
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{RUNTIME_PEER_NAME, RUNTIME_PEER_ROLE, build_host, runtime_peer};
    use crate::runtime_home::RuntimeSlot;

    #[test]
    fn runtime_peer_announces_the_fixed_name_and_role_with_the_given_version() {
        let peer = runtime_peer("9.9.9");
        assert_eq!(peer.name, RUNTIME_PEER_NAME);
        assert_eq!(peer.role, RUNTIME_PEER_ROLE);
        assert_eq!(peer.version, "9.9.9");
    }

    #[test]
    fn build_host_produces_an_empty_registry_every_call() {
        let home = std::env::temp_dir().join(format!(
            "mango-transport-build-host-test-{}-{}",
            std::process::id(),
            line!()
        ));
        let host = build_host(RuntimeSlot::Host, &home);
        assert!(host.registry.implemented_methods().is_empty());
    }
}
