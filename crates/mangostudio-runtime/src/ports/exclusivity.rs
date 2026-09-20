//! Whether a call may run at all right now, independent of capability
//! consent — decided only by what else is currently in flight.
//!
//! Mirrors the exclusivity half of `apps/runtime/src/consent-gate.ts`'s
//! `gateHandlers`: a binary update rewrites the bytes this process is
//! serving from, so it may not overlap an ordinary call in either
//! direction. TypeScript decides and releases both in one wrapper (a
//! `try`/`finally` around consent, the handler, and everything between);
//! this crate's two-seam pipeline (a [`mango_protocol::contract::Guard`]
//! that runs *before* a handler, a [`crate::registry::Registry::implement`]
//! wrapper that runs *after* one) has no single place to put that. A claim
//! is instead taken in [`crate::ports::authorization::AuthorizationGuard`]
//! (the same place TypeScript takes it, relative to the consent check) and
//! released in one of two places depending on how the call ends:
//!
//! - Refused by exclusivity, or denied by consent: released by the guard
//!   itself, before it returns — the handler this claim was for is never
//!   going to run, so nothing downstream will ever release it.
//! - Authorized: left claimed when the guard returns `Ok`, and released by
//!   `Registry::implement`'s own wrapper once the handler (successful,
//!   erroring, or panicking) has settled — matching TypeScript's `finally`,
//!   which runs after the handler exactly as often as this does.
//!
//! Both sides key a claim on [`mango_protocol::session::CallContext::id`]
//! rather than a fresh token the way TypeScript's `Symbol()` does, because a
//! [`crate::registry::Registry`] is consumed whole by one
//! [`crate::serve::serve`] call and does not outlive it or get shared across
//! more than the one [`mango_protocol::session::Session`] that call served —
//! unlike TypeScript's `gateHandlers`, whose returned handlers can be
//! registered on more than one session at once, which is exactly why it
//! needs a token no two sessions could ever produce the same value for. A
//! request id is unique within one session, which is the only scope a claim
//! here is ever asked to survive.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use mango_protocol::error::RemoteError;
use mangostudio_runtime_contract::errors::RUNTIME_UPDATE_REFUSED;

use crate::ports::audit::lock;

/// Methods that carry a live binary; they and ordinary calls exclude each
/// other. Mirrors `consent-gate.ts`'s own local `UPDATE_METHOD_PREFIX` —
/// not exported from the shared contract there either, so this is a
/// deliberate re-derivation of a TypeScript-local literal, not a hand-typed
/// duplicate of something the contract crate already names.
pub const UPDATE_METHOD_PREFIX: &str = "runtime.update.";

/// Whether an update is under way outside the lifetime of any single
/// `runtime.update.*` call — the gap between `runtime.update.begin` and
/// `runtime.update.commit` in TypeScript, which this crate does not
/// implement yet. [`NotUpdating`] is the only implementation until it does.
pub trait UpdateActivity: Send + Sync + 'static {
    /// Whether an update is currently in progress.
    fn is_active(&self) -> bool;
}

/// No update lifecycle exists yet in this crate, so none is ever active.
#[derive(Debug, Clone, Copy, Default)]
pub struct NotUpdating;

impl UpdateActivity for NotUpdating {
    fn is_active(&self) -> bool {
        false
    }
}

/// Claims and releases the exclusivity a call needs before it may run.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::ports::exclusivity::{CallExclusivity, NoExclusivity};
///
/// let exclusivity = NoExclusivity;
/// assert!(exclusivity.begin("shell.run", "1").is_ok());
/// exclusivity.end("1");
/// ```
pub trait CallExclusivity: Send + Sync + 'static {
    /// Attempts to claim `call_id` for `method`. `Err` means another call
    /// already holds a conflicting claim and this one may not proceed;
    /// nothing is claimed in that case, and [`CallExclusivity::end`] must
    /// not be called for it. `Ok` claims `call_id` until a matching `end`.
    fn begin(&self, method: &str, call_id: &str) -> Result<(), RemoteError>;

    /// Releases a claim [`CallExclusivity::begin`] took for `call_id`. A
    /// no-op if `call_id` was never claimed, or was already released —
    /// mirroring `Set::delete`'s own no-op-on-absence in `consent-gate.ts`'s
    /// `finally`.
    fn end(&self, call_id: &str);
}

/// Enforces nothing: every call is claimed, no call is ever refused. The
/// default for a [`crate::registry::Registry`] that never needs update
/// exclusivity — matches this crate's other ports in leaving safety to an
/// explicit, later choice rather than a silent one.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoExclusivity;

impl CallExclusivity for NoExclusivity {
    fn begin(&self, _method: &str, _call_id: &str) -> Result<(), RemoteError> {
        Ok(())
    }

    fn end(&self, _call_id: &str) {}
}

/// Why a call is refused: which of the two "runtime.update.*" refuses,
/// mirroring `consent-gate.ts`'s two `reason` values exactly.
fn exclusivity_refusal(message: &str, reason: &str) -> RemoteError {
    RemoteError::new(RUNTIME_UPDATE_REFUSED, message.to_string())
        .with_detail("kind", "runtime_update_refused")
        .with_detail("reason", reason)
}

/// Every call a [`UpdateExclusivityTracker`] currently has claimed. A
/// single lock covering both sets, not one each: `total` and `updates` are
/// read together to decide whether a new claim may proceed, and inserted
/// into together once it does, so the whole check-then-claim must be one
/// critical section — two [`mango_protocol`]-dispatched calls checking and
/// claiming under separate locks could both observe an empty set and both
/// proceed, which is exactly the overlap this type exists to forbid.
/// TypeScript never needed this: `consent-gate.ts`'s check and its
/// `inFlight.add` run synchronously, with no `await` between them, so its
/// own single-threaded event loop is the mutual exclusion. Rust's
/// dispatcher runs every handler as its own concurrent task, so that
/// guarantee does not carry over and has to be re-established with a real
/// lock.
#[derive(Default)]
struct Claims {
    /// Every call currently claimed, of either kind.
    total: HashSet<String>,
    /// The subset of `total` that is an update call.
    updates: HashSet<String>,
}

/// The real [`CallExclusivity`]: an update call refuses while anything else
/// is in flight, and an ordinary call refuses while an update call — or an
/// update lifecycle outside any single call — is in flight.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::ports::exclusivity::{
///     CallExclusivity, NotUpdating, UpdateExclusivityTracker,
/// };
/// use std::sync::Arc;
///
/// let tracker = UpdateExclusivityTracker::new(Arc::new(NotUpdating));
/// tracker.begin("shell.run", "1").unwrap();
/// let refused = tracker
///     .begin("runtime.update.begin", "2")
///     .expect_err("an update may not start while an ordinary call runs");
/// assert_eq!(refused.details.unwrap()["reason"], "call_in_flight");
/// tracker.end("1");
/// assert!(tracker.begin("runtime.update.begin", "2").is_ok());
/// ```
pub struct UpdateExclusivityTracker {
    claims: Mutex<Claims>,
    update_active: Arc<dyn UpdateActivity>,
}

impl UpdateExclusivityTracker {
    /// Builds a tracker with nothing claimed yet, consulting `update_active`
    /// for whether an update lifecycle outside any single call is under way.
    #[must_use]
    pub fn new(update_active: Arc<dyn UpdateActivity>) -> Self {
        Self {
            claims: Mutex::new(Claims::default()),
            update_active,
        }
    }
}

impl CallExclusivity for UpdateExclusivityTracker {
    fn begin(&self, method: &str, call_id: &str) -> Result<(), RemoteError> {
        let is_update = method.starts_with(UPDATE_METHOD_PREFIX);
        // The whole decision — both checks and both inserts — runs under
        // one guard, held for the entire call: releasing it between the
        // check and the claim (or between the two sets' own locks) would
        // reopen exactly the window described on `Claims` above. A refused
        // call still leaves no trace in either set for `end` to ever undo,
        // since the early returns happen before either `insert`.
        let mut claims = lock(&self.claims);
        if is_update && !claims.total.is_empty() {
            return Err(exclusivity_refusal(
                "Runtime update refused while another call is in flight.",
                "call_in_flight",
            ));
        }
        if !is_update && (!claims.updates.is_empty() || self.update_active.is_active()) {
            return Err(exclusivity_refusal(
                "Runtime call refused while a binary update is in progress.",
                "update_in_progress",
            ));
        }
        claims.total.insert(call_id.to_string());
        if is_update {
            claims.updates.insert(call_id.to_string());
        }
        Ok(())
    }

    fn end(&self, call_id: &str) {
        let mut claims = lock(&self.claims);
        claims.total.remove(call_id);
        claims.updates.remove(call_id);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};
    use std::thread;

    use super::{CallExclusivity, NoExclusivity, NotUpdating, UpdateExclusivityTracker};

    /// Runs `race` under a two-thread [`Barrier`] many times over, so a
    /// check-then-claim window that only sometimes overlaps still gets
    /// caught: a `Barrier` makes both threads call `begin` at essentially
    /// the same instant, but a race that depends on exact scheduling is not
    /// guaranteed to fire on any single attempt. Never a `sleep` — the
    /// barrier is the only synchronisation this needs, and asserting inside
    /// `race` on every iteration is what turns "usually passes" into
    /// "never passes while the bug exists".
    fn assert_never_races<F>(race: F)
    where
        F: Fn(Arc<UpdateExclusivityTracker>) -> (bool, bool),
    {
        for attempt in 0..500 {
            let tracker = Arc::new(UpdateExclusivityTracker::new(Arc::new(NotUpdating)));
            let (first_ok, second_ok) = race(tracker);
            assert!(
                first_ok ^ second_ok,
                "attempt {attempt}: exactly one of two racing begin() calls must succeed, \
                 got first={first_ok} second={second_ok}"
            );
        }
    }

    #[test]
    fn two_concurrent_update_begins_never_both_succeed() {
        assert_never_races(|tracker| {
            let barrier = Arc::new(Barrier::new(2));

            let first = {
                let tracker = Arc::clone(&tracker);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    tracker.begin("runtime.update.begin", "a").is_ok()
                })
            };
            let second = thread::spawn(move || {
                barrier.wait();
                tracker.begin("runtime.update.begin", "b").is_ok()
            });

            (first.join().unwrap(), second.join().unwrap())
        });
    }

    #[test]
    fn a_concurrent_update_and_an_ordinary_call_never_both_succeed() {
        assert_never_races(|tracker| {
            let barrier = Arc::new(Barrier::new(2));

            let update = {
                let tracker = Arc::clone(&tracker);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    tracker.begin("runtime.update.begin", "a").is_ok()
                })
            };
            let ordinary = thread::spawn(move || {
                barrier.wait();
                tracker.begin("shell.run", "b").is_ok()
            });

            (update.join().unwrap(), ordinary.join().unwrap())
        });
    }

    #[test]
    fn no_exclusivity_never_refuses_and_end_is_always_a_no_op() {
        let exclusivity = NoExclusivity;
        assert!(exclusivity.begin("runtime.update.begin", "a").is_ok());
        assert!(exclusivity.begin("shell.run", "b").is_ok());
        exclusivity.end("a");
        exclusivity.end("never-claimed");
    }

    #[test]
    fn an_update_call_is_refused_while_an_ordinary_call_is_in_flight() {
        let tracker = UpdateExclusivityTracker::new(Arc::new(NotUpdating));
        tracker.begin("shell.run", "1").unwrap();
        let error = tracker
            .begin("runtime.update.begin", "2")
            .expect_err("an ordinary call is already in flight");
        assert_eq!(error.code, "RUNTIME_UPDATE_REFUSED");
        let details = error.details.unwrap();
        assert_eq!(details["kind"], "runtime_update_refused");
        assert_eq!(details["reason"], "call_in_flight");
    }

    #[test]
    fn an_ordinary_call_is_refused_while_an_update_call_is_in_flight() {
        let tracker = UpdateExclusivityTracker::new(Arc::new(NotUpdating));
        tracker.begin("runtime.update.begin", "1").unwrap();
        let error = tracker
            .begin("shell.run", "2")
            .expect_err("an update call is already in flight");
        assert_eq!(error.details.unwrap()["reason"], "update_in_progress");
    }

    #[test]
    fn an_ordinary_call_is_refused_while_an_update_lifecycle_is_active_outside_any_call() {
        struct AlwaysUpdating;
        impl super::UpdateActivity for AlwaysUpdating {
            fn is_active(&self) -> bool {
                true
            }
        }
        let tracker = UpdateExclusivityTracker::new(Arc::new(AlwaysUpdating));
        let error = tracker
            .begin("shell.run", "1")
            .expect_err("an update lifecycle is active, even with nothing claimed");
        assert_eq!(error.details.unwrap()["reason"], "update_in_progress");
    }

    #[test]
    fn two_ordinary_calls_never_exclude_each_other() {
        let tracker = UpdateExclusivityTracker::new(Arc::new(NotUpdating));
        tracker.begin("shell.run", "1").unwrap();
        assert!(tracker.begin("terminal.list", "2").is_ok());
    }

    #[test]
    fn ending_a_claim_lets_a_refused_kind_through_afterwards() {
        let tracker = UpdateExclusivityTracker::new(Arc::new(NotUpdating));
        tracker.begin("shell.run", "1").unwrap();
        tracker
            .begin("runtime.update.begin", "2")
            .expect_err("still in flight");
        tracker.end("1");
        assert!(
            tracker.begin("runtime.update.begin", "2").is_ok(),
            "releasing the ordinary call must let the update claim proceed"
        );
    }

    #[test]
    fn a_refused_begin_claims_nothing_for_end_to_undo() {
        let tracker = UpdateExclusivityTracker::new(Arc::new(NotUpdating));
        tracker.begin("runtime.update.begin", "1").unwrap();
        tracker
            .begin("shell.run", "2")
            .expect_err("update in flight");
        // "2" was refused, never claimed; ending it must not disturb "1".
        tracker.end("2");
        assert!(
            tracker.begin("shell.run", "3").is_err(),
            "the update claim from \"1\" must still be held"
        );
    }

    #[test]
    fn ending_an_unclaimed_id_is_a_no_op() {
        let tracker = UpdateExclusivityTracker::new(Arc::new(NotUpdating));
        tracker.end("never-claimed");
        assert!(tracker.begin("shell.run", "1").is_ok());
    }
}
