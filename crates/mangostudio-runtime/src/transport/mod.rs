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
//! scope: every machine method group except `runtime.health` (see
//! [`crate::health`]), `workspace.*` (see [`crate::workspace_methods`]),
//! `probing.*` (see [`crate::probing`]), and `fs.*` (see
//! [`crate::filesystem`]) is unimplemented, so
//! [`crate::registry::Registry`] answers everything else with
//! `METHOD_UNSUPPORTED`. `hello.capabilities` is wired to this
//! module's own `hello_capabilities`, which shapes `crate::health`'s
//! `build_capability_manifest` into the `Map` `hello` carries — without it, a
//! hub refuses every
//! connection outright (`manifestOf` in `hub-session.ts` closes with
//! `PROTOCOL_ERROR` on an empty object), so this is not optional scaffolding
//! for a later plan the way the rest of this module's method-group gap is.

pub mod connect;
pub mod serve;
pub mod stdio;

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use mango_protocol::contract::Contract;
use mango_protocol::frame::PeerInfo;
use mango_protocol::port::Port;
use mango_protocol::session::{EventInput, Session, SessionClosure, SessionOptions};
use tokio_util::sync::CancellationToken;

use crate::consent::authorization::ConsentAuthorization;
use crate::consent::source::ConsentSource;
use crate::ports::audit::Audit;
use crate::ports::authorization::Authorization;
use crate::ports::clock::SystemClock;
use crate::ports::wall_clock::{SystemWallClock, epoch_millis};
use crate::registry::Registry;
use crate::runtime_home::{RuntimeSlot, slot_audit_log_path};

/// This binary's role on the wire, announced in every `hello`.
pub const RUNTIME_PEER_ROLE: &str = "runtime";
/// This binary's name on the wire, announced in every `hello`.
pub const RUNTIME_PEER_NAME: &str = "mangostudio-runtime";

/// The event topic `serve` and `connect` both publish their keep-alive on.
///
/// Taken from the embedded catalog rather than hand-typed a second time:
/// [`mangostudio_runtime_contract::catalog::RUNTIME_HEARTBEAT_TOPIC`] is
/// itself checked against `catalog.json` by that crate's own test, so this
/// re-export can never drift from the topic the contract actually declares.
pub(crate) use mangostudio_runtime_contract::catalog::RUNTIME_HEARTBEAT_TOPIC;

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
/// session itself: a [`Registry`] implementing `runtime.health`, the
/// `workspace.*`, `probing.*`, and `fs.*` methods (see [`build_host`]
/// for the full list; every other machine method group is out of scope, and
/// the catalog's `rpc.discover` answer plus `METHOD_UNSUPPORTED` cover the
/// rest) recording through a real, on-disk [`crate::audit::FileAudit`],
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

/// Builds one [`SessionHost`] for `slot` under `mango_home`, announcing
/// `runtime_version` from `runtime.health`, and also implementing
/// `workspace.browse`, `workspace.validate`, `workspace.resolve-contained`,
/// `probing.runtimes`/`probing.version-managers`/`probing.agent-clis`,
/// and the eleven filesystem methods. Other groups remain unsupported.
///
/// Calls [`Registry::with_ports`], not
/// [`Registry::with_ports_and_exclusivity`], so every connection this
/// builds enforces [`crate::ports::exclusivity::NoExclusivity`] — not
/// [`crate::ports::exclusivity::UpdateExclusivityTracker`]. That is correct
/// *today* only because no `runtime.update.*` method exists yet, so there
/// is nothing for update-versus-ordinary exclusivity to serialise; it is a
/// gap left by scope, not a considered choice to leave update calls
/// unserialised. Whichever change implements `runtime.update.*` must switch
/// this call to [`Registry::with_ports_and_exclusivity`] with a real
/// [`crate::ports::exclusivity::UpdateExclusivityTracker`] in the same
/// change that adds the first update handler — and must keep typed parameter
/// decoding inside [`Registry::implement`]'s wrapper, so its cleanup runs on
/// a decode failure or a `Deserialize` panic — not as a follow-up, since a
/// registry that implements an update method without that tracker installed
/// is exactly the unguarded state this comment exists to prevent shipping
/// unnoticed.
pub(crate) fn build_host(
    slot: RuntimeSlot,
    mango_home: &Path,
    runtime_version: &str,
) -> SessionHost {
    let audit: Arc<dyn Audit> = Arc::new(crate::audit::FileAudit::new(
        slot_audit_log_path(slot, mango_home),
        Arc::new(SystemWallClock),
    ));
    let registry = Registry::with_ports(Arc::clone(&audit), Arc::new(SystemClock));
    let registry = crate::health::register(
        registry,
        slot,
        mango_home.to_path_buf(),
        runtime_version.to_string(),
    );
    let registry = crate::workspace_methods::register(registry);
    let registry = crate::probing::register(registry);
    let source = ConsentSource::new(slot, mango_home.to_path_buf());
    let registry =
        crate::filesystem::register(registry, ConsentSource::new(slot, mango_home.to_path_buf()));
    let authorization: Arc<dyn Authorization> = Arc::new(ConsentAuthorization::new(source));
    SessionHost {
        registry,
        authorization,
    }
}

/// [`crate::health::build_capability_manifest`], shaped as the `Map`
/// [`mango_protocol::session::SessionOptions::with_capabilities`] wants.
///
/// `registry` is `host.registry` from the very [`SessionHost`] this
/// session is about to serve: [`crate::manifest::build_features`] gates
/// each feature on whether *this* registry actually implements every
/// method that capability requires, so a manifest built against any other
/// registry could announce a feature this connection cannot back.
pub(crate) async fn hello_capabilities(
    slot: RuntimeSlot,
    mango_home: &Path,
    registry: &Registry,
    cancel: &CancellationToken,
) -> serde_json::Map<String, serde_json::Value> {
    let manifest =
        crate::health::build_capability_manifest(slot, mango_home, registry, cancel).await;
    match serde_json::to_value(&manifest) {
        Ok(serde_json::Value::Object(mut map)) => {
            let catalog = mangostudio_runtime_contract::catalog::catalog();
            map.insert(
                "contracts".to_owned(),
                serde_json::json!({ &catalog.name: &catalog.version }),
            );
            map
        }
        // `RuntimeCapabilityManifest` derives `Serialize` on a plain struct
        // and always serialises to an object — this arm is unreachable
        // today. Deliberately `unreachable!`, not a silent `Map::new()`:
        // the empty map that fallback produced is *exactly* the shape
        // that made every hub refuse this connection before
        // `hello_capabilities` existed (see this module's own doc comment
        // on why an empty `hello.capabilities` is a `PROTOCOL_ERROR`, not
        // a degraded-but-working connection) — silently reinstating that
        // failure with no diagnostic would be worse than panicking loudly
        // on the one change to this type that could ever reach it.
        Ok(other) => {
            unreachable!("RuntimeCapabilityManifest must serialise to a JSON object, got {other:?}")
        }
        Err(error) => unreachable!("RuntimeCapabilityManifest must always serialise: {error}"),
    }
}

/// Publishes [`RUNTIME_HEARTBEAT_TOPIC`] on `interval`, until `cancel`
/// fires. Shared by `serve` and `connect` — both publish the identical
/// event, at the identical cadence, and stop it the identical way (from
/// their own owned scope, before that scope awaits the session's driver a
/// second time; never a detached, fire-and-forget timer).
///
/// `at` is [`epoch_millis`], an integer — matching `runtime.heartbeat`'s
/// declared schema (`{ "type": "integer" }`) and `serve.ts`'s own
/// `Date.now()`, not [`crate::ports::wall_clock::format_iso8601_millis`]'s
/// string. Every payload goes
/// through [`crate::event_check::checked_emit`] rather than
/// [`Session::emit`] directly, so a future drift back to the wrong shape
/// fails this loop's own log instead of reaching a hub that validates
/// events — which is exactly the check this crate lacked when it shipped
/// the string in the first place.
pub(crate) async fn heartbeat_loop(
    session: Session,
    interval: Duration,
    cancel: CancellationToken,
    log: impl Fn(&str),
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
                let input = EventInput {
                    topic: RUNTIME_HEARTBEAT_TOPIC.to_string(),
                    payload: serde_json::json!({ "at": epoch_millis(std::time::SystemTime::now()) }),
                    stream_id: None,
                    end: false,
                };
                if let Err(error) = crate::event_check::checked_emit(&session, input) {
                    log(&format!("heartbeat payload rejected by its own contract: {error}"));
                }
            }
        }
    }
}

/// Opens a session over `port`, registers `registry`'s contract handlers on
/// it, and only then spawns its driver — in that order, always. Shared by
/// all three transports (`stdio::run`, `serve::handle_connection`,
/// `connect::run_one_connection`), which used to each write this sequence
/// out by hand; this repository's own rule against duplicating shared logic
/// covers exactly this shape.
///
/// The ordering is load-bearing, not stylistic: [`Session::open`] never
/// starts the returned driver on its own, so nothing can poll it — and so
/// nothing can dispatch a single incoming frame — before this function's
/// own `tokio::spawn` call, several lines *after* [`crate::serve::serve`]
/// has already registered every handler `contract` declares. The bug this
/// closes used the opposite order (`Session::spawn`, which starts the
/// driver the instant it returns): a hub that sent its first request
/// immediately after the handshake could race ahead of registration and
/// see `METHOD_UNSUPPORTED` for a method the peer genuinely implements —
/// observed reliably across the real qualification suite's `serve` and
/// `connect` transports
/// (`apps/api/tests/integration/services/rust-runtime-qualification.integration.test.ts`
/// and its `-connect` sibling) before this fix, and not reproduced since.
/// It is not independently covered by a Rust-level unit test in this
/// crate: a from-scratch reproduction attempt using a real `Session` over
/// a real TCP loopback pair, matching the shape of `mango_protocol`'s
/// existing session tests, did not reproduce the race against the
/// pre-fix ordering under either the default (current-thread) or a
/// `multi_thread` `#[tokio::test]` runtime — the window is narrow enough
/// that only the real, cross-process latency the qualification suite's
/// own separate hub and runtime processes introduce made it observable.
/// The ordering here is correct by construction (no `.await` point exists
/// between `Session::open` and the `tokio::spawn` call below that could
/// let anything else run in between), which is what this function's own
/// structure — not a dynamic test — is what actually proves it.
pub(crate) fn start_session<P: Port>(
    port: P,
    options: SessionOptions,
    contract: &Contract,
    registry: Registry,
    authorization: Arc<dyn Authorization>,
    slot: &str,
) -> (Session, tokio::task::JoinHandle<SessionClosure>) {
    let (session, driver) = Session::open(port, options);
    let guard = crate::serve::serve(contract, &session, registry, authorization, slot)
        .expect("Registry::implement already panics on a catalog mismatch at registration time");
    guard.persist();
    let driver_handle = tokio::spawn(driver.run());
    (session, driver_handle)
}

#[cfg(test)]
mod tests {
    use mango_protocol::frame::PeerInfo;
    use mango_protocol::port::port_pair;
    use mango_protocol::session::{Session, SessionOptions};
    use tokio_util::sync::CancellationToken;

    use super::{
        RUNTIME_HEARTBEAT_TOPIC, RUNTIME_PEER_NAME, RUNTIME_PEER_ROLE, build_host, heartbeat_loop,
        runtime_peer,
    };
    use crate::runtime_home::RuntimeSlot;
    use crate::test_support::scratch_path;

    fn peer(role: &str) -> PeerInfo {
        PeerInfo {
            name: "test".into(),
            version: "0.0.0".into(),
            role: role.into(),
        }
    }

    /// The heartbeat's only two real behaviours: it actually publishes on
    /// its own cadence (not just "the function returns without panicking"),
    /// and it actually stops when cancelled — the two things this crate's
    /// declared `tokio` `test-util` dev-dependency exists for and, before
    /// this test, was never once used (no `pause`, `advance`, or
    /// `start_paused` anywhere in the crate).
    #[tokio::test(start_paused = true)]
    async fn publishes_on_its_own_cadence_and_stops_on_cancel() {
        let (a, b) = port_pair();
        let (publisher, _driver_a) = Session::spawn(a, SessionOptions::new(peer("runtime")));
        let (subscriber, _driver_b) = Session::spawn(b, SessionOptions::new(peer("hub")));
        publisher
            .ready()
            .await
            .expect("the in-memory pair handshakes");
        let mut events = subscriber.events();

        let cancel = CancellationToken::new();
        let interval = std::time::Duration::from_secs(60);
        let log = |message: &str| panic!("the heartbeat must never need to log: {message}");
        let heartbeat = tokio::spawn(heartbeat_loop(
            publisher.clone(),
            interval,
            cancel.clone(),
            log,
        ));

        // No beat before the first full interval: the loop consumes the
        // interval's own immediate first tick so a freshly connected
        // subscriber never sees seq 0 before it had a chance to look.
        tokio::time::advance(interval / 2).await;
        // Drain the executor before checking: a spawned task only gets to
        // run when this task yields, and `mango_protocol`'s own driver needs
        // its own turns to forward anything the heartbeat task already
        // emitted — a single zero-duration `timeout` is not guaranteed to
        // give both enough turns, so an early, wrongly-timed emission could
        // otherwise sit unobserved in a queue this check never looks past.
        for _ in 0..32 {
            tokio::task::yield_now().await;
        }
        assert!(
            tokio::time::timeout(std::time::Duration::ZERO, events.recv())
                .await
                .is_err(),
            "no heartbeat before a full interval has elapsed"
        );

        tokio::time::advance(interval / 2 + std::time::Duration::from_millis(1)).await;
        // A bound wider than `interval`, not narrower: paused time's
        // auto-advance jumps to the *nearest* pending timer once nothing
        // else is ready, and the heartbeat's own next tick is a real,
        // still-pending timer at this point (advancing partway through the
        // interval does not itself fire it — only genuine idleness inside
        // an unbounded wait does). A timeout shorter than `interval` — five
        // seconds was tried — is nearer than that tick and wins the jump
        // every time, elapsing before the tick that would have delivered
        // the event ever gets to fire; measured directly by injecting the
        // string-payload regression below, which this bound must catch
        // through a rejection, not through starving the tick that would
        // otherwise have proven it fixed.
        let first = tokio::time::timeout(interval * 2, events.recv())
            .await
            .expect("a heartbeat must actually be sent, not silently dropped")
            .expect("the publisher session is still open");
        assert_eq!(first.topic, RUNTIME_HEARTBEAT_TOPIC);
        // The regression this guards: `at` shipped as an ISO-8601 string
        // once, against a schema that declares it an integer — an assertion
        // that only checks "an event was emitted" cannot see that mismatch
        // at all.
        assert!(
            first.payload["at"].is_u64(),
            "\"at\" must be an integer (epoch milliseconds), not {:?}",
            first.payload["at"]
        );

        tokio::time::advance(interval).await;
        let second = tokio::time::timeout(interval * 2, events.recv())
            .await
            .expect("a second heartbeat must actually be sent, not silently dropped")
            .expect("the publisher session is still open");
        assert_eq!(second.topic, RUNTIME_HEARTBEAT_TOPIC);
        assert_eq!(
            second.seq,
            first.seq + 1,
            "two distinct beats, not the same one observed twice"
        );
        // Exactly two so far, not a third already queued behind them (a
        // per-tick double-publish would still satisfy the two checks above,
        // since the second event of a duplicated pair is also `first.seq + 1`
        // — only a count check catches that).
        for _ in 0..32 {
            tokio::task::yield_now().await;
        }
        assert!(
            tokio::time::timeout(std::time::Duration::ZERO, events.recv())
                .await
                .is_err(),
            "exactly two heartbeats after two intervals, not a third already queued"
        );

        cancel.cancel();
        // A bounded wait, not a bare `.await`: paused time auto-advances
        // once every ready task is stalled on a timer, so a loop that
        // ignored cancellation entirely would otherwise race its own 60 s
        // tick against this timeout rather than hang the test outright —
        // this keeps that race decisively in the timeout's favour.
        tokio::time::timeout(std::time::Duration::from_secs(5), heartbeat)
            .await
            .expect("cancellation must stop the loop promptly, not leave it running")
            .expect("the loop must return on cancellation, never panic or hang");

        // Advancing further must publish nothing else: the loop already
        // returned, not merely stopped ticking for one interval.
        tokio::time::advance(interval * 3).await;
        assert!(
            tokio::time::timeout(std::time::Duration::ZERO, events.recv())
                .await
                .is_err(),
            "no further heartbeat once the loop has been cancelled"
        );
    }

    #[tokio::test]
    async fn hello_announces_the_embedded_runtime_contract_version() {
        let home = crate::test_support::scratch_dir("transport-contract-metadata");
        let host = build_host(RuntimeSlot::Host, &home, "9.9.9");
        let capabilities = super::hello_capabilities(
            RuntimeSlot::Host,
            &home,
            &host.registry,
            &CancellationToken::new(),
        )
        .await;
        let catalog = mangostudio_runtime_contract::catalog::catalog();
        assert_eq!(
            capabilities.get("contracts"),
            Some(&serde_json::json!({ &catalog.name: &catalog.version }))
        );
        assert_eq!(capabilities["enforcesPathPolicy"], true);
    }

    #[test]
    fn runtime_peer_announces_the_fixed_name_and_role_with_the_given_version() {
        let peer = runtime_peer("9.9.9");
        assert_eq!(peer.name, RUNTIME_PEER_NAME);
        assert_eq!(peer.role, RUNTIME_PEER_ROLE);
        assert_eq!(peer.version, "9.9.9");
    }

    #[test]
    fn build_host_implements_exactly_health_workspace_probing_and_filesystem() {
        let home = scratch_path("transport-build-host");
        let host = build_host(RuntimeSlot::Host, &home, "9.9.9");
        assert_eq!(
            host.registry.implemented_methods(),
            vec![
                "fs.apply-patch",
                "fs.create-file",
                "fs.delete-file",
                "fs.edit-file",
                "fs.glob",
                "fs.grep",
                "fs.list-directory",
                "fs.move-file",
                "fs.read-file",
                "fs.replace-range",
                "fs.write-file",
                "probing.agent-clis",
                "probing.runtimes",
                "probing.version-managers",
                "runtime.health",
                "workspace.browse",
                "workspace.resolve-contained",
                "workspace.validate",
            ],
            "nothing else must be implemented yet"
        );
    }
}
