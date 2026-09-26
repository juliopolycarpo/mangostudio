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
//! Implemented method families include `runtime.health`, `workspace.*`,
//! `probing.*`, `fs.*`, `snapshot.*`, command, terminal, MCP, install, and
//! `runtime.update.*`. [`crate::registry::Registry`] answers other methods with
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
mod upgrade_head;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use mango_protocol::contract::Contract;
use mango_protocol::frame::Frame;
use mango_protocol::frame::PeerInfo;
use mango_protocol::port::{Port, PortTx, SendOutcome};
use mango_protocol::session::{EventInput, Session, SessionClosure, SessionOptions};
use mangostudio_runtime_contract::catalog::catalog;
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
/// `workspace.*`, `probing.*`, `fs.*`, `snapshot.*`, `terminal.*`, `mcp.*`,
/// `install.*`, and `runtime.update.*` methods (see [`build_host`]
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
    pub update: crate::update::UpdateBinding,
}

/// Builds one [`SessionHost`] for `slot` under `mango_home`, announcing
/// `runtime_version` from `runtime.health`, and also implementing
/// `workspace.browse`, `workspace.validate`, `workspace.resolve-contained`,
/// `probing.runtimes`/`probing.version-managers`/`probing.agent-clis`, the
/// eleven filesystem methods, three snapshot methods, eight terminal methods, the nine MCP
/// methods, the two install methods, and the three runtime update methods.
/// Other groups remain unsupported. Every connection shares the slot's update
/// exclusivity tracker; its request claims use a connection-specific namespace.
// Every transport builds through `build_host_with_restart`; the tests keep
// this unsupervised shorthand.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn build_host(
    slot: RuntimeSlot,
    mango_home: &Path,
    runtime_version: &str,
) -> SessionHost {
    build_host_with_restart(
        slot,
        mango_home,
        runtime_version,
        &UpdateRestart::unsupervised(),
    )
}

/// Whether a committed runtime update ends this process for its supervisor
/// to relaunch `current`: true when `executable` sits in one of
/// `mango_home`'s runtime slots, whatever the transport.
///
/// Mirrors the TypeScript runtime's `supervisedUpdateSession`, which every
/// transport (`--stdio`, `serve`, `connect`) consulted through
/// `resolveRuntimeSource() === 'provisioned'`. A provisioned binary is the
/// one a hub, `install`, or a user service launches through the slot's
/// `current` pointer, and every one of those relaunches on exit code 75:
/// the hub's stdio spawner, the systemd and launchd units, and the Scheduled
/// Task runner. A bundled binary has nothing to relaunch it and answers
/// `restart: "manual"` instead.
///
/// Usage: `update_restart_supervised(home, Some(&home.join("runtime/remote/1.0.0/mangostudio-runtime")))`
/// is `true`; the same call with `/usr/local/bin/mangostudio-runtime` is `false`.
pub(crate) fn update_restart_supervised(mango_home: &Path, executable: Option<&Path>) -> bool {
    crate::runtime_home::resolve_runtime_source(mango_home, executable) == "provisioned"
}

/// One process's answer to "a supervised update committed": every connection
/// the process builds a host for shares it, so a commit over any of them
/// ends the whole process, not just its own session.
///
/// Usage: `let restart = UpdateRestart::for_current_exe(home);` then pass
/// `&restart` to [`build_host_with_restart`] per connection and exit with
/// `RUNTIME_UPDATE_EXIT_CODE` once [`UpdateRestart::is_requested`].
#[derive(Clone)]
pub(crate) struct UpdateRestart {
    supervised: bool,
    requested: CancellationToken,
}

impl UpdateRestart {
    /// Decides supervision for this running executable; see
    /// [`update_restart_supervised`].
    pub(crate) fn for_current_exe(mango_home: &Path) -> Self {
        let executable = std::env::current_exe().ok();
        Self::new(update_restart_supervised(mango_home, executable.as_deref()))
    }

    /// A restart request that a commit fires only when `supervised`.
    pub(crate) fn new(supervised: bool) -> Self {
        Self {
            supervised,
            requested: CancellationToken::new(),
        }
    }

    /// A process nothing relaunches: commits answer `restart: "manual"`.
    pub(crate) fn unsupervised() -> Self {
        Self::new(false)
    }

    /// Whether a commit schedules a restart rather than asking for a manual one.
    pub(crate) fn supervised(&self) -> bool {
        self.supervised
    }

    /// Fires once a committed supervised update has had time to send its response.
    pub(crate) fn requested(&self) -> CancellationToken {
        self.requested.clone()
    }

    /// Whether a committed supervised update asked this process to exit.
    pub(crate) fn is_requested(&self) -> bool {
        self.requested.is_cancelled()
    }
}

/// Whether `slot` records protocol calls to `audit.log`, from its
/// `runtime.json` (`audit.enabled`, else the slot default: off for `host`,
/// on for the others).
///
/// Read once per process for each slot and home, then reused by every
/// connection this process builds a host for. That matches the TypeScript
/// runtime: `serve` and `connect` build their audit sink once at startup
/// (`slotAuditSink`) and share it across reconnections, and a stdio process
/// serves one session. `setup --audit on|off` therefore takes effect when
/// the runtime restarts, not mid-process.
///
/// Usage: `slot_audit_enabled(RuntimeSlot::Host, home)` is `false` on a
/// fresh home.
fn slot_audit_enabled(slot: RuntimeSlot, mango_home: &Path) -> bool {
    static RESOLVED: OnceLock<std::sync::Mutex<HashMap<(RuntimeSlot, PathBuf), bool>>> =
        OnceLock::new();
    let resolved = RESOLVED.get_or_init(Default::default);
    let key = (slot, mango_home.to_path_buf());
    if let Some(enabled) = crate::ports::audit::lock(resolved).get(&key) {
        return *enabled;
    }
    let stored = crate::runtime_home::read_runtime_slot_config(slot, mango_home).stored;
    let enabled =
        crate::consent::config::resolve_runtime_slot_config(slot, stored.as_ref(), "bundled")
            .audit
            .enabled;
    *crate::ports::audit::lock(resolved)
        .entry(key)
        .or_insert(enabled)
}

/// Builds a host whose verified update commit fires `restart` when it is
/// supervised, so the transport can end the process with exit code 75.
pub(crate) fn build_host_with_restart(
    slot: RuntimeSlot,
    mango_home: &Path,
    runtime_version: &str,
    restart: &UpdateRestart,
) -> SessionHost {
    let audit: Arc<dyn Audit> = if slot_audit_enabled(slot, mango_home) {
        Arc::new(crate::audit::FileAudit::new(
            slot_audit_log_path(slot, mango_home),
            Arc::new(SystemWallClock),
        ))
    } else {
        Arc::new(crate::ports::audit::NoopAudit)
    };
    let update = crate::update::UpdateBinding::sharing_restart(
        slot,
        mango_home.to_path_buf(),
        restart.supervised(),
        restart.requested(),
    );
    let exclusivity = update.exclusivity();
    let registry = Registry::with_ports_and_exclusivity(
        Arc::clone(&audit),
        Arc::new(SystemClock),
        exclusivity.clone(),
    );
    let external_agents = crate::external_agents::service::production_supervisor(
        slot,
        mango_home,
        runtime_version,
        ConsentSource::new(slot, mango_home.to_path_buf()),
    );
    let registry = crate::health::register(
        registry,
        slot,
        mango_home.to_path_buf(),
        runtime_version.to_string(),
        Some(Arc::clone(&external_agents)),
    );
    let registry = crate::workspace_methods::register(registry);
    let registry = crate::probing::register(registry);
    let source = ConsentSource::new(slot, mango_home.to_path_buf());
    let registry = crate::mcp::register(
        registry,
        runtime_version,
        ConsentSource::new(slot, mango_home.to_path_buf()),
    );
    let registry =
        crate::filesystem::register(registry, ConsentSource::new(slot, mango_home.to_path_buf()));
    let registry =
        crate::commands::register(registry, ConsentSource::new(slot, mango_home.to_path_buf()));
    let registry =
        crate::terminal::register(registry, ConsentSource::new(slot, mango_home.to_path_buf()));
    let registry =
        crate::library::register(registry, ConsentSource::new(slot, mango_home.to_path_buf()));
    let registry = crate::install::register(
        registry,
        ConsentSource::new(slot, mango_home.to_path_buf()),
        mango_home,
    );
    let registry = crate::external_agents::service::register(registry, external_agents);
    let registry = crate::update::register(registry, &update, exclusivity);
    // Last: its answer is the finished registry.
    let registry = crate::discovery::register(registry);
    let authorization: Arc<dyn Authorization> = Arc::new(ConsentAuthorization::new(source));
    SessionHost {
        registry,
        authorization,
        update,
    }
}

/// The embedded catalog compiled into a [`Contract`], once per process.
///
/// Every transport serves the same static catalog, so compiling it per
/// connection (every `serve` supersession, every `connect` redial) only
/// repeated the catalog validation and every schema compile.
fn runtime_contract() -> &'static Contract {
    static CONTRACT: OnceLock<Contract> = OnceLock::new();
    CONTRACT.get_or_init(|| {
        Contract::from_catalog(catalog().clone()).expect(
            "the embedded catalog compiles into a contract; a change to the catalog that broke \
             this would already fail mangostudio-runtime-contract's own build",
        )
    })
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
    registry: Registry,
    authorization: Arc<dyn Authorization>,
    update: crate::update::UpdateBinding,
    slot: &str,
) -> (Session, tokio::task::JoinHandle<SessionClosure>) {
    let answers = update.answer_watch();
    let port = AnswerReportingPort {
        inner: port,
        answers: answers.clone(),
    };
    let (session, driver) = Session::open(port, options);
    let guard = crate::serve::serve(runtime_contract(), &session, registry, authorization, slot)
        .expect("Registry::implement already panics on a catalog mismatch at registration time");
    guard.persist();
    let driver_handle = tokio::spawn(async move {
        let closure = driver.run().await;
        answers.session_ended();
        update.close().await;
        closure
    });
    (session, driver_handle)
}

/// A [`Port`] that tells the connection's [`crate::update::AnswerWatch`]
/// about every answer it has sent, so a supervised update restarts only after
/// the hub was sent its commit answer.
struct AnswerReportingPort<P> {
    inner: P,
    answers: crate::update::AnswerWatch,
}

impl<P: Port> Port for AnswerReportingPort<P> {
    type Tx = AnswerReportingTx<P::Tx>;
    type Rx = P::Rx;

    fn max_frame_bytes(&self) -> Option<usize> {
        self.inner.max_frame_bytes()
    }

    fn split(self) -> (Self::Tx, Self::Rx) {
        let (tx, rx) = self.inner.split();
        (
            AnswerReportingTx {
                inner: tx,
                answers: self.answers,
            },
            rx,
        )
    }
}

/// The send half of an [`AnswerReportingPort`].
struct AnswerReportingTx<Tx> {
    inner: Tx,
    answers: crate::update::AnswerWatch,
}

impl<Tx: PortTx> PortTx for AnswerReportingTx<Tx> {
    async fn send(&mut self, frame: Frame) -> SendOutcome {
        let answered = match &frame {
            Frame::Res(response) => Some(response.id.clone()),
            Frame::Err(response) => Some(response.id.clone()),
            _ => None,
        };
        let outcome = self.inner.send(frame).await;
        if let Some(id) = answered {
            self.answers.answered(&id);
        }
        outcome
    }

    async fn close(self, code: u16, reason: Option<String>) {
        self.inner.close(code, reason).await;
    }
}

#[cfg(test)]
mod tests {
    use mango_protocol::frame::PeerInfo;
    use mango_protocol::port::port_pair;
    use mango_protocol::session::{Session, SessionOptions};
    use tokio_util::sync::CancellationToken;

    use super::{
        RUNTIME_HEARTBEAT_TOPIC, RUNTIME_PEER_NAME, RUNTIME_PEER_ROLE, build_host, heartbeat_loop,
        runtime_contract, runtime_peer, start_session,
    };
    use crate::runtime_home::RuntimeSlot;
    use crate::test_support::scratch_path;

    /// An audit sink that takes `delay` to record a commit: the work that
    /// still runs inside the handler task after the handler returned, before
    /// the session can queue the answer.
    struct SlowCommitAudit {
        delay: std::time::Duration,
    }

    impl crate::ports::audit::Audit for SlowCommitAudit {
        fn record<'a>(
            &'a self,
            entry: crate::ports::audit::AuditEntry,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
            Box::pin(async move {
                if entry.method == "runtime.update.commit" {
                    tokio::time::sleep(self.delay).await;
                }
            })
        }
    }

    /// Grants every call, so the test reaches the update methods.
    struct GrantsEverything;

    impl crate::ports::authorization::Authorization for GrantsEverything {
        fn missing_capabilities<'a>(
            &'a self,
            _method: &'a str,
            _capabilities: &'a [String],
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Vec<String>> + Send + 'a>> {
            Box::pin(async { Vec::new() })
        }
    }

    /// The restart a supervised commit asks for must not overtake its answer:
    /// the transport closes the session as soon as the restart fires, and a
    /// close that lands before the `res` is queued loses the answer the hub
    /// is waiting for. The audit record here holds the handler task for
    /// 300 ms after the commit itself, which is longer than any fixed delay
    /// the restart could have used.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_supervised_commit_answers_before_its_restart_closes_the_session() {
        use base64::Engine as _;
        use sha2::Digest as _;

        let home = scratch_path("transport-commit-before-restart");
        std::fs::create_dir_all(&*home).unwrap();
        let restart = super::UpdateRestart::new(true);
        let update = crate::update::UpdateBinding::sharing_restart(
            RuntimeSlot::Remote,
            home.to_path_buf(),
            true,
            restart.requested(),
        );
        // Not `update.exclusivity()`: that one also refuses while any blocking
        // work runs anywhere in this process, which parallel tests supply.
        let exclusivity: std::sync::Arc<dyn crate::ports::exclusivity::CallExclusivity> =
            std::sync::Arc::new(crate::ports::exclusivity::UpdateExclusivityTracker::new(
                std::sync::Arc::new(crate::ports::exclusivity::NotUpdating),
            ));
        let registry = crate::update::register(
            crate::registry::Registry::with_ports_and_exclusivity(
                std::sync::Arc::new(SlowCommitAudit {
                    delay: std::time::Duration::from_millis(300),
                }),
                std::sync::Arc::new(crate::ports::clock::SystemClock),
                exclusivity.clone(),
            ),
            &update,
            exclusivity,
        );
        let (hub_port, runtime_port) = port_pair();
        let (hub, _hub_driver) = Session::spawn(hub_port, SessionOptions::new(peer("hub")));
        let (runtime, _runtime_driver) = start_session(
            runtime_port,
            SessionOptions::new(runtime_peer("9.9.9")),
            registry,
            std::sync::Arc::new(GrantsEverything),
            update,
            RuntimeSlot::Remote.as_str(),
        );
        // What every transport does once the restart fires.
        let requested = restart.requested();
        let closing = runtime.clone();
        tokio::spawn(async move {
            requested.cancelled().await;
            closing.close_now(
                mango_protocol::close::close_codes::RELEASED,
                Some("Runtime update committed"),
            );
        });
        hub.ready().await.unwrap();

        let bytes = b"next runtime";
        let digest: String = sha2::Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let begun = hub
            .request(
                "runtime.update.begin",
                serde_json::json!({
                    "version": "9.9.10",
                    "digest": format!("sha256:{digest}"),
                    "totalBytes": bytes.len(),
                }),
            )
            .await
            .expect("begin is accepted");
        let session_id = begun["sessionId"].as_str().unwrap().to_owned();
        hub.request(
            "runtime.update.chunk",
            serde_json::json!({
                "sessionId": session_id,
                "seq": 0,
                "bytesBase64": base64::engine::general_purpose::STANDARD.encode(bytes),
            }),
        )
        .await
        .expect("chunk is accepted");
        let committed = hub
            .request(
                "runtime.update.commit",
                serde_json::json!({ "sessionId": session_id }),
            )
            .await;
        match committed {
            Ok(value) => assert_eq!(
                value["restart"], "scheduled",
                "expected commit restart: \"scheduled\" | received: {value}"
            ),
            Err(error) => {
                panic!("expected the commit answer before the restart close | received: {error:?}")
            }
        }
        let closure = tokio::time::timeout(std::time::Duration::from_secs(5), hub.closed())
            .await
            .expect("expected the restart to close the session after the answer");
        assert_eq!(
            closure.reason.as_deref(),
            Some("Runtime update committed"),
            "expected the restart close | received: {closure:?}"
        );
        assert!(restart.is_requested());
    }

    /// `serve` and `connect` must decide supervision the way `--stdio` does:
    /// the TypeScript runtime scheduled the restart in every transport for a
    /// binary launched from a slot, and a hub waits for it.
    #[test]
    fn a_slot_binary_is_supervised_and_a_bundled_one_is_not() {
        let home = std::path::Path::new("/home/ada/.mango");
        for slot in ["remote", "host", "wsl"] {
            let binary = home
                .join("runtime")
                .join(slot)
                .join("0.1.1")
                .join("mangostudio-runtime");
            assert!(
                super::update_restart_supervised(home, Some(&binary)),
                "expected supervised: true | received: false for {}",
                binary.display()
            );
        }
        for binary in [
            Some(std::path::Path::new("/usr/local/bin/mangostudio-runtime")),
            Some(std::path::Path::new(
                "/home/ada/.mango-other/runtime/remote/0.1.1/x",
            )),
            None,
        ] {
            assert!(
                !super::update_restart_supervised(home, binary),
                "expected supervised: false | received: true for {binary:?}"
            );
        }
    }

    #[test]
    fn an_update_restart_is_requested_only_once_its_token_fires() {
        let restart = super::UpdateRestart::new(true);
        assert!(restart.supervised());
        assert!(!restart.is_requested());
        restart.requested().cancel();
        assert!(
            restart.clone().is_requested(),
            "expected a clone to observe the shared request | received: not requested"
        );
        assert!(!super::UpdateRestart::unsupervised().supervised());
    }

    fn peer(role: &str) -> PeerInfo {
        PeerInfo {
            name: "test".into(),
            version: "0.0.0".into(),
            role: role.into(),
        }
    }

    /// The serve bearer check: equal bytes pass, and neither a differing
    /// byte at either end nor a length mismatch does. The prefix case is the
    /// one a comparison that zipped the two tokens without checking length
    /// first would wrongly accept.
    #[test]
    fn tokens_equal_accepts_only_identical_bytes() {
        for (presented, expected, equal) in [
            (&b"s3cret-token"[..], &b"s3cret-token"[..], true),
            (b"", b"", true),
            (b"x3cret-token", b"s3cret-token", false),
            (b"s3cret-tokex", b"s3cret-token", false),
            (b"s3cret", b"s3cret-token", false),
            (b"s3cret-token", b"s3cret", false),
            (b"", b"s3cret-token", false),
        ] {
            assert_eq!(
                super::tokens_equal(presented, expected),
                equal,
                "expected tokens_equal({:?}, {:?}): {equal} | received: {}",
                String::from_utf8_lossy(presented),
                String::from_utf8_lossy(expected),
                !equal
            );
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

    /// A call the hub makes the instant its handshake completes is recorded
    /// under the hub its `hello` named, with nothing but the session between
    /// them: no transport step has to win a race against the driver's
    /// dispatch of that first call before the line is written.
    #[tokio::test]
    async fn the_first_call_after_hello_is_audited_under_the_hubs_identity() {
        let home = crate::test_support::scratch_dir("transport-hub-identity");
        let slot_dir = home.join("runtime").join("host");
        std::fs::create_dir_all(&slot_dir).expect("the slot directory is created");
        std::fs::write(
            slot_dir.join("runtime.json"),
            br#"{"schemaVersion":1,"slot":"host","audit":{"enabled":true}}"#,
        )
        .expect("the slot config is written");
        let host = build_host(RuntimeSlot::Host, &home, "9.9.9");
        let (runtime_end, hub_end) = port_pair();
        let (_runtime, runtime_driver) = start_session(
            runtime_end,
            SessionOptions::new(runtime_peer("9.9.9")),
            host.registry,
            host.authorization,
            host.update,
            RuntimeSlot::Host.as_str(),
        );
        let capabilities = serde_json::json!({ "hub": { "user": "bob", "host": "desk" } });
        let (hub, hub_driver) = Session::spawn(
            hub_end,
            SessionOptions::new(peer("hub"))
                .with_capabilities(capabilities.as_object().expect("an object").clone()),
        );
        hub.ready().await.expect("the handshake completes");
        hub.request("runtime.health", serde_json::json!({}))
            .await
            .expect("runtime.health answers");

        let path = crate::runtime_home::slot_audit_log_path(RuntimeSlot::Host, &home);
        let contents = std::fs::read_to_string(&path).unwrap_or_default();
        let hub_label = contents.lines().last().map_or_else(
            || "no audit line".to_string(),
            |line| {
                let line: serde_json::Value =
                    serde_json::from_str(line).expect("an audit line is JSON");
                line["hub"].as_str().unwrap_or_default().to_string()
            },
        );
        hub.close(mango_protocol::close::close_codes::RELEASED, None)
            .await;
        let _ = hub_driver.await;
        let _ = runtime_driver.await;
        assert!(
            hub_label == "bob@desk",
            "expected audit hub: bob@desk | received: {hub_label}"
        );
    }

    #[test]
    fn runtime_peer_announces_the_fixed_name_and_role_with_the_given_version() {
        let peer = runtime_peer("9.9.9");
        assert_eq!(peer.name, RUNTIME_PEER_NAME);
        assert_eq!(peer.role, RUNTIME_PEER_ROLE);
        assert_eq!(peer.version, "9.9.9");
    }

    /// All ten `external-agent.*` methods are implemented, so the capability is
    /// advertised exactly when the owner consented to it.
    #[test]
    fn external_agents_are_advertised_only_with_consent() {
        let home = scratch_path("transport-external-agents-gate");
        let host = build_host(RuntimeSlot::Host, &home, "9.9.9");
        let allow =
            |external_agents| mangostudio_runtime_contract::manifest::RuntimeCapabilityAllow {
                fs_read: true,
                fs_write: true,
                shell: true,
                git: true,
                probing: true,
                mcp: true,
                library: true,
                checkpoints: true,
                update: true,
                external_agents,
            };
        let granted = crate::manifest::build_features(&host.registry, &allow(Some(true)), true);
        let refused = crate::manifest::build_features(&host.registry, &allow(Some(false)), true);
        let absent = crate::manifest::build_features(&host.registry, &allow(None), true);
        assert_eq!(
            (
                granted.external_agents,
                refused.external_agents,
                absent.external_agents
            ),
            (true, false, false),
            "expected features.externalAgents = (granted, refused, absent) = (true, false, false)"
        );
    }

    #[test]
    fn build_host_implements_exactly_the_current_method_families() {
        let home = scratch_path("transport-build-host");
        let host = build_host(RuntimeSlot::Host, &home, "9.9.9");
        assert_eq!(
            host.registry.implemented_methods(),
            vec![
                "external-agent.cancel",
                "external-agent.close",
                "external-agent.discover",
                "external-agent.list-sessions",
                "external-agent.open",
                "external-agent.refresh-account-usage",
                "external-agent.respond",
                "external-agent.start-review",
                "external-agent.steer",
                "external-agent.turn",
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
                "gh.exec",
                "gh.mutate",
                "git.exec",
                "install.cancel",
                "install.run",
                "library.apply",
                "library.backups",
                "library.gc",
                "library.locations",
                "library.read",
                "library.read-tree",
                "library.remove",
                "library.scan",
                "library.settings-sources",
                "library.undo",
                "mcp.call-tool",
                "mcp.connect",
                "mcp.disconnect",
                "mcp.elicit-response",
                "mcp.get-prompt",
                "mcp.list-prompts",
                "mcp.list-resources",
                "mcp.list-tools",
                "mcp.read-resource",
                "probing.agent-clis",
                "probing.runtimes",
                "probing.version-managers",
                "runtime.discover",
                "runtime.health",
                "runtime.update.begin",
                "runtime.update.chunk",
                "runtime.update.commit",
                "shell.run",
                "snapshot.capture",
                "snapshot.hash",
                "snapshot.revert",
                "terminal.ack",
                "terminal.attach",
                "terminal.close",
                "terminal.detach",
                "terminal.list",
                "terminal.open",
                "terminal.resize",
                "terminal.write",
                "workspace.browse",
                "workspace.resolve-contained",
                "workspace.validate",
            ],
            "the production registry must match its implemented method families"
        );
    }

    #[test]
    fn the_runtime_contract_is_compiled_once_per_process() {
        assert!(
            std::ptr::eq(runtime_contract(), runtime_contract()),
            "expected every transport to share one compiled contract, got two instances"
        );
    }
}
