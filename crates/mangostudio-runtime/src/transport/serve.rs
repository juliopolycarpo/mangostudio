//! The `serve` transport: the hub dials in over WebSocket, authenticated by
//! a bearer token this process holds. Mirrors `serve.ts`.
//!
//! One hub connection at a time. A new upgrade supersedes the previous one —
//! unless the previous one is live and bound to a different environment
//! record (see `ServeState::try_admit`), in which case the new one is
//! refused and the previous one is left alone. If the previous generation
//! had already published a real session by then, the replacement waits for
//! it to fully release before building its own — but a previous generation still in its own placeholder window (one
//! that has not yet reached `publish`, so it has no session and nothing to
//! wait on) releases instantly, and the two may briefly overlap while the
//! newer one constructs. See `ServeState`, the one `Mutex` that makes
//! "which generation may become active" and "are we shutting down" the
//! same synchronisation point (see [`crate::supervisor`]'s module docs for
//! why that matters).

use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use mango_protocol::close::close_codes;
use mango_protocol::port::{Inbound, Port, PortRx, PortTx};
use mango_protocol::session::{
    DEFAULT_HANDSHAKE_TIMEOUT, DEFAULT_LIVENESS_INTERVAL, Session, SessionClosure, SessionOptions,
    SessionState,
};
use mango_protocol::transports::websocket::WebSocketOptions;
use mango_protocol::transports::websocket::server::{
    AcceptOptions, REFUSAL_DRAIN_GRACE, accept_websocket,
};
use mangostudio_runtime_contract::strings::binding;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Semaphore, oneshot};
use tokio_util::sync::CancellationToken;

use crate::runtime_home::RuntimeSlot;
use crate::supervisor::{OwnedTasks, join_owned};
use crate::transport::upgrade_head::{BindingHeader, RecordingStream};
use crate::transport::{UpdateRestart, build_host_with_restart, runtime_peer, tokens_equal};

/// How long `stop()` waits for a straggling connection task (one still in
/// its own upgrade or supersession handoff, never a healthy session, which
/// has no timeout at all) before giving up and aborting it. Named
/// separately from every other grace in this crate — see
/// [`crate::supervisor`]'s cancellation section for why an abort here would
/// still not be the normal path.
const SHUTDOWN_DRAIN_GRACE: Duration = Duration::from_secs(5);

/// Bounds one TCP peer's entire WebSocket upgrade — the handshake itself,
/// `accept_websocket`'s subprotocol/origin checks, and this transport's own
/// bearer check — from the moment its connection is accepted. Named
/// separately from every other deadline in this crate: `mango_protocol`'s
/// upgrade has no read timeout of its own (a peer that opens the TCP
/// connection and never sends a byte otherwise never reaches the `authorize`
/// callback at all), so without this a single silent peer holds its
/// [`MAX_PENDING_HANDSHAKES`] permit — and its `OwnedTasks` slot — forever.
const UPGRADE_TIMEOUT: Duration = Duration::from_secs(10);

/// How long to back off after `listener.accept()` itself fails (an `EMFILE`
/// once every pending-handshake permit is genuinely held by a slow peer, a
/// transient `ECONNABORTED`, …) before trying again — never busy-loop the
/// accept loop on a condition retrying immediately cannot fix.
const ACCEPT_ERROR_BACKOFF: Duration = Duration::from_millis(50);

/// How many TCP peers may be *mid-upgrade* at once — from the instant
/// `listener.accept()` hands one to this transport to the instant its
/// [`accept_websocket`] call (bounded by [`UPGRADE_TIMEOUT`]) settles one way
/// or the other. Enforced by acquiring a permit atomically in the accept
/// loop itself, before a connection task is ever spawned — a peer beyond
/// this bound is refused (its raw socket dropped) before `OwnedTasks` grows
/// at all, which is what keeps an unauthenticated flood from costing this
/// process a task and a file descriptor per connection.
///
/// The permit is released the instant the upgrade settles, successfully or
/// not — it does **not** cover a connection's session lifetime. An
/// authenticated, long-lived hub connection holds no permit at all once its
/// upgrade completes, so this bound is exactly "how many peers may be
/// negotiating at once", never "how many may be connected".
const MAX_PENDING_HANDSHAKES: usize = 4;

/// The cadence a connected hub is told this runtime is still here, over the
/// `RUNTIME_HEARTBEAT_TOPIC` event. Shared with `connect`'s own heartbeat —
/// see that module's constant of the same value for why sharing one name is
/// correct here (it is the same behaviour in both transports) rather than
/// the brief's warning against reusing one timeout across unrelated
/// concerns.
pub(crate) const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(60);

/// Runs `serve` over an already-bound `listener` until `cancel` fires, then
/// drains every in-flight connection and returns.
///
/// Takes an already-bound [`TcpListener`], not an address: binding is a
/// separate, synchronous decision `cli.rs` makes (and can fail on) before
/// there is anything to run — and a caller that needs to know the listener
/// is actually accepting connections before proceeding (a test dialling
/// it, a health check) has no race to win against this function's own
/// internal bind.
pub async fn run(
    listener: TcpListener,
    token: String,
    slot: RuntimeSlot,
    mango_home: std::path::PathBuf,
    runtime_version: String,
    cancel: CancellationToken,
    log: impl Fn(&str) + Send + Sync + 'static,
) -> std::io::Result<()> {
    let listen = ServeListen {
        listener,
        token,
        slot,
        mango_home,
        runtime_version,
    };
    run_with_restart(listen, cancel, UpdateRestart::unsupervised(), log).await
}

/// What one `serve` invocation listens with; see [`run`] for each field.
pub(crate) struct ServeListen {
    pub listener: TcpListener,
    pub token: String,
    pub slot: RuntimeSlot,
    pub mango_home: std::path::PathBuf,
    pub runtime_version: String,
}

/// [`run`], but a supervised update committed over any connection also stops
/// the accept loop, releases the active session with the commit's answer
/// already sent, and returns with [`UpdateRestart::is_requested`] set, so
/// `cli.rs` exits with `RUNTIME_UPDATE_EXIT_CODE` for its supervisor.
///
/// Usage: `run_with_restart(listen, cancel, UpdateRestart::for_current_exe(&home), log)`.
pub(crate) async fn run_with_restart(
    listen: ServeListen,
    cancel: CancellationToken,
    restart: UpdateRestart,
    log: impl Fn(&str) + Send + Sync + 'static,
) -> std::io::Result<()> {
    let ServeListen {
        listener,
        token,
        slot,
        mango_home,
        runtime_version,
    } = listen;
    let restart_requested = restart.requested();
    let state = Arc::new(ServeState::new());
    let context = Arc::new(ConnectionContext {
        token,
        slot,
        mango_home,
        runtime_version,
        restart,
        log: Box::new(log),
    });
    let pending_handshakes = Arc::new(Semaphore::new(MAX_PENDING_HANDSHAKES));
    let mut owned = OwnedTasks::new();

    loop {
        tokio::select! {
            biased;
            () = cancel.cancelled() => break,
            () = restart_requested.cancelled() => break,
            // Ordered before `accept`, not after: `biased` polls branches
            // in source order and never reaches a later one while an
            // earlier one is ready, and `listener.accept()` stays ready
            // for as long as the kernel backlog holds connections — which
            // is precisely the unauthenticated flood this reap exists to
            // survive. A reap listed after `accept` is starved on exactly
            // that path, so completed tasks would only ever be reaped at
            // shutdown under the load that motivated adding this at all —
            // measured directly (see this crate's own tests) by racing
            // `reap_one` against a branch that never once returns Pending,
            // which is the abstract shape of a saturated accept loop.
            //
            // Reordering is safe on the *idle* path too: `reap_one` on an
            // empty `OwnedTasks` awaits `std::future::pending()`, which
            // never resolves, so `biased` still falls through to `accept`
            // on every poll where nothing is finished — this only changes
            // which branch wins when *both* are ready, never which one is
            // considered first.
            _ = owned.reap_one() => {}
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _peer_addr)) => {
                        // Acquired here, atomically, before anything is
                        // spawned: `try_acquire_owned` is the check *and*
                        // the reservation in one step, so there is no
                        // window between "may I admit another mid-upgrade
                        // peer" and actually counting this one against the
                        // bound — a flood past `MAX_PENDING_HANDSHAKES`
                        // never grows `OwnedTasks` at all.
                        match Arc::clone(&pending_handshakes).try_acquire_owned() {
                            Ok(permit) => {
                                let state = Arc::clone(&state);
                                let context = Arc::clone(&context);
                                owned.spawn(async move {
                                    handle_connection(stream, permit, state, context).await;
                                });
                            }
                            Err(_) => drop(stream),
                        }
                    }
                    Err(error) => {
                        (context.log)(&format!("accept failed: {error}"));
                        tokio::time::sleep(ACCEPT_ERROR_BACKOFF).await;
                    }
                }
            }
        }
    }

    let reason = if context.restart.is_requested() {
        "Runtime update committed"
    } else {
        "Runtime stopped"
    };
    if let Some(previous) = state.begin_shutdown() {
        release_active(previous, close_codes::RELEASED, reason).await;
    }
    let aborted = owned.join_all_or_abort(SHUTDOWN_DRAIN_GRACE).await;
    if aborted > 0 {
        // Reachable from the network (a peer that never completes its own
        // teardown), not a programmer error — log it rather than assert.
        (context.log)(&format!(
            "{aborted} connection task(s) outlived the shutdown grace and were aborted"
        ));
    }
    Ok(())
}

/// What every accepted connection needs, shared read-only across them.
struct ConnectionContext {
    token: String,
    slot: RuntimeSlot,
    mango_home: std::path::PathBuf,
    runtime_version: String,
    restart: UpdateRestart,
    log: Box<dyn Fn(&str) + Send + Sync>,
}

/// One admitted generation: enough for a later caller to supersede it
/// (`session`, to close it) and to know once it has fully finished
/// (`released`, which resolves — successfully or not, the value carries no
/// meaning — the instant the owning task's local sender drops, at any of
/// its return points). `binding` is the key its hub announced, if any.
struct ActiveGeneration {
    generation: u64,
    binding: Option<String>,
    session: Option<Session>,
    released: Option<oneshot::Receiver<()>>,
}

impl ActiveGeneration {
    fn placeholder(generation: u64, binding: Option<String>) -> Self {
        Self {
            generation,
            binding,
            session: None,
            released: None,
        }
    }

    /// True when this generation holds the runtime for a binding key other
    /// than `newcomer`'s, and still counts as holding it.
    ///
    /// Either side lacking a key (an older hub) never refuses: that is the
    /// pre-binding supersede behaviour, kept exactly. A placeholder (no
    /// session yet) is an authenticated connection whose hub already said
    /// which record it speaks for, so it holds the runtime too. A session
    /// that has already closed does not: its task just has not cleared the
    /// slot yet, and the newcomer should win rather than wait on it.
    fn bound_elsewhere(&self, newcomer: Option<&str>) -> bool {
        let (Some(incumbent), Some(newcomer)) = (self.binding.as_deref(), newcomer) else {
            return false;
        };
        incumbent != newcomer
            && self
                .session
                .as_ref()
                .is_none_or(|session| session.state() != SessionState::Closed)
    }
}

/// One of [`ServeState::try_admit`]'s three outcomes.
enum Admission {
    /// This call is now the active generation. `previous`, if any, must be
    /// released (see [`release_active`]) before this generation may build a
    /// session.
    Admitted {
        generation: u64,
        previous: Option<ActiveGeneration>,
    },
    /// Shutdown had already started; nothing was claimed.
    Refused,
    /// A live generation holds the runtime for a different binding key;
    /// nothing was claimed and the incumbent was not touched.
    AlreadyBound,
}

/// The one synchronisation point admission and shutdown share. See the
/// module docs and [`crate::supervisor`]'s "Admission and shutdown share one
/// synchronisation point" section.
struct ServeState {
    inner: Mutex<Inner>,
}

struct Inner {
    closed: bool,
    generation: u64,
    active: Option<ActiveGeneration>,
}

impl ServeState {
    fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                closed: false,
                generation: 0,
                active: None,
            }),
        }
    }

    /// Claims the next generation for a hub announcing `binding`, unless
    /// shutdown has already started or a live generation is bound to a
    /// different key. Mirrors `serve.ts`'s synchronous `active = entry` —
    /// the slot is claimed by a placeholder immediately, before any session
    /// exists, so a *third* connection racing in behind this one already
    /// sees this generation as current rather than the one it is about to
    /// supersede.
    ///
    /// The refusal is decided under the same lock every release goes
    /// through, which is what makes it race-free against the incumbent
    /// going away: a supersession or shutdown takes the incumbent *out of*
    /// `active` under this lock before closing it, and the incumbent's own
    /// task clears `active` under it once its session ends. So under the
    /// lock the incumbent is exactly one of: still in `active` with a
    /// session that has not closed (refuse the newcomer), still in `active`
    /// with a closed session its task has not cleared yet (the newcomer
    /// supersedes it, as `bound_elsewhere` says), or gone (the newcomer is
    /// admitted with nothing to supersede). There is no window where a
    /// newcomer is refused by an incumbent that has already been released.
    fn try_admit(&self, binding: Option<&str>) -> Admission {
        let mut inner = self.inner.lock().expect("ServeState mutex poisoned");
        if inner.closed {
            return Admission::Refused;
        }
        if inner
            .active
            .as_ref()
            .is_some_and(|active| active.bound_elsewhere(binding))
        {
            return Admission::AlreadyBound;
        }
        inner.generation += 1;
        let generation = inner.generation;
        let previous = inner.active.replace(ActiveGeneration::placeholder(
            generation,
            binding.map(str::to_owned),
        ));
        Admission::Admitted {
            generation,
            previous,
        }
    }

    /// True when `generation` is still the active one and shutdown has not
    /// started — the re-check every `.await` point in [`handle_connection`]
    /// runs before doing the next irreversible thing.
    fn still_current(&self, generation: u64) -> bool {
        let inner = self.inner.lock().expect("ServeState mutex poisoned");
        !inner.closed
            && inner
                .active
                .as_ref()
                .is_some_and(|active| active.generation == generation)
    }

    /// Replaces the placeholder for `generation` with the real thing, unless
    /// it has already stopped being current. Returns whether it took.
    fn publish(&self, generation: u64, active: ActiveGeneration) -> bool {
        let mut inner = self.inner.lock().expect("ServeState mutex poisoned");
        if inner.closed
            || inner.active.as_ref().map(|current| current.generation) != Some(generation)
        {
            return false;
        }
        inner.active = Some(active);
        true
    }

    /// Clears the active slot, but only if it is still `generation` — a
    /// generation that has already been superseded must not clear the
    /// *newer* one out from under it.
    ///
    /// Tolerates a poisoned lock: [`AdmittedGeneration`] calls this from
    /// `Drop`, possibly while unwinding, where a second panic would abort.
    fn clear_if_current(&self, generation: u64) {
        let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        if inner.active.as_ref().map(|active| active.generation) == Some(generation) {
            inner.active = None;
        }
    }

    /// Stops admitting anything new and hands back whatever was active, for
    /// the caller to release.
    fn begin_shutdown(&self) -> Option<ActiveGeneration> {
        let mut inner = self.inner.lock().expect("ServeState mutex poisoned");
        inner.closed = true;
        inner.active.take()
    }
}

/// Owns one admitted generation's claim on the active slot for as long as
/// its connection task runs, and clears it on drop — on every return path,
/// but also when the task panics or is aborted. Without it, a keyed
/// placeholder whose task died between admission and its own cleanup would
/// refuse every other environment record for the life of the process.
/// Clearing is generation-checked, so a generation that was already
/// superseded clears nothing.
struct AdmittedGeneration {
    state: Arc<ServeState>,
    generation: u64,
}

impl AdmittedGeneration {
    fn new(state: &Arc<ServeState>, generation: u64) -> Self {
        Self {
            state: Arc::clone(state),
            generation,
        }
    }
}

impl Drop for AdmittedGeneration {
    fn drop(&mut self) {
        self.state.clear_if_current(self.generation);
    }
}

/// Closes `previous`'s session (if it had one yet) and waits for its owning
/// task to fully finish — including that task's own heartbeat teardown and
/// driver join — before returning. Both a supersession and a shutdown reach
/// this same function, so both "a new connection took over" and "the
/// process is stopping" join the identical teardown path rather than each
/// inventing its own.
async fn release_active(previous: ActiveGeneration, code: u16, reason: &str) {
    if let Some(session) = &previous.session {
        session.close_now(code, Some(reason));
    }
    if let Some(released) = previous.released {
        let _ = released.await;
    }
}

/// Runs one accepted TCP connection from upgrade to release.
///
/// `permit` reserves this connection's [`MAX_PENDING_HANDSHAKES`] slot for
/// exactly the upgrade below — bounded by [`UPGRADE_TIMEOUT`], since
/// `accept_websocket` has no read timeout of its own and a peer that opens
/// the socket and never speaks would otherwise hold it, and this task's
/// `OwnedTasks` slot, forever.
async fn handle_connection(
    stream: TcpStream,
    permit: tokio::sync::OwnedSemaphorePermit,
    state: Arc<ServeState>,
    context: Arc<ConnectionContext>,
) {
    let token = context.token.clone();
    let runtime_version = context.runtime_version.clone();
    // The health-check peek and the upgrade itself share this one timeout,
    // not two separate ones: `TcpStream::peek` waits for bytes exactly the
    // way `accept_websocket` does, so a peer that opens the socket and
    // never sends anything at all — not even a health check — must not be
    // able to hold this slot any longer by arriving before the part of
    // this function that used to be the only bounded step.
    let classified = tokio::time::timeout(UPGRADE_TIMEOUT, async move {
        if is_health_check(&stream).await {
            respond_health(stream, &runtime_version).await;
            return None;
        }
        // Recorded as the upgrade reads it: the binding key rides in the
        // upgrade request beside the bearer, and `accept_websocket` hands
        // its callback only the bearer and the origin.
        let (stream, head) = RecordingStream::new(stream);
        let accepted = accept_websocket(
            stream,
            // A hub built before `mango.v1` was mandatory still gets
            // its socket: letting it through unlabelled is what lets
            // its session answer `hello` with a real close code
            // instead of a bare HTTP refusal it has no vocabulary for
            // — mirrors `serve.ts`'s own compatibility policy exactly.
            AcceptOptions::from(WebSocketOptions::default()).with_subprotocol_optional(),
            |upgrade| match upgrade.bearer() {
                Some(presented) if tokens_equal(presented.as_bytes(), token.as_bytes()) => Ok(()),
                _ => Err(close_codes::UNAUTHORIZED),
            },
        )
        .await;
        Some(accepted.map(|port| (port, head.binding())))
    })
    .await;
    let (port, binding_header) = match classified {
        // A health check was answered; nothing to upgrade at all. `permit`
        // drops here — a health check never counted against
        // `MAX_PENDING_HANDSHAKES` in `serve.ts` either.
        Ok(None) => return,
        Ok(Some(Ok(accepted))) => accepted,
        // Refused (bad credential, bad subprotocol, …) or the peer vanished
        // mid-upgrade: `accept_websocket` already told it why. Either way
        // `permit` drops here, at this `return`, releasing the slot.
        Ok(Some(Err(_))) => return,
        // The peer opened the socket and never finished a upgrade within
        // `UPGRADE_TIMEOUT` — silent or slow-loris-ing. `stream` and `permit`
        // both drop here; nothing was ever spent on it beyond one slot for
        // one bounded wait.
        Err(_elapsed) => return,
    };
    // The upgrade is over, successfully; this connection is no longer
    // "pending" in the sense `MAX_PENDING_HANDSHAKES` bounds; whatever
    // happens next (becoming active, losing the admission race, a healthy
    // multi-hour session) must not keep holding this slot.
    drop(permit);
    serve_upgraded(port, binding_header, state, context).await;
}

/// Runs one upgraded connection from its binding check to release: admits
/// it, waits for the generation it supersedes to finish its own cleanup,
/// and only then builds and serves this generation's session. Generic over
/// the port so the admission and supersession sequence can run over an
/// in-memory pair.
async fn serve_upgraded<P: Port>(
    port: P,
    binding_header: BindingHeader,
    state: Arc<ServeState>,
    context: Arc<ConnectionContext>,
) {
    // Every refusal from here to admission goes out as a close frame over
    // the upgraded socket before this side's `hello` — the same shape
    // `accept_websocket` gives a refused credential. A malformed binding
    // header is refused outright, never read as "no key": a hub that sent
    // one meant this connection to be bound.
    let binding = match binding_header {
        BindingHeader::Absent => None,
        BindingHeader::Key(key) => Some(key),
        BindingHeader::Malformed(why) => {
            // Logged first: `close_port` waits for the peer's close, which
            // the peer has already seen by then.
            (context.log)(&format!("Refused a hub connection: {why}."));
            close_port(
                port,
                close_codes::PROTOCOL_ERROR,
                &format!("invalid hub binding header: {why}"),
            )
            .await;
            return;
        }
    };

    let host = build_host_with_restart(
        context.slot,
        &context.mango_home,
        &context.runtime_version,
        &context.restart,
    );
    // No request is in flight yet to cancel this against — a fresh token
    // that never fires, bounded only by `GIT_PROBE_TIMEOUT` internally. See
    // `hello_capabilities`'s own doc comment.
    //
    // Built *before* admission below, not after: this used to run only
    // once the previous connection had already been superseded, leaving
    // the runtime connectionless for the whole cost of building it (a
    // `PATH` walk, a `git` probe — measured around 200ms) for no reason.
    // The previous connection can keep answering calls right up until
    // this one is actually ready to take its place.
    let capabilities = crate::transport::hello_capabilities(
        context.slot,
        &context.mango_home,
        &host.registry,
        &CancellationToken::new(),
    )
    .await;

    let (generation, previous) = match state.try_admit(binding.as_deref()) {
        Admission::Admitted {
            generation,
            previous,
        } => (generation, previous),
        Admission::Refused => {
            close_port(port, close_codes::RELEASED, "Runtime stopped").await;
            return;
        }
        Admission::AlreadyBound => {
            // Refused before this side's `hello` goes out, so the incumbent
            // is never disturbed and the refused hub learns only the code
            // and reason. Logged first, as for a malformed header.
            (context.log)(
                "Refused a hub connection: this runtime is already bound to another environment.",
            );
            close_port(
                port,
                binding::ALREADY_BOUND_CLOSE_CODE,
                binding::ALREADY_BOUND_REASON,
            )
            .await;
            return;
        }
    };
    // Declared before anything that can fail or be cancelled, so the slot
    // this admission claimed is released however this task ends.
    let _admitted = AdmittedGeneration::new(&state, generation);

    if let Some(previous) = previous {
        release_active(previous, close_codes::SUPERSEDED, "Superseded").await;
        (context.log)("A new hub connection superseded the previous one.");
    }
    if !state.still_current(generation) {
        state.clear_if_current(generation);
        close_port(port, close_codes::RELEASED, "Runtime stopped").await;
        return;
    }

    // `SessionOptions::new`'s defaults already match `serve.ts`'s own
    // `HANDSHAKE_TIMEOUT_MS`/`LIVENESS_INTERVAL_MS` (15s/20s), so nothing is
    // overridden here — see `mango_protocol::session::{DEFAULT_HANDSHAKE_TIMEOUT, DEFAULT_LIVENESS_INTERVAL}`.
    let options =
        SessionOptions::new(runtime_peer(&context.runtime_version)).with_capabilities(capabilities);
    debug_assert_eq!(options.handshake_timeout, DEFAULT_HANDSHAKE_TIMEOUT);
    debug_assert_eq!(options.liveness_interval, Some(DEFAULT_LIVENESS_INTERVAL));
    // `crate::transport::start_session`, never `Session::spawn` directly:
    // see that function's own doc comment for the handler-registration
    // race its ordering closes.
    let (session, driver_handle) = crate::transport::start_session(
        port,
        options,
        host.registry,
        host.authorization,
        host.update,
        context.slot.as_str(),
    );

    let (released_tx, released_rx) = oneshot::channel();
    let published = state.publish(
        generation,
        ActiveGeneration {
            generation,
            binding,
            session: Some(session.clone()),
            released: Some(released_rx),
        },
    );
    if !published {
        session.close_now(close_codes::RELEASED, Some("Runtime stopped"));
        let _ = join_owned(driver_handle).await;
        return;
    }
    // Held for the rest of this function: dropped on every return path from
    // here on (including a handshake failure below), which is what
    // `release_active` waits on.
    let _released_tx = released_tx;

    if session.ready().await.is_err() {
        state.clear_if_current(generation);
        session.close_now(close_codes::RELEASED, Some("Handshake failed"));
        let _ = join_owned(driver_handle).await;
        return;
    }
    if !state.still_current(generation) {
        // Superseded or stopped in the instant between publishing and the
        // handshake completing; the superseding/stopping call already owns
        // closing this session, so this task only needs to reap its driver.
        let _ = join_owned(driver_handle).await;
        return;
    }

    let heartbeat_cancel = CancellationToken::new();
    let heartbeat_context = Arc::clone(&context);
    let heartbeat = tokio::spawn(crate::transport::heartbeat_loop(
        session.clone(),
        HEARTBEAT_INTERVAL,
        heartbeat_cancel.clone(),
        move |message: &str| (heartbeat_context.log)(message),
    ));

    let closure: SessionClosure = join_owned(driver_handle).await;
    heartbeat_cancel.cancel();
    let _ = join_owned(heartbeat).await;

    state.clear_if_current(generation);
    if let Some(failure) = teardown_failure(&closure) {
        (context.log)(&failure);
    }
    (context.log)("Hub connection ended.");
}

/// Describes a session teardown that did not finish cleanly, with the close
/// that started it, or `None` for a clean one.
///
/// A handler still running when the close grace expired is the teardown
/// failure a connection can have here: what it holds (a child process, an
/// exclusivity claim) outlives the hub that asked for it, and the operator
/// reading this process's stderr is the only party left to tell.
///
/// # Example
///
/// ```ignore
/// // A closure whose grace expired with one handler still running:
/// assert!(teardown_failure(&closure).unwrap().contains("1 handler(s)"));
/// ```
fn teardown_failure(closure: &SessionClosure) -> Option<String> {
    if closure.unfinished_handlers == 0 {
        return None;
    }
    let reason = closure
        .reason
        .as_deref()
        .map_or_else(String::new, |reason| format!(": {reason}"));
    Some(format!(
        "Hub connection teardown failed: {} handler(s) were still running when the close grace \
         expired (close {}{reason}).",
        closure.unfinished_handlers, closure.code
    ))
}

/// Closes a port nothing ever became a session over — a refused admission,
/// or one that lost the race before a session was ever built.
///
/// Then reads the port until the peer's own close arrives (bounded by
/// [`REFUSAL_DRAIN_GRACE`], the protocol crate's own bound for the refusals
/// [`accept_websocket`] sends) instead of dropping it at once: by now the hub
/// has usually sent its `hello`, and a socket dropped with those bytes still
/// unread is reset rather than closed on Windows (and on BSD-derived
/// stacks — see [`drain_request_headers`]), which throws away the close
/// frame and leaves the hub with no code to act on.
async fn close_port<P: Port>(port: P, code: u16, reason: &str) {
    let (tx, mut rx) = port.split();
    tx.close(code, Some(reason.to_string())).await;
    let _ = tokio::time::timeout(REFUSAL_DRAIN_GRACE, async {
        while let Some(inbound) = rx.recv().await {
            if matches!(inbound, Inbound::Closed(_)) {
                return;
            }
        }
    })
    .await;
}

/// The exact bytes a plain `GET /health` request line starts with, checked
/// via [`TcpStream::peek`] — which does not remove anything from the
/// socket's read queue, so a stream that turns out *not* to be a health
/// check is handed to [`accept_websocket`] completely untouched.
const HEALTH_CHECK_PREFIX: &[u8] = b"GET /health ";

/// True when `stream`'s first bytes are a `GET /health` request line.
///
/// `serve.ts` serves this over the same listener a hub upgrades on; the
/// Rust accept loop had no equivalent, so a plain health check (or a
/// Direct URL user opening the address in a browser) fell straight into
/// `accept_websocket`, which has no vocabulary for anything but a
/// WebSocket upgrade and would reject it as a failed handshake.
async fn is_health_check(stream: &TcpStream) -> bool {
    let mut buffer = [0u8; HEALTH_CHECK_PREFIX.len()];
    matches!(
        stream.peek(&mut buffer).await,
        Ok(n) if n >= buffer.len() && buffer == *HEALTH_CHECK_PREFIX
    )
}

/// How much of a health check's own request line/headers this will read
/// looking for the end of them before giving up — a GET has no body, so
/// nothing legitimate runs past a few hundred bytes; this only bounds a
/// peer that never finishes sending them.
const MAX_HEALTH_CHECK_REQUEST_BYTES: usize = 8192;

/// Reads and discards `stream`'s pending bytes up to the end of the request
/// headers (`\r\n\r\n`), or until [`MAX_HEALTH_CHECK_REQUEST_BYTES`] is
/// reached, or the peer stops sending.
///
/// [`is_health_check`] only *peeks* the first bytes — nothing has actually
/// been read off the socket yet by the time this runs, so the peer's whole
/// request (everything past what the peek buffer happened to cover) is
/// still sitting unread in the kernel's receive buffer. Draining it here,
/// before [`respond_health`] writes anything, is what keeps this from
/// closing with unread data still queued: BSD-derived stacks (macOS
/// included) answer a close with unread bytes pending by sending an RST
/// instead of a FIN, discarding whatever was just written along with it —
/// measured as this exact failure on macOS CI (`ConnectionReset` on the
/// client's read) while the identical code passed on Linux, which is more
/// forgiving of this precise timing.
async fn drain_request_headers(stream: &mut TcpStream) {
    let mut accumulated = Vec::new();
    let mut chunk = [0u8; 512];
    loop {
        match tokio::io::AsyncReadExt::read(stream, &mut chunk).await {
            Ok(0) => return, // the peer closed its write half; nothing left to drain
            Ok(n) => {
                accumulated.extend_from_slice(&chunk[..n]);
                if accumulated.windows(4).any(|window| window == b"\r\n\r\n") {
                    return;
                }
                if accumulated.len() >= MAX_HEALTH_CHECK_REQUEST_BYTES {
                    return;
                }
            }
            Err(_) => return,
        }
    }
}

/// Answers a health check with the same shape `serve.ts` does
/// (`Response.json({ status: 'ok', version })`), then closes the
/// connection — this is a one-shot HTTP response, never a kept-alive
/// socket, since nothing here speaks HTTP beyond this one reply.
async fn respond_health(mut stream: TcpStream, runtime_version: &str) {
    drain_request_headers(&mut stream).await;
    let body = serde_json::json!({ "status": "ok", "version": runtime_version }).to_string();
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = tokio::io::AsyncWriteExt::write_all(&mut stream, response.as_bytes()).await;
    let _ = tokio::io::AsyncWriteExt::shutdown(&mut stream).await;
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use tokio::sync::{Barrier, oneshot};

    use mango_protocol::frame::PeerInfo;
    use mango_protocol::port::port_pair;
    use mango_protocol::session::{Session, SessionOptions, SessionState};

    use super::{ActiveGeneration, Admission, AdmittedGeneration, ServeState};

    /// A named fake for the connection log: every line, in order.
    #[derive(Clone, Default)]
    struct RecordingLog(Arc<std::sync::Mutex<Vec<String>>>);

    impl RecordingLog {
        fn sink(&self) -> Box<dyn Fn(&str) + Send + Sync> {
            let lines = Arc::clone(&self.0);
            Box::new(move |line: &str| lines.lock().unwrap().push(line.to_owned()))
        }

        fn lines(&self) -> Vec<String> {
            self.0.lock().unwrap().clone()
        }

        fn mentions(&self, needle: &str) -> bool {
            self.lines().iter().any(|line| line.contains(needle))
        }
    }

    fn active_generation(state: &ServeState) -> Option<u64> {
        state
            .inner
            .lock()
            .expect("ServeState mutex poisoned")
            .active
            .as_ref()
            .map(|active| active.generation)
    }

    /// A superseding connection must not say `hello` until the generation it
    /// replaced has finished its own cleanup: the two sessions would
    /// otherwise share the runtime's MCP servers, terminals and update
    /// claims for a moment. The superseded generation here is a published
    /// entry whose cleanup signal the test holds; the newcomer's hello may
    /// reach the hub only once the test lets go of it.
    #[tokio::test]
    async fn a_second_hello_waits_for_the_superseded_connections_cleanup() {
        use std::time::{Duration, Instant};

        use mango_protocol::frame::Frame;
        use mango_protocol::port::{Inbound, Port, PortRx};

        let state = Arc::new(ServeState::new());
        let Admission::Admitted {
            generation: superseded,
            ..
        } = state.try_admit(None)
        else {
            panic!("expected an empty runtime to admit the first generation");
        };
        let (cleanup_finished, cleanup) = oneshot::channel::<()>();
        assert!(state.publish(
            superseded,
            ActiveGeneration {
                generation: superseded,
                binding: None,
                session: None,
                released: Some(cleanup),
            },
        ));

        let home = crate::test_support::scratch_dir("serve-held-cleanup");
        let log = RecordingLog::default();
        let context = Arc::new(super::ConnectionContext {
            token: "unused".into(),
            slot: crate::runtime_home::RuntimeSlot::Host,
            mango_home: home.to_path_buf(),
            runtime_version: "0.0.0".into(),
            restart: crate::transport::UpdateRestart::unsupervised(),
            log: log.sink(),
        });
        let (hub_port, runtime_port) = port_pair();
        let (hub_tx, mut hub_rx) = hub_port.split();
        let connection = tokio::spawn(super::serve_upgraded(
            runtime_port,
            crate::transport::upgrade_head::BindingHeader::Absent,
            Arc::clone(&state),
            context,
        ));

        // Gate: the newcomer has claimed the next generation. Nothing awaits
        // between that claim and the wait on the superseded cleanup.
        let real_deadline = Instant::now() + Duration::from_secs(30);
        while active_generation(&state) != Some(superseded + 1) {
            assert!(
                Instant::now() < real_deadline,
                "expected the newcomer to claim generation {} | received: {:?}",
                superseded + 1,
                active_generation(&state)
            );
            tokio::task::yield_now().await;
        }
        // A newcomer that did not wait would say hello well inside this
        // real-time window; one that waits cannot say it at all.
        let window = Instant::now() + Duration::from_millis(250);
        while Instant::now() < window {
            if let Ok(inbound) = tokio::time::timeout(Duration::ZERO, hub_rx.recv()).await {
                let received = format!("{inbound:?}");
                panic!(
                    "expected nothing from the newcomer while the superseded cleanup is held | \
                     received: {}",
                    received.get(..80).unwrap_or(&received)
                );
            }
            tokio::task::yield_now().await;
        }
        assert!(
            !log.mentions("superseded"),
            "expected no supersession logged before the cleanup finished | received: {:?}",
            log.lines()
        );

        drop(cleanup_finished);
        let first = tokio::time::timeout(Duration::from_secs(30), hub_rx.recv())
            .await
            .expect("expected the newcomer's hello once the superseded cleanup finished");
        let received = format!("{first:?}");
        assert!(
            matches!(first, Some(Inbound::Frame(Frame::Hello(_)))),
            "expected the newcomer's first frame to be hello | received: {}",
            received.get(..80).unwrap_or(&received)
        );
        assert!(
            log.mentions("superseded the previous one"),
            "expected the supersession logged | received: {:?}",
            log.lines()
        );

        drop((hub_tx, hub_rx));
        tokio::time::timeout(Duration::from_secs(30), connection)
            .await
            .expect("expected the newcomer to end once its hub went away")
            .expect("the connection task must not panic");
    }

    /// A handler still running when the close grace expires is a teardown
    /// failure, and the line names how many and the close that started it.
    /// A clean close reports nothing.
    #[tokio::test(start_paused = true)]
    async fn a_teardown_that_outlives_the_close_grace_is_described_with_its_close() {
        let (hub_port, runtime_port) = port_pair();
        let (entered_tx, entered) = oneshot::channel::<()>();
        let entered_tx = std::sync::Mutex::new(Some(entered_tx));
        let (hub, _hub_driver) = Session::spawn(hub_port, SessionOptions::new(peer("hub")));
        let (runtime, _runtime_driver) = Session::spawn(
            runtime_port,
            SessionOptions::new(peer("runtime"))
                .with_handler_grace(std::time::Duration::from_secs(5))
                .handle("test.parked", move |_params, _context| {
                    if let Some(entered) = entered_tx.lock().unwrap().take() {
                        let _ = entered.send(());
                    }
                    async { std::future::pending().await }
                }),
        );
        runtime.ready().await.expect("the pair handshakes");
        let request = tokio::spawn({
            let hub = hub.clone();
            async move { hub.request("test.parked", serde_json::json!({})).await }
        });
        entered.await.expect("the parked handler starts");

        let closure = runtime
            .close(
                mango_protocol::close::close_codes::RELEASED,
                Some("Runtime stopped"),
            )
            .await;
        request.abort();

        let failure = super::teardown_failure(&closure)
            .expect("expected a teardown failure for a handler past the grace | received: None");
        assert!(
            failure.contains("1 handler(s)")
                && failure.contains(&format!(
                    "close {}: Runtime stopped",
                    mango_protocol::close::close_codes::RELEASED
                )),
            "expected the handler count and the close in the line | received: {failure}"
        );

        let (clean, _peer) = live_session().await;
        let clean_closure = clean
            .close(mango_protocol::close::close_codes::RELEASED, None)
            .await;
        assert_eq!(
            super::teardown_failure(&clean_closure),
            None,
            "expected a clean close to report no teardown failure"
        );
    }

    /// The property `serve`'s single `Mutex` exists for: however many
    /// connections race to admit at the exact instant shutdown begins, none
    /// of them may still be sitting in the active slot once everything
    /// settles — shutdown having taken (and not given back) the slot is
    /// exactly what must stop any of them from landing there afterwards.
    ///
    /// This replaces an earlier version of this test whose only assertion
    /// was `admitted + refused == CONCURRENT`, which is true by
    /// construction (`try_admit` returns exactly one variant, and each arm
    /// increments exactly one counter) and does not exercise the mutex at
    /// all — confirmed by deleting the `if inner.closed` check from
    /// `try_admit` entirely and observing that assertion still pass. The
    /// assertion below was measured, against the real defect of splitting
    /// `closed` out of the `Mutex` into its own flag checked outside the
    /// lock, to catch it on some fraction of single rounds — which is why
    /// this repeats the whole barrier round, with a fresh [`ServeState`]
    /// each time, rather than relying on one round to be enough.
    #[tokio::test(flavor = "multi_thread", worker_threads = 8)]
    async fn no_admission_survives_in_the_active_slot_after_shutdown_takes_it() {
        const CONCURRENT: usize = 64;
        const ROUNDS: usize = 200;

        for _ in 0..ROUNDS {
            let state = Arc::new(ServeState::new());
            let barrier = Arc::new(Barrier::new(CONCURRENT + 1));
            let admitted = Arc::new(AtomicUsize::new(0));
            let refused = Arc::new(AtomicUsize::new(0));

            let mut admitters = Vec::new();
            for _ in 0..CONCURRENT {
                let state = Arc::clone(&state);
                let barrier = Arc::clone(&barrier);
                let admitted = Arc::clone(&admitted);
                let refused = Arc::clone(&refused);
                admitters.push(tokio::spawn(async move {
                    barrier.wait().await;
                    match state.try_admit(None) {
                        Admission::Admitted { .. } => {
                            admitted.fetch_add(1, Ordering::SeqCst);
                            // Deliberately does *not* call
                            // `clear_if_current`: doing so would launder
                            // the exact leak this test exists to catch — an
                            // admission that landed after shutdown already
                            // took the active slot, then promptly tidied
                            // itself away before anything could observe it.
                        }
                        Admission::Refused => {
                            refused.fetch_add(1, Ordering::SeqCst);
                        }
                        Admission::AlreadyBound => {
                            unreachable!("no generation here announces a binding key")
                        }
                    }
                }));
            }
            let shutdown_state = Arc::clone(&state);
            let shutdown_barrier = Arc::clone(&barrier);
            let shutdown = tokio::spawn(async move {
                shutdown_barrier.wait().await;
                shutdown_state.begin_shutdown()
            });

            for admitter in admitters {
                admitter.await.unwrap();
            }
            let _ = shutdown.await.unwrap();

            // Documentation only, kept for readers, not load-bearing: every
            // call lands in exactly one bucket by construction, which is
            // exactly why this alone proved nothing (see the doc comment
            // above).
            assert_eq!(
                admitted.load(Ordering::SeqCst) + refused.load(Ordering::SeqCst),
                CONCURRENT
            );

            // The assertion that actually discriminates the defect.
            let leaked = state
                .inner
                .lock()
                .expect("ServeState mutex poisoned")
                .active
                .as_ref()
                .map(|active| active.generation);
            assert_eq!(
                leaked, None,
                "a generation was admitted after shutdown took the active slot"
            );
        }
    }

    /// The other half of the same invariant: once shutdown has run, no
    /// later `try_admit` may succeed — admission and shutdown reading the
    /// same flag under the same lock is what this asserts.
    #[test]
    fn nothing_is_admitted_once_shutdown_has_started() {
        let state = ServeState::new();
        state.begin_shutdown();
        assert!(matches!(state.try_admit(None), Admission::Refused));
    }

    /// `release_active`'s completion signal actually fires: a caller that
    /// awaits it after the owning generation's local sender drops observes
    /// that drop as a resolved receiver, not a hang.
    #[tokio::test]
    async fn a_released_generations_signal_resolves_once_its_owner_drops_the_sender() {
        let (tx, rx) = oneshot::channel::<()>();
        let previous = ActiveGeneration {
            generation: 1,
            binding: None,
            session: None,
            released: Some(rx),
        };
        drop(tx); // the owning task's implicit drop on return
        super::release_active(
            previous,
            mango_protocol::close::close_codes::RELEASED,
            "test",
        )
        .await;
    }

    /// `still_current`/`publish`/`clear_if_current` must never let a
    /// superseded generation clear the *newer* one that replaced it — the
    /// exact bug a naive `active = None` (rather than a generation-checked
    /// clear) would reintroduce.
    #[test]
    fn a_superseded_generation_cannot_clear_the_generation_that_replaced_it() {
        let state = ServeState::new();
        let first = match state.try_admit(None) {
            Admission::Admitted { generation, .. } => generation,
            Admission::Refused | Admission::AlreadyBound => unreachable!(),
        };
        assert!(state.publish(first, ActiveGeneration::placeholder(first, None)));

        let second = match state.try_admit(None) {
            Admission::Admitted {
                generation,
                previous,
            } => {
                assert!(
                    previous.is_some(),
                    "the first generation must be handed back to release"
                );
                generation
            }
            Admission::Refused | Admission::AlreadyBound => unreachable!(),
        };
        assert!(state.publish(second, ActiveGeneration::placeholder(second, None)));

        // The (already-superseded) first generation's own task finally
        // finishes and tries to clear itself — it must be a no-op now.
        state.clear_if_current(first);
        assert!(
            state.still_current(second),
            "clearing a stale generation must never clear the current one"
        );
    }

    /// Admits an incumbent announcing `key` and publishes `session` for it.
    fn incumbent(state: &ServeState, key: Option<&str>, session: Option<Session>) -> u64 {
        let Admission::Admitted { generation, .. } = state.try_admit(key) else {
            panic!("expected an empty runtime to admit the incumbent");
        };
        assert!(state.publish(
            generation,
            ActiveGeneration {
                generation,
                binding: key.map(str::to_owned),
                session,
                released: None,
            },
        ));
        generation
    }

    fn outcome(admission: &Admission) -> &'static str {
        match admission {
            Admission::Admitted { .. } => "admitted",
            Admission::Refused => "refused (shutdown)",
            Admission::AlreadyBound => "already bound",
        }
    }

    /// A handshaken session pair; the runtime half is returned.
    async fn live_session() -> (Session, Session) {
        let (hub_port, runtime_port) = port_pair();
        let (hub, _hub_driver) = Session::spawn(hub_port, SessionOptions::new(peer("hub")));
        let (runtime, _runtime_driver) =
            Session::spawn(runtime_port, SessionOptions::new(peer("runtime")));
        runtime.ready().await.expect("the pair handshakes");
        (runtime, hub)
    }

    fn peer(role: &str) -> PeerInfo {
        PeerInfo {
            name: "test".into(),
            version: "0.0.0".into(),
            role: role.into(),
        }
    }

    /// A live incumbent bound to one record refuses a newcomer for another,
    /// and stays exactly where it was — same generation, still current.
    #[tokio::test]
    async fn a_live_incumbent_refuses_a_newcomer_bound_to_another_record() {
        let state = ServeState::new();
        let (runtime, _hub) = live_session().await;
        let first = incumbent(&state, Some("record-a"), Some(runtime));

        let admission = state.try_admit(Some("record-b"));
        assert!(
            matches!(admission, Admission::AlreadyBound),
            "expected admission: already bound | received: {}",
            outcome(&admission)
        );
        assert!(
            state.still_current(first),
            "expected the incumbent to stay current after a refusal"
        );
    }

    /// A placeholder (admitted, no session yet) holds the runtime for its
    /// record too: its hub already said which record it speaks for.
    #[test]
    fn a_placeholder_incumbent_refuses_a_newcomer_bound_to_another_record() {
        let state = ServeState::new();
        let Admission::Admitted { generation, .. } = state.try_admit(Some("record-a")) else {
            panic!("expected an empty runtime to admit the incumbent");
        };
        let admission = state.try_admit(Some("record-b"));
        assert!(
            matches!(admission, Admission::AlreadyBound),
            "expected admission: already bound | received: {}",
            outcome(&admission)
        );
        assert!(state.still_current(generation));
    }

    /// The same record reconnecting, and every combination with an older hub
    /// that sends no key, keeps the pre-binding supersede behaviour.
    #[tokio::test]
    async fn the_same_record_or_a_keyless_side_still_supersedes() {
        for (incumbent_key, newcomer_key) in [
            (Some("record-a"), Some("record-a")),
            (Some("record-a"), None),
            (None, Some("record-b")),
            (None, None),
        ] {
            let state = ServeState::new();
            let (runtime, _hub) = live_session().await;
            incumbent(&state, incumbent_key, Some(runtime));

            let admission = state.try_admit(newcomer_key);
            let Admission::Admitted { previous, .. } = &admission else {
                panic!(
                    "expected admission: admitted (supersede) for incumbent {incumbent_key:?} \
                     and newcomer {newcomer_key:?} | received: {}",
                    outcome(&admission)
                );
            };
            assert!(
                previous.is_some(),
                "expected the incumbent handed back to be superseded for incumbent \
                 {incumbent_key:?} and newcomer {newcomer_key:?}"
            );
        }
    }

    /// An incumbent whose session has already closed — its hub went away,
    /// and its task has not cleared the slot yet — no longer holds the
    /// runtime: a newcomer for another record wins.
    #[tokio::test]
    async fn a_newcomer_for_another_record_wins_once_the_incumbent_has_closed() {
        let state = ServeState::new();
        let (runtime, hub) = live_session().await;
        incumbent(&state, Some("record-a"), Some(runtime.clone()));
        hub.close(4000, None).await;
        runtime.closed().await;
        assert_eq!(runtime.state(), SessionState::Closed);

        let admission = state.try_admit(Some("record-b"));
        assert!(
            matches!(
                admission,
                Admission::Admitted {
                    previous: Some(_),
                    ..
                }
            ),
            "expected admission: admitted over the closed incumbent | received: {}",
            outcome(&admission)
        );
    }

    /// An incumbent already released — superseded or cleared — is simply
    /// gone, and a newcomer for another record is admitted with nothing to
    /// supersede.
    #[tokio::test]
    async fn a_newcomer_for_another_record_is_admitted_once_the_incumbent_is_released() {
        let state = ServeState::new();
        let (runtime, _hub) = live_session().await;
        let first = incumbent(&state, Some("record-a"), Some(runtime));
        state.clear_if_current(first);

        let admission = state.try_admit(Some("record-b"));
        assert!(
            matches!(admission, Admission::Admitted { previous: None, .. }),
            "expected admission: admitted with nothing to supersede | received: {}",
            outcome(&admission)
        );
    }

    /// A keyed placeholder whose connection task panics after admission is
    /// released by its guard: another record is admitted afterwards, with
    /// nothing left to supersede.
    #[tokio::test]
    async fn a_keyed_admission_is_released_when_its_task_panics() {
        let state = Arc::new(ServeState::new());
        let task_state = Arc::clone(&state);
        let task = tokio::spawn(async move {
            let Admission::Admitted { generation, .. } = task_state.try_admit(Some("record-a"))
            else {
                panic!("expected an empty runtime to admit the incumbent");
            };
            let _admitted = AdmittedGeneration::new(&task_state, generation);
            panic!("the connection task failed after admission");
        });
        assert!(task.await.expect_err("the task panics").is_panic());

        let admission = state.try_admit(Some("record-b"));
        assert!(
            matches!(admission, Admission::Admitted { previous: None, .. }),
            "expected admission: admitted with nothing to supersede | received: {}",
            outcome(&admission)
        );
    }

    /// The same for a task that is aborted while it holds the admission.
    #[tokio::test]
    async fn a_keyed_admission_is_released_when_its_task_is_aborted() {
        let state = Arc::new(ServeState::new());
        let task_state = Arc::clone(&state);
        let (admitted_tx, admitted_rx) = oneshot::channel();
        let task = tokio::spawn(async move {
            let Admission::Admitted { generation, .. } = task_state.try_admit(Some("record-a"))
            else {
                panic!("expected an empty runtime to admit the incumbent");
            };
            let _admitted = AdmittedGeneration::new(&task_state, generation);
            let _ = admitted_tx.send(());
            std::future::pending::<()>().await;
        });
        admitted_rx.await.expect("the task admits before it parks");
        let refused = state.try_admit(Some("record-b"));
        assert!(
            matches!(refused, Admission::AlreadyBound),
            "expected the live admission to refuse another record | received: {}",
            outcome(&refused)
        );
        task.abort();
        assert!(task.await.expect_err("the task is aborted").is_cancelled());

        let admission = state.try_admit(Some("record-b"));
        assert!(
            matches!(admission, Admission::Admitted { previous: None, .. }),
            "expected admission: admitted with nothing to supersede | received: {}",
            outcome(&admission)
        );
    }
}
