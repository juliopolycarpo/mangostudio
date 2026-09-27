//! Recording what happened, after the fact.
//!
//! Wraps *outside* [`crate::ports::authorization::AuthorizationGuard`] and
//! outside [`crate::registry::Registry::implement`]'s wrapped handler, so a
//! consent denial and a handler's own outcome are both recorded — in the
//! same order `apps/runtime/src/consent-gate.ts`'s `gateHandlers` records
//! them: a denial before the handler ever runs, `ok`/`error` only after the
//! handler (and, in this crate, the result check) has settled.
//!
//! One parity gap against the TypeScript runtime, stated rather than hidden:
//! `gateHandlers` measures one duration per call, from before its own
//! consent check to after the handler returns. This crate does not do that
//! — [`crate::ports::authorization::AuthorizationGuard`] and
//! [`crate::registry::Registry::implement`]'s wrapper are two separate
//! `mango_protocol` seams with no shared start time passed between them, so
//! a `denied` entry's [`AuditEntry::duration`] measures only the
//! authorization check, and an `ok`/`error` entry's measures only the
//! handler (plus this crate's own result check). A shared seam is workable
//! (a start-instant map keyed on `CallContext::id`, populated by the guard
//! and consumed by the wrapper) but not built here. Concretely, this means
//! an `ok`/`error` entry's duration *excludes* the authorization step, which
//! in the TypeScript runtime is a disk read — comparing the two runtimes'
//! audit logs side by side would otherwise read as a real speedup that is
//! purely an artefact of where each one starts the clock.
//!
//! The default, [`NoopAudit`], records nothing. That is the fail-closed
//! choice for an audit sink specifically: unlike authorization, where
//! refusing is the safe default, an audit sink that fabricated entries would
//! be worse than one that stays silent, so "does nothing" is what "safe"
//! means here.
//!
//! ## Why `AuditEntry` carries no `params`
//!
//! `apps/runtime/src/consent-gate.ts`'s `record` call passes `params`, and
//! `audit-log.ts` renders a redacted summary of them
//! (`summarizeAuditArgs(method, params)`) into the line — the "what was
//! asked" half of an audit entry this type does not carry. `summarizeAuditArgs`
//! is two things: a fixed whitelist of known-safe parameter keys (`path`,
//! `command`, `cols`, …), which is method-aware and this crate has no
//! params shapes to build one against yet, and a params-shape-agnostic
//! redaction/truncation pass, which [`crate::audit::redact`] already
//! mirrors and tests, ready for whichever change adds the whitelist and
//! calls it. Carrying raw, unredacted `params` here in the meantime would
//! risk exactly the leak this crate's other seams (`panic::catch_panics`,
//! `result_check`) all exist to prevent — a file's contents or a shell
//! command ending up in a log line. Deliberately omitted for now; a later
//! change that implements methods is what should also design the whitelist
//! and add the field.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

/// What a recorded call settled as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// The handler ran and its result passed the contract's schema.
    Ok,
    /// [`crate::ports::authorization::Authorization`] refused the call
    /// before the handler ever ran.
    Denied,
    /// The handler, or this crate's own result check, returned an error.
    Error,
}

/// One call's outcome, as [`crate::ports::audit::Audit::record`] receives it.
#[derive(Debug, Clone)]
pub struct AuditEntry {
    /// The method this entry is about.
    pub method: String,
    /// How the call settled.
    pub outcome: Outcome,
    /// How long the recorded phase took. See the module docs for which
    /// phase that is, depending on [`AuditEntry::outcome`].
    pub duration: Duration,
    /// The single capability a denial named, when [`AuditEntry::outcome`] is
    /// [`Outcome::Denied`]. Mirrors `consent-gate.ts`'s `record` call, which
    /// includes `capability` only when the error carries one.
    pub capability: Option<String>,
    /// The wire `error.code` a failed call answered with, when
    /// [`AuditEntry::outcome`] is not [`Outcome::Ok`].
    pub code: Option<String>,
}

/// Records one call's outcome, after the fact.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::ports::audit::{Audit, AuditEntry, NoopAudit, Outcome};
/// use std::time::Duration;
///
/// # #[tokio::main(flavor = "current_thread")]
/// # async fn main() {
/// NoopAudit
///     .record(AuditEntry {
///         method: "runtime.health".to_string(),
///         outcome: Outcome::Ok,
///         duration: Duration::ZERO,
///         capability: None,
///         code: None,
///     })
///     .await;
/// # }
/// ```
pub trait Audit: Send + Sync + 'static {
    /// Records `entry`. Never fails: an audit sink that cannot record has
    /// nothing useful to tell the caller that would not also risk turning a
    /// logging failure into a request failure.
    fn record<'a>(&'a self, entry: AuditEntry) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>>;

    /// Names the hub whose call is about to be recorded, from the
    /// `capabilities` of the `hello` that call's session received.
    ///
    /// [`crate::ports::authorization::AuthorizationGuard`] calls this at the
    /// start of every call, before anything that call can record, so the
    /// first call a hub makes the instant its handshake completes is never
    /// recorded as an unidentified hub. The default does nothing: a sink
    /// with no hub field has nothing to name.
    ///
    /// # Example
    ///
    /// ```
    /// use mangostudio_runtime::ports::audit::{Audit, NoopAudit};
    ///
    /// let capabilities = serde_json::json!({ "hub": { "user": "bob", "host": "desk" } });
    /// NoopAudit.identify_hub(capabilities.as_object().unwrap());
    /// ```
    fn identify_hub(&self, _capabilities: &serde_json::Map<String, serde_json::Value>) {}
}

/// Records nothing. The safe default: see the module docs for why "does
/// nothing" is the fail-closed choice for an audit sink specifically.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoopAudit;

impl Audit for NoopAudit {
    fn record<'a>(&'a self, _entry: AuditEntry) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async {})
    }
}

/// Locks `mutex`, recovering the guard even if a prior holder panicked.
///
/// This is silent reuse of state a panic interrupted — plainly stated,
/// because that is a real trade-off, not a free recovery. It is safe here
/// only because it is convention, not something the type system enforces:
/// every critical section behind a port's own `Mutex` in this crate is a
/// short, panic-free push onto a log, and *never held across a handler's*
/// `.await`. Since `lock` is `pub`, nothing stops a future caller from
/// wrapping a `.await` inside its critical section — doing so would silently
/// reuse a torn invariant, and this function would not detect it. Mirrors
/// `mango_protocol::session::shared::lock` (private to that crate, so this
/// is a deliberate re-derivation, not a reuse): recovering avoids turning
/// one handler's panic into a second, unrelated panic in an audit sink that
/// had nothing to do with the first one.
///
/// A future port whose critical section *can* span a handler's own work (and
/// so can legitimately be left mid-mutation by a panic) must not reuse this
/// helper — it should repair, discard, or explicitly close instead, since
/// recovering a genuinely torn invariant is not safe.
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::lock;

    #[test]
    fn a_healthy_mutex_locks_normally() {
        let mutex = Mutex::new(vec![1, 2, 3]);
        assert_eq!(*lock(&mutex), vec![1, 2, 3]);
    }

    #[test]
    fn a_poisoned_mutex_recovers_instead_of_panicking_again() {
        let mutex = Mutex::new(vec![1]);
        let poisoned = std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    let mut guard = mutex.lock().expect("not yet poisoned");
                    guard.push(2);
                    panic!("simulates a handler panicking while holding a port's lock");
                })
                .join()
                .is_err()
        });
        assert!(poisoned, "the spawned thread must have panicked");
        // `lock`'s whole point: this must not panic a second time, and it
        // must hand back whatever the panicking holder left behind, not a
        // fresh/default value — recovery, not silent replacement.
        let recovered = lock(&mutex);
        assert_eq!(*recovered, vec![1, 2]);
    }
}
