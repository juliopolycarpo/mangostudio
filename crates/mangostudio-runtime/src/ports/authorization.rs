//! Whether a request may proceed at all.
//!
//! Adapts *into* `mango_protocol::contract::Guard` — the SDK's own seam
//! between schema validation and the handler — rather than building a
//! second gate in front of it. Unlike the TypeScript SDK's guard (which the
//! runtime's own `consent-gate.ts` deliberately avoids because it runs
//! *before* parameter validation there), `mango_protocol`'s `Guard` already
//! runs after `check_params`, so this crate has no equivalent reason to
//! reach for a wrapper instead.
//!
//! [`AuthorizationGuard`] is the only [`mango_protocol::contract::Guard`]
//! this crate registers. It asks its [`Authorization`] port which of a
//! method's declared capabilities are missing, denies when that list is
//! non-empty, and records the denial through its [`Audit`] port before
//! returning — mirroring `consent-gate.ts`'s `gateHandlers`, which records
//! `denied` and throws in the same branch, never after.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use mango_protocol::contract::Guard;
use mango_protocol::error::{RemoteError, codes};
use mango_protocol::session::CallContext;
use mangostudio_runtime_contract::errors::CONSENT_DENIED_KIND;
use mangostudio_runtime_contract::strings::runtime_home::BINARY_BASENAME;
use serde_json::Value;

use crate::panic::catch_panics;
use crate::ports::audit::{Audit, AuditEntry, Outcome};
use crate::ports::clock::Clock;
use crate::ports::exclusivity::CallExclusivity;

/// Decides which of a method's declared capabilities this machine has not
/// granted.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::ports::authorization::{Authorization, DenyingAuthorization};
///
/// # #[tokio::main(flavor = "current_thread")]
/// # async fn main() {
/// let capabilities = vec!["shell".to_string()];
/// let missing = DenyingAuthorization.missing_capabilities("shell.run", &capabilities).await;
/// assert_eq!(missing, capabilities);
///
/// let none_required: Vec<String> = vec![];
/// let missing = DenyingAuthorization
///     .missing_capabilities("runtime.health", &none_required)
///     .await;
/// assert!(missing.is_empty());
/// # }
/// ```
pub trait Authorization: Send + Sync + 'static {
    /// The subset of `capabilities` this machine's owner has not granted for
    /// `method`, in the order the contract declares them. An empty result
    /// means the call may proceed — including when `capabilities` itself is
    /// empty, since nothing was asked for.
    fn missing_capabilities<'a>(
        &'a self,
        method: &'a str,
        capabilities: &'a [String],
    ) -> Pin<Box<dyn Future<Output = Vec<String>> + Send + 'a>>;
}

/// Denies every capability a method actually declares; grants a method that
/// declares none. The safe default: it never grants something a machine's
/// owner never agreed to, and it never invents a refusal for a method the
/// contract itself says needs nothing.
#[derive(Debug, Clone, Copy, Default)]
pub struct DenyingAuthorization;

impl Authorization for DenyingAuthorization {
    fn missing_capabilities<'a>(
        &'a self,
        _method: &'a str,
        capabilities: &'a [String],
    ) -> Pin<Box<dyn Future<Output = Vec<String>> + Send + 'a>> {
        Box::pin(async move { capabilities.to_vec() })
    }
}

/// Builds the `DENIED` [`RemoteError`] a consent refusal answers with,
/// mirroring `apps/runtime/src/consent-gate.ts`'s `consentDenial` exactly:
/// message `"{method}" is refused: {because}. Run "mangostudio-runtime setup
/// --slot {slot}" there to change what a hub may do.`, details
/// `{ kind: "consent_denied", method, missing, slot, capability }` where
/// `capability` is `missing[0]` and is omitted from the wire when `missing`
/// is empty (the same way an absent `RemoteError::with_detail` key never
/// serialises), matching TS's `missing[0]` on an empty array serialising as
/// an absent key rather than `null`.
///
/// The empty-`missing` branch of `because` is currently unreachable through
/// [`AuthorizationGuard`], which only calls this when `missing` is
/// non-empty — kept for parity with `consent-gate.ts`, which carries the
/// same dead branch for the same reason.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::ports::authorization::consent_denial;
///
/// let error = consent_denial("shell.run", &["shell".to_string()], "host");
/// assert_eq!(error.code, mango_protocol::error::codes::DENIED);
/// assert_eq!(
///     error.message,
///     "\"shell.run\" is refused: this machine has not granted shell. Run \"mangostudio-runtime setup --slot host\" there to change what a hub may do."
/// );
/// assert_eq!(error.details.unwrap()["capability"], "shell");
/// ```
#[must_use]
pub fn consent_denial(method: &str, missing: &[String], slot: &str) -> RemoteError {
    let because = if missing.is_empty() {
        "no capability governs it, so nothing can grant it".to_string()
    } else {
        format!("this machine has not granted {}", missing.join(" or "))
    };
    let mut error = RemoteError::new(
        codes::DENIED,
        format!(
            "\"{method}\" is refused: {because}. Run \"{BINARY_BASENAME} setup --slot {slot}\" \
             there to change what a hub may do."
        ),
    )
    .with_detail("kind", CONSENT_DENIED_KIND)
    .with_detail("method", method.to_string())
    .with_detail("missing", missing.to_vec())
    .with_detail("slot", slot.to_string());
    if let Some(capability) = missing.first() {
        error = error.with_detail("capability", capability.clone());
    }
    error
}

/// The [`mango_protocol::contract::Guard`] this crate registers: claims this
/// call's [`CallExclusivity`] slot, asks [`Authorization`] which
/// capabilities are missing, denies and records through [`Audit`] if any
/// are, otherwise lets the call through unrecorded —
/// [`crate::registry::Registry::implement`]'s own wrapper records the
/// `ok`/`error` outcome, and releases the exclusivity claim, once the
/// handler (and this crate's result check) have settled. See
/// [`crate::ports::exclusivity`]'s module docs for why the claim and its
/// release live in two different places.
pub struct AuthorizationGuard {
    authorization: Arc<dyn Authorization>,
    exclusivity: Arc<dyn CallExclusivity>,
    audit: Arc<dyn Audit>,
    clock: Arc<dyn Clock>,
    slot: String,
}

struct PendingClaim<'a> {
    exclusivity: &'a dyn CallExclusivity,
    call_id: &'a str,
    handed_off: bool,
}

impl Drop for PendingClaim<'_> {
    fn drop(&mut self) {
        if !self.handed_off {
            self.exclusivity.end(self.call_id);
        }
    }
}

impl AuthorizationGuard {
    /// Builds a guard that claims `exclusivity` before asking `authorization`,
    /// records a denial (or an exclusivity refusal) through `audit`, and
    /// names `slot` in a consent refusal's remediation sentence.
    #[must_use]
    pub fn new(
        authorization: Arc<dyn Authorization>,
        exclusivity: Arc<dyn CallExclusivity>,
        audit: Arc<dyn Audit>,
        clock: Arc<dyn Clock>,
        slot: impl Into<String>,
    ) -> Self {
        Self {
            authorization,
            exclusivity,
            audit,
            clock,
            slot: slot.into(),
        }
    }
}

impl Guard for AuthorizationGuard {
    fn check<'a>(
        &'a self,
        method: &'a str,
        _params: &'a Value,
        capabilities: &'a [String],
        context: &'a CallContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), RemoteError>> + Send + 'a>> {
        Box::pin(async move {
            let started = self.clock.now();
            let call_id = context.id();
            // Checked, and claimed, before the authorization check itself —
            // mirroring `consent-gate.ts`'s own ordering (exclusivity first,
            // consent read second). A refusal here never reaches
            // `Authorization` at all, and claims nothing for anyone to
            // release.
            let outcome: Result<(), RemoteError> = match self.exclusivity.begin(method, call_id) {
                Err(refusal) => Err(refusal),
                Ok(()) => {
                    let mut claim = PendingClaim {
                        exclusivity: self.exclusivity.as_ref(),
                        call_id,
                        handed_off: false,
                    };
                    // Only the authorization check itself is inside this
                    // catch: a panic here becomes the wire result
                    // (INTERNAL), distinct from an ordinary denial (DENIED).
                    // Recording is deliberately outside it — see the two
                    // audit-parity notes on `Registry::implement`, which
                    // this mirrors.
                    let result = catch_panics(async move {
                        let missing = self
                            .authorization
                            .missing_capabilities(method, capabilities)
                            .await;
                        if missing.is_empty() {
                            Ok(())
                        } else {
                            Err(consent_denial(method, &missing, &self.slot))
                        }
                    })
                    .await;
                    if result.is_ok() {
                        // Registry now owns this claim. A denied, panicking,
                        // or cancelled authorization read drops `claim` and
                        // releases it before any handler can run.
                        claim.handed_off = true;
                    }
                    result
                }
            };

            if let Err(error) = &outcome {
                // A real denial carries `capability` in its details; a
                // panic-turned-INTERNAL carries no details at all, so this
                // stays `None` for that case without a separate branch.
                let capability = error
                    .details
                    .as_ref()
                    .and_then(|details| details.get("capability"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let audit_outcome = if error.code == codes::DENIED {
                    Outcome::Denied
                } else {
                    Outcome::Error
                };
                let entry = AuditEntry {
                    method: method.to_string(),
                    outcome: audit_outcome,
                    duration: self.clock.now().duration_since(started),
                    capability,
                    code: Some(error.code.clone()),
                };
                // Isolated in its own catch: a panicking Audit sink must
                // never turn an already-computed denial/error into
                // something else on the wire.
                let audit = Arc::clone(&self.audit);
                let _ = catch_panics(async move {
                    audit.record(entry).await;
                    Ok::<(), RemoteError>(())
                })
                .await;
            }

            outcome
        })
    }
}

#[cfg(test)]
mod tests {
    use mango_protocol::error::codes;
    use serde_json::json;

    use super::consent_denial;

    // `AuthorizationGuard`'s own behaviour needs a real `CallContext`, which
    // `mango_protocol` only ever constructs while dispatching an actual
    // request — there is no public constructor to hand-build one here. See
    // `tests/consent.rs` for `AuthorizationGuard` exercised through a real
    // session, which is also where `DenyingAuthorization` is proved to deny
    // a capability-bearing method and pass a zero-capability one.

    #[test]
    fn consent_denial_matches_the_typescript_wire_shape() {
        let error = consent_denial("shell.run", &["shell".to_string()], "host");
        assert_eq!(error.code, codes::DENIED);
        assert_eq!(
            error.message,
            "\"shell.run\" is refused: this machine has not granted shell. Run \"mangostudio-runtime setup --slot host\" there to change what a hub may do."
        );
        let details = error.details.expect("details present");
        assert_eq!(details["kind"], json!("consent_denied"));
        assert_eq!(details["method"], json!("shell.run"));
        assert_eq!(details["missing"], json!(["shell"]));
        assert_eq!(details["slot"], json!("host"));
        assert_eq!(details["capability"], json!("shell"));
    }

    #[test]
    fn consent_denial_joins_more_than_one_missing_capability_with_or() {
        let missing = vec!["fsRead".to_string(), "fsWrite".to_string()];
        let error = consent_denial("fs.move", &missing, "wsl");
        assert!(error.message.contains("has not granted fsRead or fsWrite"));
        assert_eq!(error.details.unwrap()["capability"], json!("fsRead"));
    }

    #[test]
    fn consent_denial_omits_capability_when_nothing_is_missing() {
        let error = consent_denial("runtime.health", &[], "host");
        assert!(error.details.unwrap().get("capability").is_none());
    }
}
