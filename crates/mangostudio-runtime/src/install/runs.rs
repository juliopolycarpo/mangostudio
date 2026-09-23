//! The process-wide table of install runs and each run's stop state.
//!
//! A run is owned here, not by the connection that started it: a reconnecting hub sees a still
//! running step (and cannot start a second run under its id), and the stdio host can wait for
//! every running step to settle before it exits on end of input.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};

use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

/// How many `install.cancel` ids for not-yet-seen runs are remembered.
///
/// The hub may send `install.cancel` before `install.run` (an abort while it is still resolving
/// the connection), and concurrently dispatched handlers do not preserve frame order. Remembering
/// a bounded number of such ids lets the later `install.run` settle as `cancelled` without
/// launching anything. The oldest id is forgotten first.
pub(crate) const MAX_EARLY_CANCELLED_RUNS: usize = 64;

/// Why a run's chain is stopping. The first reason recorded wins.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum StopReason {
    /// The hub called `install.cancel`.
    Cancelled,
    /// The hub session ended, or the hub abandoned the `install.run` request.
    HubLost,
    /// Shell consent was withdrawn on this machine.
    ConsentRevoked,
}

/// One run's stop state, shared by its owner, its request handler and `install.cancel`.
#[derive(Debug)]
pub(crate) struct RunControl {
    launch: CancellationToken,
    stop: watch::Sender<Option<StopReason>>,
}

impl RunControl {
    fn new() -> Self {
        Self {
            launch: CancellationToken::new(),
            stop: watch::channel(None).0,
        }
    }

    /// Marks the chain stopping. Before launch this prevents the launch; after launch the
    /// running step keeps its owner and finishes within its own deadline.
    ///
    /// # Example
    ///
    /// ```ignore
    /// control.request_stop(StopReason::Cancelled);
    /// assert!(control.launch_token().is_cancelled());
    /// ```
    pub(crate) fn request_stop(&self, reason: StopReason) {
        self.stop.send_if_modified(|current| {
            if current.is_some() {
                return false;
            }
            *current = Some(reason);
            true
        });
        self.launch.cancel();
    }

    /// The token the supervisor observes until the effect is released.
    pub(crate) fn launch_token(&self) -> &CancellationToken {
        &self.launch
    }

    /// The first recorded stop reason, if any.
    pub(crate) fn stop_reason(&self) -> Option<StopReason> {
        *self.stop.borrow()
    }

    /// A receiver that observes the stop reason being recorded.
    pub(crate) fn subscribe(&self) -> watch::Receiver<Option<StopReason>> {
        self.stop.subscribe()
    }
}

#[derive(Default)]
struct State {
    active: HashMap<String, Arc<RunControl>>,
    early_cancelled: VecDeque<String>,
}

/// Every install run this process owns, keyed by the hub-minted run id.
pub(crate) struct InstallRuns {
    state: Mutex<State>,
    active: watch::Sender<usize>,
}

impl Default for InstallRuns {
    fn default() -> Self {
        Self {
            state: Mutex::new(State::default()),
            active: watch::channel(0).0,
        }
    }
}

/// `install.run` for an id that is still active.
#[derive(Debug, Eq, PartialEq)]
pub(crate) struct AlreadyActive;

impl InstallRuns {
    /// The table every production connection shares.
    pub(crate) fn process() -> Arc<Self> {
        static RUNS: OnceLock<Arc<InstallRuns>> = OnceLock::new();
        Arc::clone(RUNS.get_or_init(|| Arc::new(Self::default())))
    }

    /// Reserves `run_id` before any effect. A run cancelled before it was seen starts stopped.
    ///
    /// # Example
    ///
    /// ```ignore
    /// let runs = Arc::new(InstallRuns::default());
    /// let lease = runs.reserve("run-1").unwrap();
    /// assert!(runs.reserve("run-1").is_err());
    /// drop(lease);
    /// ```
    pub(crate) fn reserve(self: &Arc<Self>, run_id: &str) -> Result<RunLease, AlreadyActive> {
        let control = Arc::new(RunControl::new());
        let count = {
            let mut state = self.lock();
            if state.active.contains_key(run_id) {
                return Err(AlreadyActive);
            }
            if let Some(index) = state.early_cancelled.iter().position(|id| id == run_id) {
                state.early_cancelled.remove(index);
                control.request_stop(StopReason::Cancelled);
            }
            state.active.insert(run_id.to_owned(), Arc::clone(&control));
            state.active.len()
        };
        self.active.send_replace(count);
        Ok(RunLease {
            runs: Arc::clone(self),
            run_id: run_id.to_owned(),
            control,
        })
    }

    /// Records `reason` for an active run, or remembers an explicit cancel for a run not yet seen.
    /// A cancel for a run that already settled is not an error.
    pub(crate) fn stop(&self, run_id: &str, reason: StopReason) {
        let mut state = self.lock();
        if let Some(control) = state.active.get(run_id) {
            control.request_stop(reason);
            return;
        }
        if reason != StopReason::Cancelled || state.early_cancelled.iter().any(|id| id == run_id) {
            return;
        }
        if state.early_cancelled.len() == MAX_EARLY_CANCELLED_RUNS {
            state.early_cancelled.pop_front();
        }
        state.early_cancelled.push_back(run_id.to_owned());
    }

    /// Resolves once no run is active. Every active run is bounded by its own step deadline.
    pub(crate) async fn settled(&self) {
        let mut active = self.active.subscribe();
        let _ = active.wait_for(|count| *count == 0).await;
    }

    fn release(&self, run_id: &str, control: &Arc<RunControl>) {
        let count = {
            let mut state = self.lock();
            if state
                .active
                .get(run_id)
                .is_some_and(|current| Arc::ptr_eq(current, control))
            {
                state.active.remove(run_id);
            }
            state.active.len()
        };
        self.active.send_replace(count);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Ownership of one reserved run id; dropping it (even while unwinding) frees the id.
pub(crate) struct RunLease {
    runs: Arc<InstallRuns>,
    run_id: String,
    control: Arc<RunControl>,
}

impl RunLease {
    /// This run's shared stop state.
    pub(crate) fn control(&self) -> &Arc<RunControl> {
        &self.control
    }
}

impl Drop for RunLease {
    fn drop(&mut self) {
        self.runs.release(&self.run_id, &self.control);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use super::{AlreadyActive, InstallRuns, MAX_EARLY_CANCELLED_RUNS, StopReason};

    #[test]
    fn a_run_id_is_exclusive_until_its_lease_drops() {
        let runs = Arc::new(InstallRuns::default());
        let lease = runs.reserve("run-1").unwrap();

        assert_eq!(runs.reserve("run-1").err(), Some(AlreadyActive));
        drop(lease);
        assert!(
            runs.reserve("run-1").is_ok(),
            "expected a dropped lease to free its run id"
        );
    }

    #[test]
    fn the_first_stop_reason_wins_and_prevents_launch() {
        let runs = Arc::new(InstallRuns::default());
        let lease = runs.reserve("run-1").unwrap();

        runs.stop("run-1", StopReason::HubLost);
        runs.stop("run-1", StopReason::Cancelled);

        assert_eq!(lease.control().stop_reason(), Some(StopReason::HubLost));
        assert!(lease.control().launch_token().is_cancelled());
    }

    #[test]
    fn a_cancel_before_the_run_is_seen_starts_that_run_stopped_once() {
        let runs = Arc::new(InstallRuns::default());
        runs.stop("early", StopReason::Cancelled);
        runs.stop("early", StopReason::Cancelled);

        let first = runs.reserve("early").unwrap();
        assert_eq!(
            first.control().stop_reason(),
            Some(StopReason::Cancelled),
            "expected the early cancel to apply to the later run"
        );
        drop(first);
        assert_eq!(
            runs.reserve("early").unwrap().control().stop_reason(),
            None,
            "expected the early cancel to be consumed by one run only"
        );
    }

    #[test]
    fn only_an_explicit_cancel_is_remembered_for_an_unseen_run() {
        let runs = Arc::new(InstallRuns::default());
        runs.stop("hub-lost", StopReason::HubLost);
        runs.stop("revoked", StopReason::ConsentRevoked);

        assert_eq!(
            runs.reserve("hub-lost").unwrap().control().stop_reason(),
            None
        );
        assert_eq!(
            runs.reserve("revoked").unwrap().control().stop_reason(),
            None
        );
    }

    #[test]
    fn early_cancels_are_bounded_and_forget_the_oldest_first() {
        let runs = Arc::new(InstallRuns::default());
        for index in 0..=MAX_EARLY_CANCELLED_RUNS {
            runs.stop(&format!("run-{index}"), StopReason::Cancelled);
        }

        assert_eq!(
            runs.reserve("run-0").unwrap().control().stop_reason(),
            None,
            "expected the oldest early cancel forgotten past the bound"
        );
        assert_eq!(
            runs.reserve(&format!("run-{MAX_EARLY_CANCELLED_RUNS}"))
                .unwrap()
                .control()
                .stop_reason(),
            Some(StopReason::Cancelled)
        );
        assert_eq!(
            runs.reserve("run-1").unwrap().control().stop_reason(),
            Some(StopReason::Cancelled),
            "expected the second-oldest early cancel still remembered"
        );
    }

    #[tokio::test]
    async fn settled_waits_for_every_active_run() {
        let runs = Arc::new(InstallRuns::default());
        let first = runs.reserve("a").unwrap();
        let second = runs.reserve("b").unwrap();
        let waiter = tokio::spawn({
            let runs = Arc::clone(&runs);
            async move { runs.settled().await }
        });

        drop(first);
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(
            !waiter.is_finished(),
            "expected settled to wait while one run is still active"
        );
        drop(second);
        tokio::time::timeout(Duration::from_secs(2), waiter)
            .await
            .expect("expected settled once no run is active | received: still pending")
            .unwrap();
    }

    #[tokio::test]
    async fn settled_resolves_immediately_with_nothing_active() {
        let runs = InstallRuns::default();
        tokio::time::timeout(Duration::from_secs(1), runs.settled())
            .await
            .expect("expected an idle table to be settled already");
    }

    #[test]
    fn a_stale_lease_never_releases_a_newer_run_with_the_same_id() {
        let runs = Arc::new(InstallRuns::default());
        let lease = runs.reserve("run-1").unwrap();
        let stale = Arc::clone(lease.control());
        drop(lease);
        let current = runs.reserve("run-1").unwrap();

        runs.release("run-1", &stale);

        assert_eq!(
            runs.reserve("run-1").err(),
            Some(AlreadyActive),
            "expected the current lease to keep its id after a stale release"
        );
        drop(current);
    }
}
