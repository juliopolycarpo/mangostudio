//! The set of methods this build actually implements.
//!
//! A bare [`Registry::new`] is empty; `crate::transport::build_host`
//! (crate-private) fills a production one through [`Registry::implement`]
//! via the health, workspace, probing, and filesystem registration functions.
//! The filesystem registration includes the three `snapshot.*` methods.
//! This crate's own tests reach for
//! the same [`Registry::implement`] seam with named fakes, to prove the
//! dispatch plumbing without a real filesystem or subprocess underneath.
//!
//! A method the embedded catalog declares but this registry has not
//! implemented is simply never registered on the underlying
//! `mango_protocol::contract::ContractHandlers` — so
//! `mango_protocol::session::dispatch`'s own "no handler for this method"
//! branch answers it with `METHOD_UNSUPPORTED`, byte-identical to a method no
//! catalog anywhere has ever declared. [`Registry::classify`] tells the two
//! apart for diagnostics only; neither this crate nor `mango_protocol`
//! invents a second wire code for "known but unimplemented".

use std::future::Future;
use std::sync::Arc;

use mango_protocol::contract::ContractHandlers;
use mango_protocol::error::{RemoteError, codes};
use mango_protocol::session::CallContext;
use mangostudio_runtime_contract::catalog::{catalog, method};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::panic::catch_panics;
use crate::ports::audit::{Audit, AuditEntry, NoopAudit, Outcome};
use crate::ports::clock::{Clock, SystemClock};
use crate::ports::exclusivity::{CallExclusivity, NoExclusivity};
use crate::result_check::{check_result, compile_result_schema};

/// Whether a method name is implemented, declared but not implemented, or
/// not part of the contract at all. Diagnostic only: every case other than
/// [`Classification::Implemented`] answers the same `METHOD_UNSUPPORTED`
/// wire error, because this registry never registers a handler for either.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Classification {
    /// [`Registry::implement`] registered a handler for this method.
    Implemented,
    /// The catalog declares this method; this registry has not implemented
    /// it (yet).
    KnownUnimplemented,
    /// No catalog this crate embeds declares this method at all.
    Unknown,
}

/// Builds the handlers a [`mango_protocol::contract::Contract::serve`] call
/// registers, tracking which methods were actually implemented.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::registry::{Classification, Registry};
///
/// let registry = Registry::new();
/// assert!(registry.implemented_methods().is_empty());
/// assert_eq!(registry.classify("runtime.health"), Classification::KnownUnimplemented);
/// assert_eq!(registry.classify("no.such.method"), Classification::Unknown);
/// ```
pub struct Registry {
    handlers: ContractHandlers,
    implemented: Vec<String>,
    audit: Arc<dyn Audit>,
    clock: Arc<dyn Clock>,
    exclusivity: Arc<dyn CallExclusivity>,
}

impl Default for Registry {
    fn default() -> Self {
        Self::new()
    }
}

impl Registry {
    /// An empty registry: no methods implemented, outcomes recorded through
    /// [`NoopAudit`] against [`SystemClock`], and [`NoExclusivity`] enforced.
    /// Use [`Registry::with_ports`] to record through a real [`Audit`] sink,
    /// or [`Registry::with_ports_and_exclusivity`] to also enforce update
    /// exclusivity.
    #[must_use]
    pub fn new() -> Self {
        Self::with_ports(Arc::new(NoopAudit), Arc::new(SystemClock))
    }

    /// An empty registry that records every implemented method's outcome
    /// through `audit`, timed by `clock`, with [`NoExclusivity`] enforced.
    #[must_use]
    pub fn with_ports(audit: Arc<dyn Audit>, clock: Arc<dyn Clock>) -> Self {
        Self::with_ports_and_exclusivity(audit, clock, Arc::new(NoExclusivity))
    }

    /// An empty registry that also releases `exclusivity`'s claim on every
    /// implemented method once its handler settles — see
    /// [`crate::ports::exclusivity`]'s module docs for why the claim itself
    /// is taken elsewhere, in [`crate::ports::authorization::AuthorizationGuard`].
    #[must_use]
    pub fn with_ports_and_exclusivity(
        audit: Arc<dyn Audit>,
        clock: Arc<dyn Clock>,
        exclusivity: Arc<dyn CallExclusivity>,
    ) -> Self {
        Self {
            handlers: ContractHandlers::new(),
            implemented: Vec::new(),
            audit,
            clock,
            exclusivity,
        }
    }

    /// Registers `handler` for `method`, wrapped so that, in order: a panic
    /// anywhere in `handler`'s own future becomes a bounded, redacted
    /// `INTERNAL` error (see [`crate::panic`]); a successful result is
    /// checked against the contract's schema before this registry records
    /// anything (see [`crate::result_check`]); and the outcome — `Ok`,
    /// `Error`, or the panic case — is recorded through this registry's
    /// [`Audit`] port only once all of that has already happened. This
    /// mirrors `apps/runtime/src/consent-gate.ts`'s `gateHandlers` composed
    /// with `checkResults`: the audit line reflects whether the *checked*
    /// result was valid, never the handler's raw, unchecked return value.
    ///
    /// `P` and `R` need not match the method's declared schema exactly:
    /// [`mango_protocol::contract::Contract::serve`] validates the wire
    /// `params` before this wrapper decodes `P`, and this registry validates
    /// the serialised `R` before it is ever sent, so a type mismatch in
    /// either direction is caught, never silently coerced. Decoding here,
    /// rather than in `ContractHandlers`' typed registration, is essential:
    /// it keeps a decode error or a custom `Deserialize` panic inside this
    /// wrapper's redaction, audit, and exclusivity cleanup boundary.
    ///
    /// # Panics
    /// Panics if `method` is not declared by the embedded catalog. A
    /// registry registering a method its own contract does not know about is
    /// a build-time mistake in this crate (or in whatever registers methods
    /// on top of it), not a condition a caller can recover from — the same
    /// reasoning `mangostudio_runtime_contract::catalog::catalog` uses for a
    /// malformed embedded artifact.
    ///
    /// # Example
    ///
    /// ```
    /// use mangostudio_runtime::registry::Registry;
    /// use serde_json::{Value, json};
    ///
    /// let registry = Registry::new().implement(
    ///     "runtime.health",
    ///     |_params: Value, _context| async move {
    ///         Ok::<_, mango_protocol::RemoteError>(json!({
    ///             "schemaVersion": 1, "slot": "host", "source": "bundled",
    ///             "runtimeVersion": "0.0.0", "version": null, "binaryPath": null,
    ///             "digest": null, "profile": "none",
    ///             "allow": { "fsRead": false, "fsWrite": false, "shell": false, "git": false,
    ///                        "probing": false, "mcp": false, "library": false,
    ///                        "checkpoints": false, "update": false },
    ///             "setup": { "state": "pending" }, "platform": "linux", "arch": "x86_64",
    ///             "homeDir": "/home/mango", "shells": [], "git": { "available": false },
    ///             "lastError": null,
    ///         }))
    ///     },
    /// );
    /// assert_eq!(registry.implemented_methods(), vec!["runtime.health"]);
    /// ```
    #[must_use]
    pub fn implement<P, R, F, Fut>(mut self, method_name: impl Into<String>, handler: F) -> Self
    where
        P: DeserializeOwned + Send + 'static,
        R: Serialize + Send + 'static,
        F: Fn(P, CallContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<R, RemoteError>> + Send + 'static,
    {
        let method_name = method_name.into();
        let declared = method(&method_name).unwrap_or_else(|| {
            panic!(
                "\"{method_name}\" is not declared by the embedded catalog; a registry may only \
                 implement a method its own contract knows about"
            )
        });
        assert!(
            !self
                .implemented
                .iter()
                .any(|implemented| implemented == &method_name),
            "\"{method_name}\" is already implemented; Session::handle's own HashMap::insert \
             would silently shadow the first handler, and implemented_methods() would report \
             the name twice"
        );
        let validator = Arc::new(compile_result_schema(&declared.result));
        let handler = Arc::new(handler);
        let audit = Arc::clone(&self.audit);
        let clock = Arc::clone(&self.clock);
        let exclusivity = Arc::clone(&self.exclusivity);

        self.implemented.push(method_name.clone());
        self.handlers = self.handlers.on(
            method_name.clone(),
            // Register `Value`, not `P`: ContractHandlers otherwise decodes
            // P synchronously before this closure constructs its future.
            // That would bypass this wrapper's panic redaction, audit line,
            // and unconditional exclusivity release.
            move |params: Value, context: CallContext| {
                let method_name = method_name.clone();
                let handler = Arc::clone(&handler);
                let validator = Arc::clone(&validator);
                let audit = Arc::clone(&audit);
                let clock = Arc::clone(&clock);
                let exclusivity = Arc::clone(&exclusivity);
                // Taken before `context` moves into `handler` below: this is
                // the same call the guard already claimed (see
                // `crate::ports::exclusivity`'s module docs), and this
                // wrapper is the one place that releases it once the
                // handler has settled, whatever that settlement turns out
                // to be.
                let call_id = context.id().to_string();
                async move {
                    let started = clock.now();
                    // Parameter decoding, the handler, its serialisation,
                    // and the result check are inside this catch: a panic
                    // here becomes the wire result. Recording is
                    // deliberately outside it — see the two audit-parity
                    // notes below.
                    let recorded: Result<Value, RemoteError> = catch_panics({
                        let method_name = method_name.clone();
                        async move {
                            let params: P = serde_json::from_value(params).map_err(|error| {
                                RemoteError::new(
                                    codes::INTERNAL,
                                    format!(
                                        "Parameters of \"{method_name}\" passed their schema but failed \
                                         to decode into the handler's Rust type: {error}."
                                    ),
                                )
                                .with_detail("method", method_name.clone())
                            })?;
                            match handler(params, context).await {
                                Ok(result) => match serde_json::to_value(result) {
                                    Ok(value) => check_result(&method_name, &validator, &value)
                                        .map(|()| value),
                                    Err(error) => Err(RemoteError::new(
                                        codes::INTERNAL,
                                        format!(
                                            "Result of \"{method_name}\" failed to serialise: \
                                             {error}."
                                        ),
                                    )
                                    .with_detail("method", method_name.clone())),
                                },
                                Err(error) => Err(error),
                            }
                        }
                    })
                    .await;

                    // The claim `AuthorizationGuard` took for this call is
                    // released here, unconditionally — success, a handler
                    // error, or a panic all settle it exactly once, matching
                    // `consent-gate.ts`'s `finally`.
                    exclusivity.end(&call_id);

                    // Always recorded, even when `recorded` above is itself
                    // the panic case — a panicking handler is exactly the
                    // outcome an operator most needs in the audit trail
                    // (apps/runtime/src/consent-gate.ts's `gateHandlers`
                    // records `outcome: "error"` for any unhandled throw).
                    let audit_outcome = if recorded.is_ok() {
                        Outcome::Ok
                    } else {
                        Outcome::Error
                    };
                    let entry = AuditEntry {
                        method: method_name.clone(),
                        outcome: audit_outcome,
                        duration: clock.now().duration_since(started),
                        capability: None,
                        code: recorded.as_ref().err().map(|error| error.code.clone()),
                    };
                    // Isolated in its own catch: a panicking Audit sink must
                    // never turn an already-computed `recorded` into
                    // something else — that would break the port's own
                    // documented "never fails" contract by letting a
                    // logging failure change what the hub is told.
                    let _ = catch_panics(async move {
                        audit.record(entry).await;
                        Ok::<(), RemoteError>(())
                    })
                    .await;

                    recorded
                }
            },
        );
        self
    }

    /// Every method name [`Registry::implement`] registered, sorted.
    #[must_use]
    pub fn implemented_methods(&self) -> Vec<&str> {
        let mut methods: Vec<&str> = self.implemented.iter().map(String::as_str).collect();
        methods.sort_unstable();
        methods
    }

    /// Every catalog method this registry has not implemented, sorted. For
    /// diagnostics (e.g. a future `runtime.health` report) — never used to
    /// decide the wire error a call to one of them gets, which is always
    /// `METHOD_UNSUPPORTED` regardless of whether this list, or no catalog
    /// at all, is why.
    #[must_use]
    pub fn unimplemented_methods(&self) -> Vec<&'static str> {
        let mut methods: Vec<&'static str> = catalog()
            .methods
            .iter()
            .map(|declared| declared.name.as_str())
            .filter(|name| {
                !self
                    .implemented
                    .iter()
                    .any(|implemented| implemented == name)
            })
            .collect();
        methods.sort_unstable();
        methods
    }

    /// Whether `method` is implemented, known but unimplemented, or unknown
    /// to the embedded catalog. See the type's own docs for why every case
    /// but [`Classification::Implemented`] answers the same wire error.
    #[must_use]
    pub fn classify(&self, method_name: &str) -> Classification {
        if self
            .implemented
            .iter()
            .any(|implemented| implemented == method_name)
        {
            return Classification::Implemented;
        }
        if method(method_name).is_some() {
            return Classification::KnownUnimplemented;
        }
        Classification::Unknown
    }

    /// This registry's own [`Audit`] sink, so [`crate::serve::serve`] can
    /// build its [`crate::ports::authorization::AuthorizationGuard`] against
    /// the same sink every implemented method's outcome is already recorded
    /// through, rather than requiring a caller to supply it twice and risk
    /// the two drifting apart.
    #[must_use]
    pub fn audit(&self) -> Arc<dyn Audit> {
        Arc::clone(&self.audit)
    }

    /// This registry's own [`Clock`]. See [`Registry::audit`] for why
    /// [`crate::serve::serve`] reuses it rather than taking a second one.
    #[must_use]
    pub fn clock(&self) -> Arc<dyn Clock> {
        Arc::clone(&self.clock)
    }

    /// This registry's own [`CallExclusivity`]. [`crate::serve::serve`]
    /// builds its [`crate::ports::authorization::AuthorizationGuard`] against
    /// this same tracker, so the claim the guard takes and the release this
    /// registry's own wrapper performs are always the same instance — see
    /// [`Registry::audit`] for why that matters, and
    /// [`crate::ports::exclusivity`]'s module docs for the split itself.
    #[must_use]
    pub fn exclusivity(&self) -> Arc<dyn CallExclusivity> {
        Arc::clone(&self.exclusivity)
    }

    /// Hands the built handlers to [`crate::serve::serve`]. Not `pub`: a
    /// caller reaches `mango_protocol::contract::ContractHandlers` only
    /// through [`crate::serve::serve`], which pairs it with this crate's own
    /// [`mango_protocol::contract::Guard`] adapter — handing out the raw
    /// handlers would let a caller serve them without that guard in place.
    pub(crate) fn into_contract_handlers(self) -> ContractHandlers {
        self.handlers
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::{Classification, Registry};

    fn health_result() -> Value {
        json!({
            "schemaVersion": 1, "slot": "host", "source": "bundled",
            "runtimeVersion": "0.0.0", "version": null, "binaryPath": null,
            "digest": null, "profile": "none",
            "allow": { "fsRead": false, "fsWrite": false, "shell": false, "git": false,
                       "probing": false, "mcp": false, "library": false,
                       "checkpoints": false, "update": false },
            "setup": { "state": "pending" }, "platform": "linux", "arch": "x86_64",
            "homeDir": "/home/mango", "shells": [], "git": { "available": false },
            "lastError": null,
        })
    }

    #[test]
    fn an_empty_registry_implements_nothing() {
        let registry = Registry::new();
        assert!(registry.implemented_methods().is_empty());
        assert!(!registry.unimplemented_methods().is_empty());
        assert_eq!(
            registry.classify("runtime.health"),
            Classification::KnownUnimplemented
        );
    }

    #[test]
    fn implementing_a_method_moves_it_out_of_the_unimplemented_list() {
        let registry =
            Registry::new().implement("runtime.health", |_params: Value, _context| async move {
                Ok::<_, mango_protocol::RemoteError>(health_result())
            });
        assert_eq!(registry.implemented_methods(), vec!["runtime.health"]);
        assert!(!registry.unimplemented_methods().contains(&"runtime.health"));
        assert_eq!(
            registry.classify("runtime.health"),
            Classification::Implemented
        );
    }

    #[test]
    fn an_unknown_method_is_classified_as_unknown_not_unimplemented() {
        let registry = Registry::new();
        assert_eq!(registry.classify("no.such.method"), Classification::Unknown);
    }

    #[test]
    #[should_panic(expected = "is not declared by the embedded catalog")]
    fn implementing_an_undeclared_method_panics_before_serve_ever_runs() {
        let _ = Registry::new()
            .implement("no.such.method", |_params: Value, _context| async move {
                Ok::<_, mango_protocol::RemoteError>(json!({}))
            });
    }

    #[test]
    #[should_panic(expected = "\"runtime.health\" is already implemented")]
    fn implementing_the_same_method_twice_panics_instead_of_silently_shadowing() {
        let handler = |_params: Value, _context| async move {
            Ok::<_, mango_protocol::RemoteError>(health_result())
        };
        let _ = Registry::new()
            .implement("runtime.health", handler)
            .implement("runtime.health", handler);
    }
}
