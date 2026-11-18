//! The set of methods this build actually implements.
//!
//! A bare [`Registry::new`] is empty; `crate::transport::build_host_with_restart`
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

use crate::abandoned_call::{AbandonAudit, AbandonedCall, CallParts};
use mango_protocol::contract::{Contract, ContractHandlers};
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
use crate::result_value::into_value;
use crate::serve::runtime_contract;

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
/// use mangostudio_runtime_core::registry::{Classification, Registry};
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
    /// The contract every handler's result is checked against:
    /// [`runtime_contract`], except in a test that needs a contract whose
    /// schemas are broken ([`Registry::with_contract`]).
    contract: &'static Contract,
}

/// Releases a request claim when its future is aborted before the normal
/// settlement path. A transferred effect ignores this release until its own
/// owner drops `EffectClaim` after the machine work has ended.
struct RequestClaim {
    exclusivity: Arc<dyn CallExclusivity>,
    call_id: String,
}

impl Drop for RequestClaim {
    fn drop(&mut self) {
        self.exclusivity.end(&self.call_id);
    }
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
            contract: runtime_contract(),
        }
    }

    /// Checks results against `contract` instead of [`runtime_contract`].
    /// For a test of what a handler's wrapper does when the contract's own
    /// schema is broken, which the embedded catalog never is.
    #[cfg(test)]
    #[must_use]
    pub(crate) fn with_contract(mut self, contract: &'static Contract) -> Self {
        self.contract = contract;
        self
    }

    /// Registers `handler` for `method`, wrapped so that, in order: a panic
    /// anywhere in `handler`'s own future becomes a bounded, redacted
    /// `INTERNAL` error (see [`crate::panic`]); a successful result is
    /// checked against the contract's schema before this registry records
    /// anything (see below); and the outcome — `Ok`,
    /// `Error`, or the panic case — is recorded through this registry's
    /// [`Audit`] port only once all of that has already happened. This
    /// mirrors `apps/runtime/src/consent-gate.ts`'s `gateHandlers` composed
    /// with `checkResults`: the audit line reflects whether the *checked*
    /// result was valid, never the handler's raw, unchecked return value.
    ///
    /// The result check is [`mango_protocol::contract::Contract::check_result`]
    /// on [`crate::serve::runtime_contract`], the one compiled copy of each
    /// `result` schema. It runs here, in every build, and not through
    /// `ServeOptions::validate_results`: that option runs after the handler
    /// settles, by which time the audit port would already have recorded
    /// `Ok` for a result the schema refuses. `check_result` also masks the
    /// checked value in its `reason`, because a result can hold a file's
    /// contents or a command's output that an `INTERNAL` message must not
    /// echo. The TypeScript runtime turned its check off in production; this
    /// crate never does, since a Rust peer is exactly the other language
    /// the contract exists to keep honest.
    ///
    /// The contract compiles a `result` schema on the first call that needs
    /// it, so this wrapper resolves it
    /// ([`mango_protocol::contract::Contract::ensure_result_schema`]) before
    /// it decodes `P` or runs the handler. A schema that does not compile
    /// answers `INTERNAL` with the handler never having run, never after its
    /// effects.
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
    /// use mangostudio_runtime_core::registry::Registry;
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
    pub fn implement<P, R, F, Fut>(self, method_name: impl Into<String>, handler: F) -> Self
    where
        P: DeserializeOwned + Send + 'static,
        R: Serialize + Send + 'static,
        F: Fn(P, CallContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<R, RemoteError>> + Send + 'static,
    {
        self.implement_with(method_name, AbandonAudit::Record, handler)
    }

    /// [`Registry::implement`] for a handler that already audits its own
    /// abandoned calls — `install.run`, whose detached owner task records the
    /// run once no request is left to answer.
    ///
    /// ```ignore
    /// registry.implement_owning_abandon_audit("install.run", handler)
    /// ```
    #[must_use]
    pub fn implement_owning_abandon_audit<P, R, F, Fut>(
        self,
        method_name: impl Into<String>,
        handler: F,
    ) -> Self
    where
        P: DeserializeOwned + Send + 'static,
        R: Serialize + Send + 'static,
        F: Fn(P, CallContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<R, RemoteError>> + Send + 'static,
    {
        self.implement_with(method_name, AbandonAudit::OwnedByHandler, handler)
    }

    fn implement_with<P, R, F, Fut>(
        mut self,
        method_name: impl Into<String>,
        abandon: AbandonAudit,
        handler: F,
    ) -> Self
    where
        P: DeserializeOwned + Send + 'static,
        R: Serialize + Send + 'static,
        F: Fn(P, CallContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<R, RemoteError>> + Send + 'static,
    {
        let method_name = method_name.into();
        assert!(
            method(&method_name).is_some(),
            "\"{method_name}\" is not declared by the embedded catalog; a registry may only \
             implement a method its own contract knows about"
        );
        assert!(
            !self
                .implemented
                .iter()
                .any(|implemented| implemented == crate::discovery::DISCOVER_METHOD),
            "\"{method_name}\" was registered after runtime.discover, whose answer is fixed when \
             it is registered; register runtime.discover last"
        );
        assert!(
            !self
                .implemented
                .iter()
                .any(|implemented| implemented == &method_name),
            "\"{method_name}\" is already implemented; Session::handle's own HashMap::insert \
             would silently shadow the first handler, and implemented_methods() would report \
             the name twice"
        );
        let handler = Arc::new(handler);
        let audit = Arc::clone(&self.audit);
        let clock = Arc::clone(&self.clock);
        let exclusivity = Arc::clone(&self.exclusivity);
        let contract = self.contract;

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
                let claim = RequestClaim {
                    exclusivity: Arc::clone(&exclusivity),
                    call_id: call_id.clone(),
                };
                async move {
                    let _claim = claim;
                    let started = clock.now();
                    // Settles the call if this future is dropped before it
                    // finishes — e.g. aborted after the session's handler
                    // grace. Disarmed below, once this path takes over.
                    let abandoned = AbandonedCall::arm(CallParts {
                        method: method_name.clone(),
                        started,
                        audit: Arc::clone(&audit),
                        clock: Arc::clone(&clock),
                        policy: abandon,
                    });
                    // Parameter decoding, the handler, its serialisation,
                    // and the result check are inside this catch: a panic
                    // here becomes the wire result. Recording is
                    // deliberately outside it — see the two audit-parity
                    // notes below.
                    let recorded: Result<Value, RemoteError> = catch_panics({
                        let method_name = method_name.clone();
                        async move {
                            // The contract compiles a method's `result` schema
                            // on first use. Resolved before the handler runs,
                            // not at the check below: a handler with side
                            // effects must not run for a call that can only
                            // end in `INTERNAL`, or its caller cannot tell
                            // whether the effect happened. Inside this
                            // block, so the audit line and the claim release
                            // below still see the failure.
                            contract.ensure_result_schema(&method_name)?;
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
                                Ok(result) => match into_value(result) {
                                    // The contract's compiled `result` schema,
                                    // checked here rather than through
                                    // `ServeOptions::validate_results` so the audit
                                    // line records a failed check.
                                    Ok(value) => contract
                                        .check_result(&method_name, &value)
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
                    abandoned.disarm();

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

    /// A handler that counts how often it ran. Clones share the one count.
    #[derive(Clone, Default)]
    struct HandlerCalls(std::sync::Arc<std::sync::atomic::AtomicUsize>);

    impl HandlerCalls {
        fn record(&self) {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }

        fn count(&self) -> usize {
            self.0.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    /// The embedded catalog with `runtime.health`'s `result` schema replaced
    /// by one that is not valid JSON Schema, as a lazy contract. Leaked: a
    /// registry holds its contract for `'static`.
    fn contract_with_a_broken_health_result_schema() -> &'static mango_protocol::contract::Contract
    {
        let mut broken = mangostudio_runtime_contract::catalog::catalog().clone();
        let health = broken
            .methods
            .iter_mut()
            .find(|declared| declared.name == "runtime.health")
            .expect("the embedded catalog declares runtime.health");
        health.result = json!({ "type": "not-a-type" });
        Box::leak(Box::new(
            mango_protocol::contract::Contract::from_shared_catalog_lazy(std::sync::Arc::new(
                broken,
            ))
            .expect("names are valid and no schema is compiled yet"),
        ))
    }

    /// A registered handler whose method has a `result` schema that does not
    /// compile is not run: the call answers `INTERNAL` naming the method and
    /// the field, because a handler with side effects that ran first would
    /// leave its caller unable to tell whether the effect happened.
    #[tokio::test]
    async fn a_handler_does_not_run_when_its_result_schema_does_not_compile() {
        use mango_protocol::frame::PeerInfo;
        use mango_protocol::port::port_pair;
        use mango_protocol::session::{Session, SessionOptions};

        let peer = |role: &str| PeerInfo {
            name: format!("registry-test-{role}"),
            version: "0.0.0".into(),
            role: role.into(),
        };
        let contract = contract_with_a_broken_health_result_schema();
        let calls = HandlerCalls::default();
        let seen = calls.clone();
        let registry = Registry::new().with_contract(contract).implement(
            "runtime.health",
            move |_params: Value, _context| {
                seen.record();
                async move { Ok::<_, mango_protocol::RemoteError>(health_result()) }
            },
        );

        let (hub_port, runtime_port) = port_pair();
        let (hub, _hub_driver) = Session::spawn(hub_port, SessionOptions::new(peer("hub")));
        let (runtime, _runtime_driver) =
            Session::spawn(runtime_port, SessionOptions::new(peer("runtime")));
        hub.ready().await.expect("the hub side handshakes");
        runtime.ready().await.expect("the runtime side handshakes");
        crate::serve::serve(
            contract,
            &runtime,
            registry,
            std::sync::Arc::new(crate::ports::authorization::DenyingAuthorization),
            "host",
        )
        .expect("runtime.health is declared")
        .persist();

        let error = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            hub.request("runtime.health", json!({})),
        )
        .await
        .expect("expected an answer within 10 s | received: none")
        .expect_err("the result schema does not compile");
        let details = error.details.as_ref();
        assert_eq!(
            (
                error.code.as_str(),
                details.and_then(|d| d.get("method")),
                details.and_then(|d| d.get("field")),
                calls.count()
            ),
            (
                "INTERNAL",
                Some(&json!("runtime.health")),
                Some(&json!(format!(
                    "catalog.methods[{}].result",
                    contract
                        .catalog()
                        .methods
                        .iter()
                        .position(|declared| declared.name == "runtime.health")
                        .expect("declared")
                ))),
                0
            ),
            "expected (code, method, field, handler runs) = INTERNAL for runtime.health, 0 runs | received error {error:?} and {} run(s)",
            calls.count()
        );
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
