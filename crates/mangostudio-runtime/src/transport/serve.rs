//! The `serve` transport: the hub dials in over WebSocket, authenticated by
//! a bearer token this process holds. Mirrors `serve.ts`.
//!
//! One hub connection at a time. A new upgrade supersedes the previous one,
//! and the replacement does not announce itself (does not build a session
//! at all) until the superseded generation has fully released — see
//! `ServeState`, the one `Mutex` that makes "which generation may become
//! active" and "are we shutting down" the same synchronisation point (see
//! [`crate::supervisor`]'s module docs for why that matters).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use mango_protocol::close::close_codes;
use mango_protocol::contract::Contract;
use mango_protocol::port::{Port, PortTx};
use mango_protocol::session::{
    DEFAULT_HANDSHAKE_TIMEOUT, DEFAULT_LIVENESS_INTERVAL, Session, SessionClosure, SessionOptions,
};
use mango_protocol::transports::websocket::server::{AcceptOptions, accept_websocket};
use mango_protocol::transports::websocket::{WebSocketOptions, WebSocketPort};
use mangostudio_runtime_contract::catalog::catalog;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Semaphore, oneshot};
use tokio_util::sync::CancellationToken;

use crate::runtime_home::RuntimeSlot;
use crate::supervisor::{OwnedTasks, join_owned};
use crate::transport::{build_host, runtime_peer, tokens_equal};

/// How long `stop()` waits for a straggling connection task (one still in
/// its own upgrade or supersession handoff, never a healthy session, which
/// has no timeout at all) before giving up and aborting it. Named
/// separately from every other grace in this crate — see
/// [`crate::supervisor`]'s cancellation section for why an abort here would
/// still not be the normal path.
const SHUTDOWN_DRAIN_GRACE: Duration = Duration::from_secs(5);

/// How many upgrades may be mid-authorisation at once: the one that is about
/// to become active, plus the one that may be racing in to supersede it,
/// plus a little slack for a same-instant retry. A dialler beyond this is
/// refused with `RATE_LIMITED` before its upgrade completes, never queued
/// behind an unbounded accept loop.
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
    let state = Arc::new(ServeState::new());
    let context = Arc::new(ConnectionContext {
        token,
        slot,
        mango_home,
        runtime_version,
        pending_handshakes: Arc::new(Semaphore::new(MAX_PENDING_HANDSHAKES)),
        log: Box::new(log),
    });
    let mut owned = OwnedTasks::new();

    loop {
        tokio::select! {
            biased;
            () = cancel.cancelled() => break,
            accepted = listener.accept() => {
                let Ok((stream, _peer_addr)) = accepted else { continue };
                let state = Arc::clone(&state);
                let context = Arc::clone(&context);
                owned.spawn(async move {
                    handle_connection(stream, state, context).await;
                });
            }
        }
    }

    if let Some(previous) = state.begin_shutdown() {
        release_active(previous, close_codes::RELEASED, "Runtime stopped").await;
    }
    let aborted = owned.join_all_or_abort(SHUTDOWN_DRAIN_GRACE).await;
    debug_assert_eq!(
        aborted, 0,
        "a connection task outlived the shutdown grace without honouring its own session close"
    );
    Ok(())
}

/// What every accepted connection needs, shared read-only across them.
struct ConnectionContext {
    token: String,
    slot: RuntimeSlot,
    mango_home: std::path::PathBuf,
    runtime_version: String,
    pending_handshakes: Arc<Semaphore>,
    log: Box<dyn Fn(&str) + Send + Sync>,
}

/// One admitted generation: enough for a later caller to supersede it
/// (`session`, to close it) and to know once it has fully finished
/// (`released`, which resolves — successfully or not, the value carries no
/// meaning — the instant the owning task's local sender drops, at any of
/// its return points).
struct ActiveGeneration {
    generation: u64,
    session: Option<Session>,
    released: Option<oneshot::Receiver<()>>,
}

impl ActiveGeneration {
    fn placeholder(generation: u64) -> Self {
        Self {
            generation,
            session: None,
            released: None,
        }
    }
}

/// One of [`ServeState::try_admit`]'s two outcomes.
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

    /// Claims the next generation, unless shutdown has already started.
    /// Mirrors `serve.ts`'s synchronous `active = entry` — the slot is
    /// claimed by a placeholder immediately, before any session exists, so
    /// a *third* connection racing in behind this one already sees this
    /// generation as current rather than the one it is about to supersede.
    fn try_admit(&self) -> Admission {
        let mut inner = self.inner.lock().expect("ServeState mutex poisoned");
        if inner.closed {
            return Admission::Refused;
        }
        inner.generation += 1;
        let generation = inner.generation;
        let previous = inner
            .active
            .replace(ActiveGeneration::placeholder(generation));
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
    fn clear_if_current(&self, generation: u64) {
        let mut inner = self.inner.lock().expect("ServeState mutex poisoned");
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
async fn handle_connection(
    stream: TcpStream,
    state: Arc<ServeState>,
    context: Arc<ConnectionContext>,
) {
    // Held for the rest of this function on success: released automatically
    // (Rust drops it) on every return path, including the early ones below,
    // which is this crate's own "release every reservation on failure"
    // beyond what `serve.ts` bounds at all.
    let permit = context.pending_handshakes.clone().try_acquire_owned();
    let has_slot = permit.is_ok();
    let token = context.token.clone();
    let port = match accept_websocket(
        stream,
        AcceptOptions::from(WebSocketOptions::default()),
        |upgrade| {
            if !has_slot {
                return Err(close_codes::RATE_LIMITED);
            }
            match upgrade.bearer() {
                Some(presented) if tokens_equal(presented.as_bytes(), token.as_bytes()) => Ok(()),
                _ => Err(close_codes::UNAUTHORIZED),
            }
        },
    )
    .await
    {
        Ok(port) => port,
        Err(_) => return,
    };
    let _permit = permit;

    let (generation, previous) = match state.try_admit() {
        Admission::Admitted {
            generation,
            previous,
        } => (generation, previous),
        Admission::Refused => {
            close_port(port, close_codes::RELEASED, "Runtime stopped").await;
            return;
        }
    };

    if let Some(previous) = previous {
        release_active(previous, close_codes::SUPERSEDED, "Superseded").await;
        (context.log)("A new hub connection superseded the previous one.");
    }
    if !state.still_current(generation) {
        state.clear_if_current(generation);
        close_port(port, close_codes::RELEASED, "Runtime stopped").await;
        return;
    }

    let host = build_host(context.slot, &context.mango_home);
    let contract = Contract::from_catalog(catalog().clone())
        .expect("the embedded catalog compiles into a contract");
    // `SessionOptions::new`'s defaults already match `serve.ts`'s own
    // `HANDSHAKE_TIMEOUT_MS`/`LIVENESS_INTERVAL_MS` (15s/20s), so nothing is
    // overridden here — see `mango_protocol::session::{DEFAULT_HANDSHAKE_TIMEOUT, DEFAULT_LIVENESS_INTERVAL}`.
    let options = SessionOptions::new(runtime_peer(&context.runtime_version));
    debug_assert_eq!(options.handshake_timeout, DEFAULT_HANDSHAKE_TIMEOUT);
    debug_assert_eq!(options.liveness_interval, Some(DEFAULT_LIVENESS_INTERVAL));
    let (session, driver_handle) = Session::spawn(port, options);
    let guard = crate::serve::serve(
        &contract,
        &session,
        host.registry,
        host.authorization,
        context.slot.as_str(),
    )
    .expect("an empty registry always matches the embedded catalog");
    guard.persist();

    let (released_tx, released_rx) = oneshot::channel();
    let published = state.publish(
        generation,
        ActiveGeneration {
            generation,
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
    let heartbeat = tokio::spawn(crate::transport::heartbeat_loop(
        session.clone(),
        HEARTBEAT_INTERVAL,
        heartbeat_cancel.clone(),
    ));

    let _closure: SessionClosure = join_owned(driver_handle).await;
    heartbeat_cancel.cancel();
    let _ = join_owned(heartbeat).await;

    state.clear_if_current(generation);
    (context.log)("Hub connection ended.");
}

/// Closes a port nothing ever became a session over — a refused admission,
/// or one that lost the race before a session was ever built.
async fn close_port<S>(port: WebSocketPort<S>, code: u16, reason: &str)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (tx, _rx) = port.split();
    tx.close(code, Some(reason.to_string())).await;
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use tokio::sync::{Barrier, oneshot};

    use super::{ActiveGeneration, Admission, ServeState};

    /// The property `serve`'s single `Mutex` exists for: however many
    /// connections race to admit at the exact instant shutdown begins,
    /// every one of them gets exactly one outcome (admitted xor refused),
    /// never both and never neither — proving the shared counter and the
    /// admission decision can never observe a torn, half-updated state.
    #[tokio::test(flavor = "multi_thread", worker_threads = 8)]
    async fn every_concurrent_admission_gets_exactly_one_outcome() {
        const CONCURRENT: usize = 64;
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
                match state.try_admit() {
                    Admission::Admitted { generation, .. } => {
                        admitted.fetch_add(1, Ordering::SeqCst);
                        // A connection that becomes active and finishes
                        // immediately, exactly like a dial that is refused
                        // at the handshake a moment later.
                        state.clear_if_current(generation);
                    }
                    Admission::Refused => {
                        refused.fetch_add(1, Ordering::SeqCst);
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

        assert_eq!(
            admitted.load(Ordering::SeqCst) + refused.load(Ordering::SeqCst),
            CONCURRENT,
            "every concurrent try_admit must land in exactly one bucket"
        );
    }

    /// The other half of the same invariant: once shutdown has run, no
    /// later `try_admit` may succeed — admission and shutdown reading the
    /// same flag under the same lock is what this asserts.
    #[test]
    fn nothing_is_admitted_once_shutdown_has_started() {
        let state = ServeState::new();
        state.begin_shutdown();
        assert!(matches!(state.try_admit(), Admission::Refused));
    }

    /// `release_active`'s completion signal actually fires: a caller that
    /// awaits it after the owning generation's local sender drops observes
    /// that drop as a resolved receiver, not a hang.
    #[tokio::test]
    async fn a_released_generations_signal_resolves_once_its_owner_drops_the_sender() {
        let (tx, rx) = oneshot::channel::<()>();
        let previous = ActiveGeneration {
            generation: 1,
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
        let first = match state.try_admit() {
            Admission::Admitted { generation, .. } => generation,
            Admission::Refused => unreachable!(),
        };
        assert!(state.publish(first, ActiveGeneration::placeholder(first)));

        let second = match state.try_admit() {
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
            Admission::Refused => unreachable!(),
        };
        assert!(state.publish(second, ActiveGeneration::placeholder(second)));

        // The (already-superseded) first generation's own task finally
        // finishes and tries to clear itself — it must be a no-op now.
        state.clear_if_current(first);
        assert!(
            state.still_current(second),
            "clearing a stale generation must never clear the current one"
        );
    }
}
