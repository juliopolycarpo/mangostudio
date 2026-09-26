//! A bounded consent read with three outcomes, shared by every watcher that revokes a live
//! resource (MCP sessions, terminals, install chains, external-agent sessions) and by the async
//! launch checks.
//!
//! A read runs on the blocking pool and may not finish in time — a slow disk, a contended
//! `runtime.json`, a saturated pool. That outcome is [`ConsentRead::Unknown`], never a denial,
//! and the two kinds of caller treat it differently on purpose:
//!
//! - **Watchers** (a poll that tears down something already running) revoke only on
//!   [`ConsentRead::Denied`]: the file was read and the capability is off. `Unknown` keeps the
//!   current state and the next poll reads again — see [`ConsentRead::revokes`].
//! - **Launch checks** (a fresh read immediately before an OS effect) proceed only on
//!   [`ConsentRead::Granted`]: `Unknown` refuses the effect (a retryable `UNAVAILABLE` where
//!   the caller has one, never a consent denial), so nothing starts on consent that could not
//!   be confirmed — see [`ConsentRead::allows`].
//!
//! A read that finishes but cannot parse the file is still a denial: [`super::source`] fails
//! closed to `none` for an unreadable or malformed file, and that is an explicit answer.
//!
//! A timed-out read keeps running (blocking work cannot be interrupted) and keeps its
//! [`crate::blocking`] permit until it returns. A watcher therefore reads through a
//! [`ConsentReader`], which never starts a second read while one is still outstanding, so a
//! hung store costs one permit rather than one per poll.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::watch;

use crate::blocking::run_blocking;

/// How long one consent read may take before its answer counts as unknown.
pub(crate) const CONSENT_READ_TIMEOUT: Duration = Duration::from_secs(2);

/// The outcome of one bounded consent read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ConsentRead {
    /// The consent file was read and grants the capability.
    Granted,
    /// The consent file was read (or failed closed) and withholds the capability.
    Denied,
    /// The read did not finish within its bound; nothing is known about the capability.
    Unknown,
}

impl ConsentRead {
    /// Whether a launch-time check may perform its effect: only a confirmed grant does.
    ///
    /// # Example
    /// ```ignore
    /// if !read_consent("shell", CONSENT_READ_TIMEOUT, read).await.allows() { return Err(denial); }
    /// ```
    pub(crate) fn allows(self) -> bool {
        self == Self::Granted
    }

    /// Whether a watcher must revoke the live resources it guards: only an explicit denial does.
    ///
    /// # Example
    /// ```ignore
    /// if reader.read(CONSENT_READ_TIMEOUT, read).await.revokes() { close_all().await; }
    /// ```
    pub(crate) fn revokes(self) -> bool {
        self == Self::Denied
    }

    fn answered(granted: bool) -> Self {
        if granted { Self::Granted } else { Self::Denied }
    }
}

/// One fresh, uncoalesced read for a launch-time check: runs `read` off the executor, bounded
/// by `timeout`, and reports a timeout as [`ConsentRead::Unknown`] with one stderr line naming
/// `capability` (never a consent value).
///
/// # Example
/// ```ignore
/// let source = Arc::clone(&consent);
/// let read = read_consent("shell", CONSENT_READ_TIMEOUT, move || source.refresh().shell).await;
/// ```
pub(crate) async fn read_consent<F>(capability: &str, timeout: Duration, read: F) -> ConsentRead
where
    F: FnOnce() -> bool + Send + 'static,
{
    match tokio::time::timeout(timeout, run_blocking(read)).await {
        Ok(granted) => ConsentRead::answered(granted),
        Err(_) => {
            report_unknown(capability, timeout);
            ConsentRead::Unknown
        }
    }
}

/// Bounded consent reads for a watcher, coalesced so at most one read is outstanding.
///
/// A caller that arrives while a read is still running waits on that read (within its own
/// bound) instead of starting another. The stderr diagnostic is written once per stuck read,
/// not once per poll that gives up on it.
///
/// The answer defaults to one capability's `bool`; the authorization guard coalesces whole
/// resolved `allow` sets through a `ConsentReader<ResolvedCapabilityAllow>` with
/// [`ConsentReader::read_value`].
pub(crate) struct ConsentReader<T = bool> {
    capability: &'static str,
    state: Arc<Mutex<ReaderState<T>>>,
}

struct ReaderState<T> {
    /// The answer channel of the read still running, if any.
    in_flight: Option<watch::Receiver<Option<T>>>,
    /// Whether the running read's timeout was already reported.
    reported: bool,
}

impl<T> Default for ReaderState<T> {
    fn default() -> Self {
        Self {
            in_flight: None,
            reported: false,
        }
    }
}

/// Clears the reader's in-flight slot when the read task ends, even by a panicking read.
struct ClearOnDrop<T>(Arc<Mutex<ReaderState<T>>>);

impl<T> Drop for ClearOnDrop<T> {
    fn drop(&mut self) {
        let mut state = self.0.lock().unwrap_or_else(|poison| poison.into_inner());
        *state = ReaderState::default();
    }
}

impl ConsentReader<bool> {
    /// Joins the outstanding read, or starts `read` if none is running, and waits `timeout`.
    ///
    /// # Example
    /// ```ignore
    /// let source = Arc::clone(&consent);
    /// if reader.read(CONSENT_READ_TIMEOUT, move || source.granted()).await.revokes() { .. }
    /// ```
    pub(crate) async fn read<F>(&self, timeout: Duration, read: F) -> ConsentRead
    where
        F: FnOnce() -> bool + Send + 'static,
    {
        self.read_value(timeout, read)
            .await
            .map_or(ConsentRead::Unknown, ConsentRead::answered)
    }
}

impl<T: Clone + Send + Sync + 'static> ConsentReader<T> {
    /// A reader for `capability`, named in its diagnostics.
    ///
    /// # Example
    /// ```ignore
    /// let reader = ConsentReader::new("mcp");
    /// ```
    pub(crate) fn new(capability: &'static str) -> Self {
        Self {
            capability,
            state: Arc::new(Mutex::new(ReaderState::default())),
        }
    }

    /// Like [`ConsentReader::read`], but yields the read's own answer, or `None` when it did
    /// not arrive within `timeout` (or the read panicked) — the caller decides what an unknown
    /// answer means.
    ///
    /// # Example
    /// ```ignore
    /// let reader = ConsentReader::<ResolvedCapabilityAllow>::new("consent");
    /// let allow = reader.read_value(CONSENT_READ_TIMEOUT, move || source.refresh()).await;
    /// ```
    pub(crate) async fn read_value<F>(&self, timeout: Duration, read: F) -> Option<T>
    where
        F: FnOnce() -> T + Send + 'static,
    {
        let mut answer = self.join_or_start(read);
        let outcome = tokio::time::timeout(timeout, answer.wait_for(Option::is_some)).await;
        if let Ok(Ok(value)) = outcome {
            return value.clone();
        }
        let first = {
            let mut state = self.lock();
            !std::mem::replace(&mut state.reported, true)
        };
        if first {
            report_unknown(self.capability, timeout);
        }
        None
    }

    fn join_or_start<F>(&self, read: F) -> watch::Receiver<Option<T>>
    where
        F: FnOnce() -> T + Send + 'static,
    {
        let mut state = self.lock();
        if let Some(running) = &state.in_flight {
            return running.clone();
        }
        let (sender, answer) = watch::channel(None);
        state.in_flight = Some(answer.clone());
        let clear = ClearOnDrop(Arc::clone(&self.state));
        tokio::spawn(async move {
            let granted = run_blocking(read).await;
            // Answered before clearing: a caller that joins in between receives this answer
            // instead of starting a second read; only a caller after the clear reads afresh.
            // A panicking read unwinds past both lines, so `clear` still clears on drop and
            // the dropped sender leaves every waiter with Unknown.
            let _ = sender.send(Some(granted));
            drop(clear);
        });
        answer
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ReaderState<T>> {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }
}

fn report_unknown(capability: &str, timeout: Duration) {
    eprintln!(
        "mangostudio-runtime: consent read for {capability} did not finish within {timeout:?}; \
         keeping the current state and reading again at the next poll"
    );
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::consent::stall_gate::StallGate;

    /// The bound a read under test is expected to miss: it is held by a [`StallGate`].
    const SHORT: Duration = Duration::from_millis(50);
    /// The bound a read under test is expected to meet, generous for a loaded machine.
    const FINISH: Duration = Duration::from_secs(5);

    #[tokio::test]
    async fn a_finished_read_reports_its_answer() {
        let granted = read_consent("shell", FINISH, || true).await;
        let denied = read_consent("shell", FINISH, || false).await;
        assert_eq!(
            (granted, denied),
            (ConsentRead::Granted, ConsentRead::Denied),
            "expected (Granted, Denied) | received ({granted:?}, {denied:?})"
        );
    }

    #[tokio::test]
    async fn a_read_that_outlives_its_bound_is_unknown_not_denied() {
        let gate = StallGate::new();
        let held = gate.handle();
        let read = read_consent("shell", SHORT, move || {
            held.wait();
            false
        })
        .await;
        gate.release();
        assert_eq!(
            read,
            ConsentRead::Unknown,
            "expected a slow read to be Unknown | received {read:?}"
        );
    }

    #[test]
    fn only_a_grant_allows_and_only_a_denial_revokes() {
        let table = [
            ConsentRead::Granted,
            ConsentRead::Denied,
            ConsentRead::Unknown,
        ]
        .map(|read| (read, read.allows(), read.revokes()));
        assert_eq!(
            table,
            [
                (ConsentRead::Granted, true, false),
                (ConsentRead::Denied, false, true),
                (ConsentRead::Unknown, false, false),
            ],
            "expected allows = Granted only, revokes = Denied only | received {table:?}"
        );
    }

    #[tokio::test]
    async fn a_reader_reports_finished_answers_and_reads_afresh_each_time() {
        let reader = ConsentReader::new("mcp");
        let granted = reader.read(FINISH, || true).await;
        let denied = reader.read(FINISH, || false).await;
        assert_eq!(
            (granted, denied),
            (ConsentRead::Granted, ConsentRead::Denied),
            "expected consecutive reads (Granted, Denied) | received ({granted:?}, {denied:?})"
        );
    }

    #[tokio::test]
    async fn a_stuck_read_is_not_restarted_by_later_polls() {
        let reader = ConsentReader::new("mcp");
        let gate = StallGate::new();
        let started = Arc::new(AtomicUsize::new(0));
        let first_read = Arc::new(tokio::sync::Notify::new());
        let mut outcomes = Vec::new();
        for _ in 0..3 {
            let started = Arc::clone(&started);
            let first_read = Arc::clone(&first_read);
            let held = gate.handle();
            outcomes.push(
                reader
                    .read(SHORT, move || {
                        started.fetch_add(1, Ordering::SeqCst);
                        first_read.notify_one();
                        held.wait();
                        true
                    })
                    .await,
            );
        }
        // A poll can give up on its bound before the blocking pool has started the read at
        // all, so wait for that start before counting. The gate keeps any second read out.
        let first_started = tokio::time::timeout(FINISH, first_read.notified())
            .await
            .is_ok();
        assert!(
            first_started,
            "expected the stuck read to start within {FINISH:?} | received no read started"
        );
        let reads = started.load(Ordering::SeqCst);
        gate.release();
        assert_eq!(
            (reads, outcomes.as_slice()),
            (1, [ConsentRead::Unknown; 3].as_slice()),
            "expected (reads started, outcomes) = (1, 3 x Unknown) | received ({reads}, \
             {outcomes:?})"
        );
    }

    #[tokio::test]
    async fn a_late_answer_reaches_a_poll_that_joins_the_stuck_read() {
        let reader = ConsentReader::new("mcp");
        let gate = StallGate::new();
        let held = gate.handle();
        let slow = reader
            .read(SHORT, move || {
                held.wait();
                false
            })
            .await;
        // Poll the joining read once, so it has joined the stuck read before that read can
        // finish; only then let the stuck read answer.
        let mut joining = std::pin::pin!(reader.read(FINISH, || true));
        tokio::select! {
            biased;
            early = &mut joining => panic!("expected the joining poll to wait for the stuck read | received {early:?}"),
            () = std::future::ready(()) => {}
        }
        gate.release();
        let joined = joining.await;
        assert_eq!(
            (slow, joined),
            (ConsentRead::Unknown, ConsentRead::Denied),
            "expected (first poll, joining poll) = (Unknown, the stuck read's Denied) | \
             received ({slow:?}, {joined:?})"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[allow(
        clippy::await_holding_lock,
        reason = "the held lock is what pins the read task inside the window under test"
    )]
    async fn an_answer_is_published_before_the_in_flight_read_is_cleared() {
        let reader = ConsentReader::new("mcp");
        let reads = Arc::new(AtomicUsize::new(0));
        let (release, released) = std::sync::mpsc::channel::<()>();
        let counted = Arc::clone(&reads);
        let mut answer = reader.join_or_start(move || {
            counted.fetch_add(1, Ordering::SeqCst);
            released.recv().unwrap();
            true
        });
        // Holding the state lock parks the read task at the point where it clears `in_flight`,
        // so whatever it did before that is observable here and nothing after it has happened.
        let state = reader.lock();
        release.send(()).unwrap();
        let published =
            tokio::time::timeout(Duration::from_secs(5), answer.wait_for(Option::is_some))
                .await
                .map(|value| *value.unwrap())
                .ok();
        let joinable = state.in_flight.as_ref().map(|running| *running.borrow());
        drop(state);
        let started = reads.load(Ordering::SeqCst);
        assert_eq!(
            (published, joinable, started),
            (Some(Some(true)), Some(Some(true)), 1),
            "expected (answer published, answer a joiner in the window receives, reads started) \
             = (Some(Some(true)), Some(Some(true)), 1) | received ({published:?}, {joinable:?}, {started})"
        );
    }

    #[tokio::test]
    async fn a_panicking_read_is_unknown_and_frees_the_reader() {
        let reader = ConsentReader::new("mcp");
        let panicked = reader.read(FINISH, || panic!("consent store broke")).await;
        let next = reader.read(FINISH, || true).await;
        assert_eq!(
            (panicked, next),
            (ConsentRead::Unknown, ConsentRead::Granted),
            "expected (panicking read, next read) = (Unknown, Granted) | received \
             ({panicked:?}, {next:?})"
        );
    }
}
