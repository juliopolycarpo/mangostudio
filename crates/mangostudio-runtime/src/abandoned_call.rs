//! Settling a call whose handler future was dropped before it finished.
//!
//! `mango_protocol` waits a bounded handler grace at session teardown and
//! then aborts whatever handlers are still running. An aborted future never
//! reaches [`crate::registry::Registry::implement`]'s own audit line, yet
//! the effect it started (a `gh.mutate`, a long `library.apply`) may still
//! complete on its own. [`AbandonedCall`] is the drop guard that records one
//! audit entry for such a call anyway.
//!
//! It deliberately does not release the call's exclusivity claim: an effect
//! that outlives its future (an `install.run` step) must keep holding it.
//!
//! The entry is `outcome: error` with `code: CANCELLED`. `audit.log`'s line
//! shape is shared across runtimes (`RuntimeAuditOutcomeSchema` in
//! `apps/shared/src/runtime-home/schemas.ts` allows only `ok`, `denied`, and
//! `error`), so an abandoned call reuses the shape `consent-gate.ts` already
//! writes for an aborted call rather than inventing a new outcome string.

use std::future::Future;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll, Waker};
use std::time::Instant;

use mango_protocol::error::codes;

use crate::ports::audit::{Audit, AuditEntry, Outcome};
use crate::ports::clock::Clock;

/// Whether an abandoned call writes its own audit entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AbandonAudit {
    /// Record `error`/`CANCELLED` when the handler is dropped unfinished.
    Record,
    /// The handler already records an abandoned run itself (`install.run`'s
    /// owner task does, via `record_unobserved`); recording here too would
    /// write the call twice.
    OwnedByHandler,
}

/// Armed for the lifetime of one handler call; settles it on drop unless
/// [`AbandonedCall::disarm`] ran first.
///
/// # Example
///
/// ```ignore
/// let guard = AbandonedCall::arm(CallParts { policy: AbandonAudit::Record, ..parts });
/// let result = handler.await; // dropped here => one CANCELLED entry
/// guard.disarm();             // settled normally => nothing recorded
/// ```
pub(crate) struct AbandonedCall {
    parts: Option<CallParts>,
}

/// What an abandoned call needs to settle itself.
pub(crate) struct CallParts {
    pub method: String,
    pub started: Instant,
    pub audit: Arc<dyn Audit>,
    pub clock: Arc<dyn Clock>,
    pub policy: AbandonAudit,
}

impl AbandonedCall {
    /// Arms the guard for one call.
    pub(crate) fn arm(parts: CallParts) -> Self {
        Self { parts: Some(parts) }
    }

    /// The call settled on its own path, which releases and records it.
    pub(crate) fn disarm(mut self) {
        self.parts = None;
    }
}

impl Drop for AbandonedCall {
    fn drop(&mut self) {
        let Some(parts) = self.parts.take() else {
            return;
        };
        if parts.policy == AbandonAudit::OwnedByHandler {
            return;
        }
        let entry = AuditEntry {
            method: parts.method,
            outcome: Outcome::Error,
            duration: parts.clock.now().duration_since(parts.started),
            capability: None,
            code: Some(codes::CANCELLED.to_owned()),
        };
        record_detached(parts.audit, entry);
    }
}

/// Records `entry` from a synchronous context. Polls once in place, so a
/// sink that writes without awaiting (the file sink does) lands before the
/// runtime can shut down; a sink still pending is finished on a detached
/// task when a Tokio runtime is present. A panicking sink is contained:
/// a panic inside `Drop` during an unwind would abort the process.
fn record_detached(audit: Arc<dyn Audit>, entry: AuditEntry) {
    let method = entry.method.clone();
    let mut future: Pin<Box<dyn Future<Output = ()> + Send>> =
        Box::pin(async move { audit.record(entry).await });
    let mut context = Context::from_waker(Waker::noop());
    let polled = catch_unwind(AssertUnwindSafe(|| future.as_mut().poll(&mut context)));
    if !matches!(polled, Ok(Poll::Pending)) {
        return;
    }
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        // Only reachable when a handler future is dropped off any Tokio
        // runtime while its sink is still pending: say so rather than lose
        // the entry silently.
        eprintln!(
            "mangostudio-runtime: audit_abandoned_entry_lost {}",
            serde_json::json!({ "method": method })
        );
        debug_assert!(
            false,
            "expected a Tokio runtime to finish the abandoned \"{method}\" audit entry | \
             received: no runtime"
        );
        return;
    };
    handle.spawn(async move {
        let _ = crate::panic::catch_panics(async move {
            future.await;
            Ok::<(), mango_protocol::RemoteError>(())
        })
        .await;
    });
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    use mango_protocol::error::codes;

    use super::{AbandonAudit, AbandonedCall, CallParts};
    use crate::ports::audit::{Audit, AuditEntry, Outcome, lock};
    use crate::ports::clock::SystemClock;

    /// Records every entry, optionally yielding once first so the detached path runs.
    #[derive(Default)]
    struct RecordingSink {
        entries: Mutex<Vec<AuditEntry>>,
        yields_first: bool,
    }

    impl Audit for RecordingSink {
        fn record<'a>(
            &'a self,
            entry: AuditEntry,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
            Box::pin(async move {
                if self.yields_first {
                    tokio::task::yield_now().await;
                }
                lock(&self.entries).push(entry);
            })
        }
    }

    struct PanickingSink;

    impl Audit for PanickingSink {
        fn record<'a>(
            &'a self,
            _entry: AuditEntry,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
            Box::pin(async { panic!("the sink misbehaved") })
        }
    }

    fn arm(audit: Arc<dyn Audit>, policy: AbandonAudit) -> AbandonedCall {
        AbandonedCall::arm(CallParts {
            method: "gh.mutate".to_owned(),
            started: Instant::now(),
            audit,
            clock: Arc::new(SystemClock),
            policy,
        })
    }

    fn summary(entries: &[AuditEntry]) -> Vec<(String, Outcome, Option<String>)> {
        entries
            .iter()
            .map(|entry| (entry.method.clone(), entry.outcome, entry.code.clone()))
            .collect()
    }

    #[test]
    fn a_dropped_call_records_one_cancelled_entry() {
        let sink = Arc::new(RecordingSink::default());
        drop(arm(Arc::clone(&sink) as _, AbandonAudit::Record));

        let expected = vec![(
            "gh.mutate".to_owned(),
            Outcome::Error,
            Some(codes::CANCELLED.to_owned()),
        )];
        let received = summary(&lock(&sink.entries));
        assert_eq!(
            received, expected,
            "expected entries: {expected:?} | received: {received:?}"
        );
    }

    #[test]
    fn a_disarmed_call_records_nothing() {
        let sink = Arc::new(RecordingSink::default());
        arm(Arc::clone(&sink) as _, AbandonAudit::Record).disarm();

        let received = summary(&lock(&sink.entries));
        assert!(
            received.is_empty(),
            "expected entries: [] | received: {received:?}"
        );
    }

    #[test]
    fn a_handler_owned_abandon_records_nothing() {
        let sink = Arc::new(RecordingSink::default());
        drop(arm(Arc::clone(&sink) as _, AbandonAudit::OwnedByHandler));

        let received = summary(&lock(&sink.entries));
        assert!(
            received.is_empty(),
            "expected entries: [] | received: {received:?}"
        );
    }

    #[tokio::test]
    async fn a_sink_still_pending_after_one_poll_finishes_on_a_detached_task() {
        let sink = Arc::new(RecordingSink {
            yields_first: true,
            ..RecordingSink::default()
        });
        drop(arm(Arc::clone(&sink) as _, AbandonAudit::Record));
        assert!(lock(&sink.entries).is_empty(), "the first poll yields");

        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        let received = summary(&lock(&sink.entries));
        assert_eq!(
            received.len(),
            1,
            "expected one detached entry | received: {received:?}"
        );
    }

    #[test]
    #[should_panic(expected = "received: no runtime")]
    fn a_pending_sink_with_no_runtime_is_reported_not_lost_silently() {
        let sink = Arc::new(RecordingSink {
            yields_first: true,
            ..RecordingSink::default()
        });
        drop(arm(Arc::clone(&sink) as _, AbandonAudit::Record));
    }

    #[test]
    fn a_panicking_sink_is_contained_inside_drop() {
        drop(arm(Arc::new(PanickingSink), AbandonAudit::Record));
    }
}
