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
//!   `Registry::implement`'s own wrapper once the handler settles. An owned
//!   blocking effect transfers the claim and releases it only after machine
//!   work settles, even when the request future is dropped.
//!
//! Both sides key a claim on [`mango_protocol::session::CallContext::id`]
//! rather than a fresh token the way TypeScript's `Symbol()` does, because a
//! [`crate::registry::Registry`] is consumed whole by one
//! [`crate::serve::serve`] call. Production's slot-shared tracker prefixes
//! each request id with its connection owner before forwarding a claim, so
//! identical request ids on two sessions cannot collide.

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
/// `runtime.update.commit`. `crate::update::UpdateService` implements this
/// for production; [`NotUpdating`] remains useful for isolated tests.
pub trait UpdateActivity: Send + Sync + 'static {
    /// Whether an update is currently in progress.
    fn is_active(&self) -> bool;
}

/// Effects such as bounded blocking I/O that may outlive the request future
/// which started them. An update cannot begin until they settle.
pub trait OrdinaryEffectActivity: Send + Sync + 'static {
    /// Whether any ordinary effect still owns machine work.
    fn is_active(&self) -> bool;
}

/// The default for a tracker used outside production effect tracking.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoOrdinaryEffects;

impl OrdinaryEffectActivity for NoOrdinaryEffects {
    fn is_active(&self) -> bool {
        false
    }
}

/// Reads the process-wide blocking pool's effect count.
#[derive(Debug, Clone, Copy, Default)]
pub struct ProcessBlockingEffects;

impl OrdinaryEffectActivity for ProcessBlockingEffects {
    fn is_active(&self) -> bool {
        crate::blocking::active_count() != 0
    }
}

/// Reports no active update for isolated trackers and examples.
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

    /// Retains a claim after its request future is dropped because an owned
    /// effect will continue. The owner must later call `end_effect`.
    fn transfer_to_effect(&self, _call_id: &str) {}

    /// Releases a claim transferred to an effect, after that effect settles.
    fn end_effect(&self, call_id: &str) {
        self.end(call_id);
    }
}

/// Transfers a request claim to an effect that may outlive its handler.
///
/// ```ignore
/// let claim = EffectClaim::new(exclusivity, context.id());
/// tokio::spawn(async move { let _claim = claim; finish_effect().await });
/// ```
pub(crate) struct EffectClaim {
    exclusivity: Arc<dyn CallExclusivity>,
    call_id: String,
}

impl EffectClaim {
    pub(crate) fn new(exclusivity: Arc<dyn CallExclusivity>, call_id: &str) -> Self {
        exclusivity.transfer_to_effect(call_id);
        Self {
            exclusivity,
            call_id: call_id.to_owned(),
        }
    }
}

impl Drop for EffectClaim {
    fn drop(&mut self) {
        self.exclusivity.end_effect(&self.call_id);
    }
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
    /// Claims whose request has handed cleanup to the actual effect.
    effects: HashSet<String>,
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
    ordinary_effects: Arc<dyn OrdinaryEffectActivity>,
}

impl UpdateExclusivityTracker {
    /// Builds a tracker with nothing claimed yet, consulting `update_active`
    /// for whether an update lifecycle outside any single call is under way.
    #[must_use]
    pub fn new(update_active: Arc<dyn UpdateActivity>) -> Self {
        Self::with_effects(update_active, Arc::new(NoOrdinaryEffects))
    }

    /// Also refuses an update while an ordinary effect has outlived its
    /// request, such as an OS write still running on the blocking pool.
    #[must_use]
    pub fn with_effects(
        update_active: Arc<dyn UpdateActivity>,
        ordinary_effects: Arc<dyn OrdinaryEffectActivity>,
    ) -> Self {
        Self {
            claims: Mutex::new(Claims::default()),
            update_active,
            ordinary_effects,
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
        if is_update && (!claims.total.is_empty() || self.ordinary_effects.is_active()) {
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
        if claims.effects.contains(call_id) {
            return;
        }
        claims.total.remove(call_id);
        claims.updates.remove(call_id);
    }

    fn transfer_to_effect(&self, call_id: &str) {
        let mut claims = lock(&self.claims);
        if claims.total.contains(call_id) {
            claims.effects.insert(call_id.to_owned());
        }
    }

    fn end_effect(&self, call_id: &str) {
        let mut claims = lock(&self.claims);
        claims.effects.remove(call_id);
        claims.total.remove(call_id);
        claims.updates.remove(call_id);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};
    use std::thread;

    use super::{
        CallExclusivity, EffectClaim, NoExclusivity, NotUpdating, UpdateActivity,
        UpdateExclusivityTracker,
    };

    /// Runs `race` under a two-thread [`Barrier`] many times over, so a
    /// check-then-claim window that only sometimes overlaps still gets
    /// caught: a `Barrier` makes both threads call `begin` at essentially
    /// the same instant, but a race that depends on exact scheduling is not
    /// guaranteed to fire on any single attempt. Never a `sleep` — the
    /// barrier is the only synchronisation this needs, and asserting inside
    /// `race` on every iteration is what turns "usually passes" into
    /// "never passes while the bug exists".
    ///
    /// 500 attempts is not an arbitrary round number: measured by reverting
    /// this file to its pre-fix shape (a separate `Mutex` each for `total`
    /// and `updates`, with `is_active()` called under neither) and counting
    /// how many of 500 attempts actually produced a double-success across
    /// five repeated runs on an 18-core machine, `two_concurrent_update_begins`
    /// landed 2-9 hits per 500 (0.4%-1.8% per attempt) and
    /// `a_concurrent_update_and_an_ordinary_call` landed 5-15 (1%-3%) — not a
    /// rate a handful of iterations would reliably catch, and not perfectly
    /// stable either: the worst observed run (2/500) alone would only give
    /// roughly 86% confidence of at least one hit, which is why this relies
    /// on 500 attempts and not a single measurement of "it worked once".
    /// Lowering this constant materially weakens what a future regression on
    /// this file would need to survive before merging.
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
    fn an_ordinary_calls_exclusivity_check_holds_the_lock_across_is_active_too() {
        // Deterministic companion to the barrier test above, rather than a
        // replacement for it: that test relies on scheduling luck to make
        // the two calls overlap; this one manufactures the overlap exactly,
        // by parking the ordinary call's `is_active()` on a channel. Under
        // the pre-fix shape (`is_active()` called under neither `total` nor
        // `updates`), a concurrent update `begin()` needs no lock this call
        // holds and returns immediately; under the fix, `begin()` holds the
        // single `claims` lock across the entire decision including
        // `is_active()`, so the update call cannot even acquire that lock
        // until the ordinary call's own `begin()` returns and drops it.
        use std::sync::{Mutex, mpsc};
        use std::time::Duration;

        use crate::ports::audit::lock;

        struct BlocksOnEveryCall {
            entered: mpsc::SyncSender<()>,
            // `is_active` takes `&self`, and `UpdateActivity` requires
            // `Sync` — a bare `Receiver` is `Send` but not `Sync`, so it
            // needs a `Mutex` even though only one thread ever calls in.
            release: Mutex<mpsc::Receiver<()>>,
        }

        impl UpdateActivity for BlocksOnEveryCall {
            fn is_active(&self) -> bool {
                self.entered.send(()).unwrap();
                lock(&self.release).recv().unwrap();
                false
            }
        }

        let (entered_tx, entered_rx) = mpsc::sync_channel(0);
        let (release_tx, release_rx) = mpsc::channel();
        let tracker = Arc::new(UpdateExclusivityTracker::new(Arc::new(BlocksOnEveryCall {
            entered: entered_tx,
            release: Mutex::new(release_rx),
        })));

        let ordinary = {
            let tracker = Arc::clone(&tracker);
            thread::spawn(move || tracker.begin("shell.run", "ordinary").is_ok())
        };
        // Blocks until the ordinary call's begin() is parked inside
        // is_active(), which under the fix means it is still holding
        // `claims` — the only thing that can make the assertion below mean
        // anything, rather than just being lucky about scheduling. A bounded
        // wait, not a bare `recv()`: a future regression that stops calling
        // `is_active()` at all for an ordinary call must fail this test
        // outright, not hang it forever.
        entered_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("begin() must call is_active() for an ordinary call");

        let (update_result_tx, update_result_rx) = mpsc::channel();
        let update = {
            let tracker = Arc::clone(&tracker);
            thread::spawn(move || {
                let ok = tracker.begin("runtime.update.begin", "update").is_ok();
                update_result_tx.send(ok).unwrap();
            })
        };
        assert_eq!(
            update_result_rx.recv_timeout(Duration::from_millis(100)),
            Err(mpsc::RecvTimeoutError::Timeout),
            "an update begin() must not be able to return while an ordinary call's exclusivity \
             check is still deciding, is_active() included"
        );

        release_tx.send(()).unwrap();
        assert!(
            ordinary.join().unwrap(),
            "the ordinary call itself must still succeed once released"
        );
        update.join().unwrap();
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
    fn an_effect_keeps_its_claim_after_the_request_is_released() {
        let tracker = Arc::new(UpdateExclusivityTracker::new(Arc::new(NotUpdating)));
        tracker.begin("shell.run", "1").unwrap();
        let effect = EffectClaim::new(tracker.clone(), "1");
        tracker.end("1");
        let error = tracker.begin("runtime.update.begin", "2").unwrap_err();
        assert_eq!(error.details.unwrap()["reason"], "call_in_flight");
        drop(effect);
        tracker.begin("runtime.update.begin", "2").unwrap();
        tracker.end("2");
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
