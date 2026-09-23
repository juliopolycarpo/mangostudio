//! The process-wide release of what hub sessions leave running when this runtime shuts down.
//!
//! A host's session or loop ending does not end the MCP servers and terminals its handlers
//! started: their teardown runs on tasks of its own, and dropping the Tokio runtime cancels every
//! async task at once. Without a wait, the parent-death lease reaps those trees with SIGKILL and a
//! server never sees the end of input or SIGTERM it is owed. This module is that wait, the Rust
//! counterpart of the TypeScript host's `whenRuntimeReleased`: every child owner holds an
//! [`Owner`] guard, and each host awaits [`Release::released`] before shutting its runtime down.
//!
//! # The shutdown budget
//!
//! The Hub stops a stdio runtime by ending its stdin, sending SIGTERM [`HUB_TERMINATE_GRACE`]
//! later and SIGKILL [`HUB_KILL_GRACE`] after that (`TERMINATE_GRACE_MS` and `KILL_GRACE_MS` in
//! `apps/api/src/services/runtime-client/spawn-runtime-child.ts`). Whether the Hub should widen
//! that window while work is running is an open decision owned by the Hub, so the runtime fits
//! inside it. Measured from the instant shutdown begins (`T0`, end of input or the first signal):
//!
//! | phase                                   | ends by      |
//! |-----------------------------------------|--------------|
//! | EOF grace, every server concurrently    | `T0 + 1.0 s` ([`EOF_CUTOFF`]) |
//! | SIGTERM grace, every server concurrently| `T0 + 2.0 s` ([`TERM_CUTOFF`]) |
//! | forced kill and empty-tree proof        | `T0 + 2.75 s` ([`PROOF_CUTOFF`]) |
//! | every owner reported released           | `T0 + 3.0 s` ([`SHUTDOWN_BUDGET`]) |
//! | blocking-task grace in `shut_down`      | `T0 + 3.5 s` ([`EXIT_DEADLINE`]) |
//! | Hub SIGKILL                             | `T0 + 4.0 s` |
//!
//! Each MCP server's ordinary graces (two seconds each, matching the SDK's close) are compressed
//! to these cut-offs only once shutdown has begun, so a single `mcp.disconnect` still gets the
//! full sequence. The half second left before SIGKILL is the margin for process exit itself.
//!
//! The budget is best effort before the Hub's SIGKILL, not a guarantee of an orderly stop: in
//! the ordinary case, a stubborn tree included, the forced kill's proof completes well inside it,
//! but a tree whose proof is still missing at [`PROOF_CUTOFF`] is abandoned, and the Unix
//! guardian's parent-death lease or the Windows kill-on-close Job is the backstop that ends it.
//!
//! On Windows the Hub has no signals to send: both escalation steps become process termination
//! at `T0 + 2 s`. The runtime cannot interrupt a Job-contained server gracefully either, so a
//! server still running at [`EOF_CUTOFF`] is killed at once and the SIGTERM phase never runs;
//! the end-of-input grace and the forced kill both finish before the Hub's termination, and the
//! kill-on-close Job ends anything left if the Hub's termination lands first.

use std::sync::OnceLock;
use std::time::Duration;

use tokio::sync::watch;
use tokio::time::Instant;

/// The Hub's grace between end of stdin and SIGTERM.
pub(crate) const HUB_TERMINATE_GRACE: Duration = Duration::from_secs(2);
/// The Hub's further grace between SIGTERM and SIGKILL.
pub(crate) const HUB_KILL_GRACE: Duration = Duration::from_secs(2);
/// When, after shutdown begins, a server still running after end of input is sent SIGTERM.
pub(crate) const EOF_CUTOFF: Duration = Duration::from_millis(1_000);
/// When, after shutdown begins, a server still running after SIGTERM is killed.
pub(crate) const TERM_CUTOFF: Duration = Duration::from_millis(2_000);
/// When, after shutdown begins, an owner stops waiting for its empty-tree proof and reports
/// released; the quarter second before [`SHUTDOWN_BUDGET`] covers dropping its handles.
pub(crate) const PROOF_CUTOFF: Duration = Duration::from_millis(2_750);
/// How long, after shutdown begins, a host waits for every owner to release. Best effort before
/// the Hub's SIGKILL: an owner still working at this point is abandoned, and the Unix guardian's
/// parent-death lease or the Windows kill-on-close Job ends its tree with the process.
pub(crate) const SHUTDOWN_BUDGET: Duration = Duration::from_millis(3_000);
/// When, after shutdown begins, the process must be leaving: the blocking-task grace in
/// `cli.rs`'s `shut_down` is capped here.
pub(crate) const EXIT_DEADLINE: Duration = Duration::from_millis(3_500);

const _: () = assert!(EOF_CUTOFF.as_millis() < TERM_CUTOFF.as_millis());
const _: () = assert!(TERM_CUTOFF.as_millis() < PROOF_CUTOFF.as_millis());
const _: () = assert!(PROOF_CUTOFF.as_millis() < SHUTDOWN_BUDGET.as_millis());
const _: () = assert!(SHUTDOWN_BUDGET.as_millis() < EXIT_DEADLINE.as_millis());
const _: () = assert!(
    EXIT_DEADLINE.as_millis() < HUB_TERMINATE_GRACE.as_millis() + HUB_KILL_GRACE.as_millis()
);

/// Tracks the owners still releasing a child and the instant shutdown began.
pub(crate) struct Release {
    began: watch::Sender<Option<Instant>>,
    live: watch::Sender<usize>,
}

/// Held by a task that owns a child process tree; dropping it reports the tree released.
#[must_use = "an owner guard counts only while it is held"]
pub(crate) struct Owner {
    live: watch::Sender<usize>,
}

impl Drop for Owner {
    fn drop(&mut self) {
        self.live.send_modify(|live| *live = live.saturating_sub(1));
    }
}

impl Release {
    /// A tracker of its own; production code shares [`Self::process`], tests isolate with this.
    pub(crate) fn new() -> Self {
        Self {
            began: watch::Sender::new(None),
            live: watch::Sender::new(0),
        }
    }

    /// The one tracker this process's hosts and child owners share.
    ///
    /// # Example
    /// ```ignore
    /// let _owner = crate::release::Release::process().own();
    /// ```
    pub(crate) fn process() -> &'static Self {
        static PROCESS: OnceLock<Release> = OnceLock::new();
        PROCESS.get_or_init(Self::new)
    }

    /// Registers one child owner; take it before spawning the task that will hold it, so a
    /// host can never observe "released" between the spawn and the task's first poll.
    ///
    /// # Example
    /// ```ignore
    /// let owner = Release::process().own();
    /// tokio::spawn(async move { let _owner = owner; supervise().await });
    /// ```
    pub(crate) fn own(&self) -> Owner {
        self.live.send_modify(|live| *live += 1);
        Owner {
            live: self.live.clone(),
        }
    }

    /// Marks the instant shutdown began. Only the first call counts, so every host can call it
    /// on every exit path.
    ///
    /// # Example
    /// ```ignore
    /// Release::process().begin();
    /// ```
    pub(crate) fn begin(&self) {
        self.began.send_if_modified(|began| {
            if began.is_some() {
                return false;
            }
            *began = Some(Instant::now());
            true
        });
    }

    /// Resolves `offset` after shutdown began; pending for as long as it has not.
    ///
    /// # Example
    /// ```ignore
    /// tokio::select! {
    ///     status = child.wait() => {}
    ///     () = Release::process().cutoff(EOF_CUTOFF) => {}
    /// }
    /// ```
    pub(crate) async fn cutoff(&self, offset: Duration) {
        let mut began = self.began.subscribe();
        let Ok(start) = began.wait_for(Option::is_some).await.map(|began| *began) else {
            return std::future::pending().await;
        };
        let start = start.expect("wait_for returned a begun instant");
        tokio::time::sleep_until(start + offset).await;
    }

    /// Begins shutdown if nothing has, then waits until every owner has released or
    /// [`SHUTDOWN_BUDGET`] has passed since shutdown began. Returns whether all released.
    ///
    /// # Example
    /// ```ignore
    /// let released = runtime.block_on(Release::process().released());
    /// ```
    pub(crate) async fn released(&self) -> bool {
        self.begin();
        let mut live = self.live.subscribe();
        tokio::select! {
            biased;
            idle = live.wait_for(|live| *live == 0) => idle.is_ok(),
            () = self.cutoff(SHUTDOWN_BUDGET) => *self.live.borrow() == 0,
        }
    }

    /// `grace`, shortened to what is left before [`EXIT_DEADLINE`] while that window is still
    /// open. A host that outlived the window (end of input with no signal, waiting on an install
    /// step, or a long serve drain) has no Hub SIGKILL to beat, so it keeps the full `grace`.
    ///
    /// # Example
    /// ```ignore
    /// runtime.shutdown_timeout(Release::process().exit_grace(Duration::from_secs(2)));
    /// ```
    pub(crate) fn exit_grace(&self, grace: Duration) -> Duration {
        let Some(began) = *self.began.borrow() else {
            return grace;
        };
        let left = (began + EXIT_DEADLINE).saturating_duration_since(Instant::now());
        if left.is_zero() {
            return grace;
        }
        grace.min(left)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    #[tokio::test(start_paused = true)]
    async fn released_waits_for_every_owner() {
        let release = Release::new();
        let first = release.own();
        let second = release.own();
        let started = Instant::now();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(400)).await;
            drop(first);
            tokio::time::sleep(Duration::from_millis(400)).await;
            drop(second);
        });
        let released = release.released().await;
        let took = started.elapsed();
        assert!(
            released,
            "expected released: true | received false after {took:?}"
        );
        assert_eq!(
            took,
            Duration::from_millis(800),
            "expected release when the last owner drops | received {took:?}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn released_gives_up_at_the_budget() {
        let release = Release::new();
        let _stuck = release.own();
        let started = Instant::now();
        let released = release.released().await;
        let took = started.elapsed();
        assert!(!released, "expected released: false | received true");
        assert_eq!(
            took, SHUTDOWN_BUDGET,
            "expected the wait to end at {SHUTDOWN_BUDGET:?} | received {took:?}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn the_budget_runs_from_the_first_begin() {
        let release = Release::new();
        let _stuck = release.own();
        release.begin();
        tokio::time::sleep(Duration::from_millis(2_500)).await;
        release.begin();
        let started = Instant::now();
        let _ = release.released().await;
        let took = started.elapsed();
        assert_eq!(
            took,
            Duration::from_millis(500),
            "expected the budget anchored at the first begin | received {took:?}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn nothing_owned_is_released_at_once() {
        let release = Release::new();
        let started = Instant::now();
        assert!(
            release.released().await,
            "expected released: true | received false"
        );
        assert_eq!(started.elapsed(), Duration::ZERO);
    }

    #[tokio::test(start_paused = true)]
    async fn a_cutoff_waits_for_begin_then_its_offset() {
        let release = Arc::new(Release::new());
        let waiter = Arc::clone(&release);
        let started = Instant::now();
        let cut = tokio::spawn(async move {
            waiter.cutoff(EOF_CUTOFF).await;
            started.elapsed()
        });
        tokio::time::sleep(Duration::from_millis(700)).await;
        assert!(
            !cut.is_finished(),
            "expected a cutoff pending before begin | received resolved"
        );
        release.begin();
        let took = cut.await.expect("the cutoff task completes");
        assert_eq!(
            took,
            Duration::from_millis(700) + EOF_CUTOFF,
            "expected begin + {EOF_CUTOFF:?} | received {took:?}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn exit_grace_is_capped_by_the_exit_deadline() {
        let release = Release::new();
        let grace = Duration::from_secs(2);
        assert_eq!(
            release.exit_grace(grace),
            grace,
            "expected the full grace before shutdown begins"
        );
        release.begin();
        tokio::time::sleep(Duration::from_millis(2_500)).await;
        assert_eq!(
            release.exit_grace(grace),
            Duration::from_millis(1_000),
            "expected the grace capped at {EXIT_DEADLINE:?} after begin"
        );
        tokio::time::sleep(Duration::from_secs(5)).await;
        assert_eq!(
            release.exit_grace(grace),
            grace,
            "expected the full grace once the Hub's window has passed"
        );
    }
}
