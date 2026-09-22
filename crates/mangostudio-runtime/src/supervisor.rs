//! Ownership and state transitions for [`crate::transport`]'s three entry
//! points, and the primitive every one of them uses to hold its owned tasks.
//!
//! # Owners
//!
//! | What | Owned by | Ends when |
//! | --- | --- | --- |
//! | The runtime process | `main`/`cli` | every subcommand below returns |
//! | A `stdio` session | `transport::stdio::run` | the driver's `JoinHandle<SessionClosure>` resolves |
//! | A `serve` connection | `ServeState`, behind one `Mutex` | this or a newer generation releases it |
//! | A `serve` accept loop | `transport::serve::run`'s [`OwnedTasks`] | `stop()` awaits every owned task |
//! | A `connect` dial | `transport::connect::run_one_connection`'s local scope | the dial's own `finally`-equivalent releases it before the next one starts |
//! | A `connect` heartbeat | the same dial's scope | stopped before that dial's driver is awaited |
//! | Every `Session` driver | the code that called [`mango_protocol::session::Session::spawn`] | its `JoinHandle<SessionClosure>` is awaited, never aborted |
//!
//! **No fire-and-forget.** Every `tokio::spawn` in this crate hands its
//! `JoinHandle` to something that awaits it before its own scope exits —
//! [`OwnedTasks`] for a variable number of same-shaped tasks (accepted
//! connections in `serve`), a named local variable for a single one (a
//! dial's heartbeat, a session's driver, `cli`'s own signal-to-cancellation
//! watcher spawned by [`ShutdownSignals::watch`]).
//!
//! # State transitions
//!
//! A [`mango_protocol::session::Session`] already has its own three states
//! (`Handshaking` → `Ready` → `Closed`); this module does not duplicate
//! them. What it adds is the *transport*-level state around one or more
//! sessions:
//!
//! - **stdio**: `Idle → Serving → Released`. One session, one transition
//!   each way; `Released` is reached by exactly one path — the driver's
//!   `JoinHandle` resolving — whether that was a clean peer close, an EOF, or
//!   a `SIGINT`/`SIGTERM` calling [`mango_protocol::session::Session::close_now`]
//!   first.
//! - **serve**: `Idle → Active(generation) → Idle` (superseded or released),
//!   with `Closed` a terminal fourth state reachable from any of the above.
//!   Exactly one [`mango_protocol::session::Session`] is `Active` at a time;
//!   see `transport::serve`'s `ServeState` for the single mutex that makes
//!   "which generation is active" and "are we shutting down" the same
//!   synchronisation point.
//! - **connect**: `Dialling → Handshaking → Connected → Released`, looping
//!   back to `Dialling` after a backoff unless the closure was fatal (see
//!   `transport::connect::classify_closure`) or the process was asked to
//!   stop.
//!
//! # Admission and shutdown share one synchronisation point
//!
//! `stdio` has nothing to admit (one session, decided once at startup) and
//! `connect` has nothing to *accept* (it dials out), so the property this
//! section is about is `serve`'s alone: **the same `Mutex` that decides
//! whether a new connection may become active is the one shutdown sets its
//! flag under.** There is deliberately no separate "admission gate"
//! alongside it — a second lock guarding the same decision is a second
//! place the two could disagree about whether admission is still open,
//! which is exactly the race this module exists to rule out. See
//! `transport::serve::ServeState` and its `admit`/`begin_shutdown` methods,
//! and the barrier-based test in `transport::serve`'s test module that
//! drives N connections through `admit` concurrently with a `stop()` and
//! asserts `admitted + refused == N` with no double-active generation.
//!
//! # Cancellation is cooperative
//!
//! Every long-running loop in [`crate::transport`] (the `serve` accept
//! loop, the `connect` dial loop) checks a [`tokio_util::sync::CancellationToken`]
//! at its own natural yield points — before accepting, before dialling
//! again, in the `tokio::select!` racing a backoff sleep — and unwinds by
//! returning, the same way a `SIGINT` unwinds a `stdio` session by calling
//! [`mango_protocol::session::Session::close_now`] and then awaiting the
//! driver. Nothing in this crate's own code calls `.abort()` on a
//! [`tokio::task::JoinHandle`] as its normal shutdown path — the sole
//! exception is [`OwnedTasks`]'s own `join_all_or_abort`, a bounded
//! last-resort for a task that ignored its cancellation token, and that
//! path is itself tested to *not* fire on the happy path (see
//! `transport::serve`'s tests).
//!
//! # Limits owned elsewhere
//!
//! Every resource this crate spawns or admits has a named bound — see each
//! transport module's own constants. Two live outside this module:
//!
//! - **Blocking workers.** [`crate::blocking::run_blocking`] bounds every
//!   blocking filesystem, hash, and process call with
//!   [`crate::blocking::MAX_CONCURRENT_BLOCKING_TASKS`].
//! - **Output tails.** Each spawned process's captured output is bounded by
//!   its [`crate::subprocess::ProcessBudget`]. No PTY exists yet;
//!   the terminal plan owns that bound.

use std::future::Future;
use std::time::Duration;

use tokio::task::{JoinHandle, JoinSet};

/// A set of same-shaped tasks with one owner, so "every spawned task is
/// awaited before its owner's scope ends" is a type a caller holds, not a
/// convention it has to remember.
///
/// `serve`'s accept loop is `OwnedTasks`' one real user today: each accepted
/// connection becomes one owned task, and `shutdown` is what `ServeState`'s
/// `stop()` awaits after it has told every connection to release.
#[derive(Default)]
pub struct OwnedTasks {
    tasks: JoinSet<()>,
}

impl OwnedTasks {
    /// An empty set.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Spawns `future` and takes ownership of its `JoinHandle`.
    pub fn spawn<F>(&mut self, future: F)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        self.tasks.spawn(future);
    }

    /// How many owned tasks have not yet finished.
    #[must_use]
    pub fn len(&self) -> usize {
        self.tasks.len()
    }

    /// True when no task is owned.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.tasks.is_empty()
    }

    /// Waits for every owned task to finish on its own — the cooperative
    /// path every owned task in this crate is expected to take, since each
    /// one already watches a [`tokio_util::sync::CancellationToken`] this
    /// caller cancelled before calling this.
    pub async fn join_all(&mut self) {
        while self.tasks.join_next().await.is_some() {}
    }

    /// Reaps one already-finished owned task, without waiting for any that
    /// are still running — `None` when nothing is owned at all, so a
    /// caller can put this directly in a `select!` alongside a branch that
    /// may stay pending indefinitely, without it becoming a busy
    /// `Ready(None)` on every poll: [`tokio::task::JoinSet::join_next`]
    /// resolves to `None` immediately on an empty set, which inside a
    /// `loop { select! { ... } }` with nothing else ready would otherwise
    /// spin.
    ///
    /// Discards the result exactly like [`OwnedTasks::join_all`] does — a
    /// panic here is caught the same way it always was, just reaped
    /// incrementally rather than only at shutdown. Without this, `serve`'s
    /// accept loop only ever reaped a finished connection task at
    /// shutdown, so a long-lived process (routinely bound to more than
    /// loopback) accumulated one dead `JoinSet` entry per historical
    /// connection for its entire uptime.
    pub async fn reap_one(&mut self) -> Option<()> {
        if self.tasks.is_empty() {
            std::future::pending().await
        } else {
            self.tasks.join_next().await.map(|_| ())
        }
    }

    /// [`OwnedTasks::join_all`], but gives up and aborts whatever is left
    /// once `grace` has passed — a bounded last resort for a task that did
    /// not honour its cancellation token, never the normal path. A caller
    /// that reaches this having actually needed the abort has a task worth
    /// fixing, not a shutdown sequence to lean on.
    ///
    /// Returns the number of tasks this call had to abort, so a caller can
    /// assert `0` on its own happy-path tests.
    pub async fn join_all_or_abort(&mut self, grace: Duration) -> usize {
        if tokio::time::timeout(grace, self.join_all()).await.is_ok() {
            return 0;
        }
        let aborted = self.tasks.len();
        self.tasks.shutdown().await;
        aborted
    }
}

/// Awaits `handle`, asserting by construction (the return type) that this is
/// a *join*, never an abort: every driver `JoinHandle` in [`crate::transport`]
/// is awaited through a call shaped like this one, not raced against a
/// timeout that would otherwise tempt a caller into aborting it instead.
///
/// # Panics
/// If `handle`'s task panicked (propagated) or was aborted from outside this
/// crate — both are `JoinError`, and both indicate a bug worth surfacing
/// loudly rather than swallowing into a synthetic closure.
pub async fn join_owned<T>(handle: JoinHandle<T>) -> T {
    handle
        .await
        .expect("an owned task must run to completion, never be aborted or panic")
}

/// `SIGINT`/`SIGTERM` (Unix) or `CTRL_C` (Windows), unified behind one
/// [`ShutdownSignals::wait`] — every handler **eagerly** registered by
/// [`ShutdownSignals::install`], never inside `wait` itself.
///
/// That distinction is not cosmetic: `tokio::signal::ctrl_c()`'s own
/// documentation says its listener is installed "when [the future is] first
/// polled", not when it is called. A caller that only reaches for it lazily
/// — inside a `select!` arm sitting after a stretch of its own setup work —
/// loses any signal that arrives in that window to the process's default
/// disposition: no cooperative close, no exit code this crate controls.
/// `tokio::signal::unix::signal` and `tokio::signal::windows::ctrl_c` both
/// register at the call itself, which is why [`ShutdownSignals::install`]
/// is the only place either is ever called.
pub struct ShutdownSignals {
    #[cfg(unix)]
    interrupt: tokio::signal::unix::Signal,
    #[cfg(unix)]
    terminate: tokio::signal::unix::Signal,
    #[cfg(windows)]
    ctrl_c: tokio::signal::windows::CtrlC,
}

impl ShutdownSignals {
    /// Registers every platform handler immediately.
    #[cfg(unix)]
    pub fn install() -> std::io::Result<Self> {
        Ok(Self {
            interrupt: tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?,
            terminate: tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?,
        })
    }

    /// Registers every platform handler immediately.
    #[cfg(windows)]
    pub fn install() -> std::io::Result<Self> {
        Ok(Self {
            ctrl_c: tokio::signal::windows::ctrl_c()?,
        })
    }

    /// Resolves once any registered signal arrives.
    #[cfg(unix)]
    pub async fn wait(&mut self) {
        tokio::select! {
            _ = self.interrupt.recv() => {}
            _ = self.terminate.recv() => {}
        }
    }

    /// Resolves once any registered signal arrives.
    #[cfg(windows)]
    pub async fn wait(&mut self) {
        self.ctrl_c.recv().await;
    }

    /// Spawns an owned task that cancels `token` the first time a signal
    /// arrives, and returns its `JoinHandle` — the caller decides how to
    /// hold it (this crate's own rule is that every spawn does), not this
    /// function, which would otherwise be exactly the fire-and-forget spawn
    /// the rest of this module argues against.
    #[must_use]
    pub fn watch(mut self, token: tokio_util::sync::CancellationToken) -> JoinHandle<()> {
        tokio::spawn(async move {
            self.wait().await;
            token.cancel();
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use tokio_util::sync::CancellationToken;

    use super::OwnedTasks;

    /// `reap_one` drains a finished task's entry without waiting for a
    /// sibling that is still running — the property `serve`'s accept loop
    /// leans on to avoid accumulating one dead entry per historical
    /// connection.
    #[tokio::test]
    async fn reap_one_drains_a_finished_tasks_entry_without_waiting_for_the_rest() {
        let mut owned = OwnedTasks::new();
        owned.spawn(async {});
        owned.spawn(std::future::pending::<()>());
        assert_eq!(owned.len(), 2);

        // Let the immediately-finishing task actually run to completion —
        // it was only just spawned, not yet polled.
        tokio::task::yield_now().await;

        assert_eq!(owned.reap_one().await, Some(()));
        assert_eq!(
            owned.len(),
            1,
            "the finished task's entry must be gone, the pending one must remain"
        );
    }

    /// `reap_one` on an empty set never resolves — the documented reason a
    /// caller may put it in a `select!` alongside a branch that legitimately
    /// stays pending, without it turning into a busy spin.
    #[tokio::test]
    async fn reap_one_on_an_empty_set_never_resolves() {
        let mut owned = OwnedTasks::new();
        assert!(
            tokio::time::timeout(Duration::from_millis(50), owned.reap_one())
                .await
                .is_err(),
            "an empty set must never resolve reap_one, not resolve it to None"
        );
    }

    /// `serve`'s accept loop races `reap_one` against `listener.accept()`
    /// inside a `biased` `select!`, and `accept()` stays ready for as long
    /// as the kernel backlog holds connections — precisely the
    /// unauthenticated flood the incremental reap exists to survive. This
    /// models that load abstractly, as the one property that actually
    /// matters to `tokio::select!`'s own semantics: a competing branch
    /// that is *never* once `Pending`, rather than an OS-level TCP flood
    /// (which cannot deterministically guarantee that in a test).
    ///
    /// Measured, not assumed: with the two branches in the reverse order —
    /// `accept`-analogue first, `reap_one` second, the order this crate
    /// shipped in originally — every one of these 50 rounds reaps zero
    /// completed tasks, because `biased` never once reaches the
    /// second branch while the first stays ready. Listing `reap_one`
    /// first is what this test proves fixes it: an empty `OwnedTasks`
    /// awaits `std::future::pending()` (see `reap_one_on_an_empty_set_never_resolves`),
    /// which never reports `Ready`, so `biased` still falls through to the
    /// competing branch on every round where nothing is finished — this
    /// changes only which branch wins when *both* are ready, never which
    /// one is polled first.
    #[tokio::test]
    async fn reap_one_is_not_starved_by_a_continuously_ready_competing_branch() {
        let mut owned = OwnedTasks::new();
        for _ in 0..50 {
            owned.spawn(async {});
        }
        // Let every spawned task actually run to completion before racing
        // the reap against anything — otherwise this measures scheduling
        // latency, not the `select!` ordering under test.
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
        assert_eq!(
            owned.len(),
            50,
            "every spawned task must have finished by now"
        );

        let mut reaped = 0;
        for _ in 0..50 {
            tokio::select! {
                biased;
                _ = owned.reap_one() => { reaped += 1; }
                () = std::future::ready(()) => {
                    // The `listener.accept()` analogue: ready on every
                    // single poll, exactly like a kernel backlog that
                    // never once drains during a flood.
                }
            }
        }
        assert_eq!(
            reaped, 50,
            "reap_one must still be serviced every round even though the competing branch is \
             always ready"
        );
        assert_eq!(
            owned.len(),
            0,
            "every finished task's entry must have been drained"
        );
    }

    #[tokio::test]
    async fn join_all_waits_for_every_owned_task_cooperatively() {
        let mut owned = OwnedTasks::new();
        let finished = Arc::new(AtomicUsize::new(0));
        let cancel = CancellationToken::new();

        for _ in 0..3 {
            let finished = Arc::clone(&finished);
            let cancel = cancel.clone();
            owned.spawn(async move {
                cancel.cancelled().await;
                finished.fetch_add(1, Ordering::SeqCst);
            });
        }
        assert_eq!(owned.len(), 3);

        cancel.cancel();
        owned.join_all().await;
        assert_eq!(
            finished.load(Ordering::SeqCst),
            3,
            "every task must have observed cancellation and run its own cleanup, not been aborted"
        );
        assert!(owned.is_empty());
    }

    /// The discriminating case `join_all_or_abort` exists for: a task that
    /// never observes its cancellation token at all. This must be the *only*
    /// path in this crate that ever aborts a task, and it must report that
    /// it had to.
    #[tokio::test]
    async fn join_all_or_abort_only_aborts_a_task_that_ignored_cancellation() {
        let mut owned = OwnedTasks::new();
        owned.spawn(async {
            // Never checks a cancellation token — the misbehaving case.
            std::future::pending::<()>().await;
        });

        let aborted = owned.join_all_or_abort(Duration::from_millis(50)).await;
        assert_eq!(
            aborted, 1,
            "the stuck task must be the one reported aborted"
        );
    }

    /// The happy-path proof the module docs promise: a well-behaved task
    /// (one that reacts to cancellation) is joined, never aborted, even when
    /// `join_all_or_abort`'s grace is tight.
    #[tokio::test]
    async fn join_all_or_abort_reports_zero_when_every_task_cooperates() {
        let mut owned = OwnedTasks::new();
        let cancel = CancellationToken::new();
        let cancel_for_task = cancel.clone();
        owned.spawn(async move {
            cancel_for_task.cancelled().await;
        });

        cancel.cancel();
        let aborted = owned.join_all_or_abort(Duration::from_secs(5)).await;
        assert_eq!(
            aborted, 0,
            "a cooperating task must never be counted as aborted"
        );
    }
}
