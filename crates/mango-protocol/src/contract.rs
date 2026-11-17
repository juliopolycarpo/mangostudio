//! Defines and validates an application contract: a [`Catalog`] document
//! plus the compiled `jsonschema` validators that check every method's
//! parameters against it, so a session dispatching through one never
//! recompiles a schema per request.
//!
//! Declare one with [`Contract::builder`], or compile one a peer published
//! with [`Contract::from_catalog`]. [`Contract::serve`] registers typed
//! handlers on a [`crate::session::Session`]; [`Contract::client`] and
//! [`Contract::events`] call and publish through one.

use std::sync::{Arc, OnceLock};

use jsonschema::Validator;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::catalog::{Catalog, CatalogEvent, CatalogMethod};
use crate::error::{RemoteError, codes};
use crate::session::Session;
use crate::validate::{ValidationError, is_reserved_method_name};
use crate::version::ProtocolVersion;

mod client;
mod events;
mod params;
mod serve;

pub use client::ContractClient;
pub use events::{ContractEvents, EventOptions, TypedEvent, TypedEventStream};
pub use serve::{ContractHandlers, Guard, ServeGuard, ServeOptions};

/// A schema compiled at most once, at the first request that needs it or by
/// [`Contract::compile_all`]. The outcome is kept either way, so a schema
/// that does not compile is not retried on every request.
type CompiledSchema = OnceLock<Result<Validator, ValidationError>>;

/// One method's `params`/`result` validators, at the same index as its
/// declaration in the contract's catalog. The declaration stays in the
/// catalog: a copy here would hold every schema document a second time.
#[derive(Debug, Default)]
struct CompiledMethod {
    params: CompiledSchema,
    result: CompiledSchema,
}

/// What a [`Contract`] shares with every handler [`Contract::serve`]
/// registers on it, so a validator compiled by one request is the one every
/// later request, on any handler, uses.
#[derive(Debug)]
struct ContractCore {
    /// Shared, so a host that keeps its own parsed catalog (a process-wide
    /// static, say) hands the contract that one copy
    /// ([`Contract::from_shared_catalog`]) instead of a second.
    catalog: Arc<Catalog>,
    /// `methods[i]` holds the validators of `catalog.methods[i]`.
    methods: Vec<CompiledMethod>,
}

impl ContractCore {
    /// The `params` validator of `catalog.methods[index]`, compiled now when
    /// no request or [`Contract::compile_all`] has yet.
    fn params_validator(&self, index: usize) -> Result<&Validator, &ValidationError> {
        self.methods[index]
            .params
            .get_or_init(|| {
                params::compile(
                    &format!("catalog.methods[{index}].params"),
                    &self.catalog.methods[index].params,
                )
            })
            .as_ref()
    }

    /// The `result` validator of `catalog.methods[index]`; see
    /// [`ContractCore::params_validator`].
    fn result_validator(&self, index: usize) -> Result<&Validator, &ValidationError> {
        self.methods[index]
            .result
            .get_or_init(|| {
                params::compile(
                    &format!("catalog.methods[{index}].result"),
                    &self.catalog.methods[index].result,
                )
            })
            .as_ref()
    }
}

/// A validated, ready-to-serve application contract.
///
/// # Example
///
/// ```
/// use mango_protocol::catalog::CatalogMethod;
/// use mango_protocol::contract::Contract;
/// use serde_json::json;
///
/// let contract = Contract::builder("example", "1.0.0")
///     .method(CatalogMethod {
///         name: "text.echo".into(),
///         description: None,
///         params: json!({ "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] }),
///         result: json!({ "type": "object" }),
///         capabilities: vec![],
///         deprecated: false,
///     })
///     .build()
///     .expect("a valid contract");
/// assert_eq!(contract.catalog().methods[0].name, "text.echo");
/// ```
#[derive(Debug)]
pub struct Contract {
    core: Arc<ContractCore>,
}

impl Contract {
    /// Starts building a contract named `name` at `version`.
    #[must_use]
    pub fn builder(name: impl Into<String>, version: impl Into<String>) -> ContractBuilder {
        ContractBuilder {
            catalog: Catalog {
                name: name.into(),
                version: version.into(),
                description: None,
                protocol: None,
                methods: Vec::new(),
                events: Vec::new(),
                capabilities: None,
            },
        }
    }

    /// Compiles a contract from a catalog document — one a peer published,
    /// or one read back from storage — checking and compiling it exactly as
    /// [`ContractBuilder::build`] does. The deserialise-then-compile
    /// counterpart to the builder's declare-then-compile path.
    ///
    /// # Errors
    /// Returns [`ValidationError`] for the same reasons
    /// [`ContractBuilder::build`] does.
    ///
    /// # Example
    ///
    /// Reads back `spec/fixtures/1/catalog-example.json`, the same document
    /// `packages/protocol/tests/contract.test.ts` reads on the TypeScript
    /// side, so both SDKs agree on one real catalog.
    ///
    /// ```
    /// use mango_protocol::Catalog;
    /// use mango_protocol::contract::Contract;
    ///
    /// let text = include_str!(concat!(
    ///     env!("CARGO_MANIFEST_DIR"),
    ///     "/../../spec/fixtures/1/catalog-example.json"
    /// ));
    /// let catalog: Catalog = serde_json::from_str(text).expect("the fixture is a valid catalog");
    /// let contract = Contract::from_catalog(catalog).expect("the fixture compiles");
    /// assert_eq!(contract.catalog().name, "example.files");
    /// ```
    pub fn from_catalog(catalog: Catalog) -> Result<Self, ValidationError> {
        Self::from_shared_catalog(Arc::new(catalog))
    }

    /// [`Contract::from_catalog`] for a catalog the caller keeps using: the
    /// contract holds this `Arc` instead of a copy, so a process that parsed
    /// a large catalog once (a runtime's embedded one is about 2 MiB of JSON,
    /// 1.5 MiB parsed) holds one copy of it, not two.
    ///
    /// This is a second constructor, not a wider parameter, because
    /// `from_catalog` takes a concrete `Catalog`: that is what lets
    /// `let catalog = serde_json::from_str(text)?; Contract::from_catalog(catalog)`
    /// infer its type. Any `impl Into<Arc<Catalog>>` parameter would leave
    /// that call ambiguous.
    ///
    /// # Errors
    /// Returns [`ValidationError`] for the same reasons
    /// [`ContractBuilder::build`] does.
    ///
    /// # Example
    ///
    /// ```
    /// use std::sync::Arc;
    ///
    /// use mango_protocol::Catalog;
    /// use mango_protocol::contract::Contract;
    ///
    /// let text = include_str!(concat!(
    ///     env!("CARGO_MANIFEST_DIR"),
    ///     "/../../spec/fixtures/1/catalog-example.json"
    /// ));
    /// let catalog: Arc<Catalog> =
    ///     Arc::new(serde_json::from_str(text).expect("the fixture is a valid catalog"));
    /// let contract = Contract::from_shared_catalog(Arc::clone(&catalog)).expect("it compiles");
    /// assert_eq!(contract.catalog(), *catalog);
    /// ```
    pub fn from_shared_catalog(catalog: Arc<Catalog>) -> Result<Self, ValidationError> {
        let contract = Self::from_shared_catalog_lazy(catalog)?;
        contract.compile_all()?;
        Ok(contract)
    }

    /// [`Contract::from_shared_catalog`] without compiling the catalog's
    /// schemas: each method's `params` and `result` schema compiles the first
    /// time a request needs it, and event and capability schemas not at all.
    /// Names and the catalog's shape are still checked here.
    ///
    /// For a process that serves a large catalog and is asked for a small
    /// part of it. A runtime's embedded catalog holds 68 methods; a hub
    /// calls a fraction of them, and compiling every schema first costs
    /// about 8 ms and several MiB before the first request is answered.
    ///
    /// The price is where a malformed schema shows up. [`Contract::from_shared_catalog`]
    /// reports it here, at construction. This constructor cannot: the first
    /// request that reaches that schema is answered `INTERNAL`, with the
    /// method and the catalog field in its details (the caller sent nothing
    /// wrong, so never `INVALID_PARAMS`). A method's schema failure is
    /// reported before its handler runs, never after: [`Contract::serve`]
    /// resolves the `result` schema ahead of the handler when
    /// [`ServeOptions`] asks for `validate_results`, and a host that checks
    /// results itself calls [`Contract::ensure_result_schema`] first, so a
    /// handler with side effects does not run for a request that can only end
    /// in `INTERNAL`. Call [`Contract::compile_all`] in a
    /// test, or once at start where an early failure is worth the cost, so a
    /// broken catalog is caught before a request finds it. Until then,
    /// [`Contract::catalog`] and the `rpc.discover` answer publish the
    /// event and capability schemas, and any method's not yet used, unchecked.
    ///
    /// # Errors
    /// Returns [`ValidationError`] for the reasons [`ContractBuilder::build`]
    /// does, except an invalid JSON Schema document, which this does not
    /// look at.
    ///
    /// # Example
    ///
    /// ```
    /// use std::sync::Arc;
    ///
    /// use mango_protocol::Catalog;
    /// use mango_protocol::catalog::CatalogMethod;
    /// use mango_protocol::contract::Contract;
    /// use serde_json::json;
    ///
    /// let catalog = Arc::new(Catalog {
    ///     name: "example".into(),
    ///     version: "1.0.0".into(),
    ///     description: None,
    ///     protocol: None,
    ///     methods: vec![CatalogMethod {
    ///         name: "text.echo".into(),
    ///         description: None,
    ///         params: json!({ "type": "not-a-type" }),
    ///         result: json!({ "type": "object" }),
    ///         capabilities: vec![],
    ///         deprecated: false,
    ///     }],
    ///     events: vec![],
    ///     capabilities: None,
    /// });
    ///
    /// assert!(Contract::from_shared_catalog(Arc::clone(&catalog)).is_err());
    /// let contract = Contract::from_shared_catalog_lazy(catalog)
    ///     .expect("the names are valid and no schema is compiled yet");
    /// assert_eq!(
    ///     contract.compile_all().unwrap_err().field,
    ///     "catalog.methods[0].params"
    /// );
    /// ```
    pub fn from_shared_catalog_lazy(catalog: Arc<Catalog>) -> Result<Self, ValidationError> {
        compile(catalog)
    }

    /// Compiles every schema the catalog embeds that is not compiled yet:
    /// each method's `params` and `result`, each event's payload and the
    /// capability document. Compiled method validators are kept for later
    /// requests; the rest are checked and dropped. A cheap re-check on a
    /// contract that [`Contract::from_catalog`], [`Contract::from_shared_catalog`]
    /// or [`ContractBuilder::build`] already compiled.
    ///
    /// # Errors
    /// The first schema that is not a valid JSON Schema 2020-12 document, in
    /// catalog order (methods, then events, then capabilities), with the
    /// `field` the eager constructors report for it, such as
    /// `catalog.methods[3].result`.
    pub fn compile_all(&self) -> Result<(), ValidationError> {
        for index in 0..self.core.methods.len() {
            self.core.params_validator(index).map_err(Clone::clone)?;
            self.core.result_validator(index).map_err(Clone::clone)?;
        }
        // Event payloads and the capability document are compiled for their
        // validity alone, not kept: nothing validates an outbound event
        // against its payload schema yet, but `catalog()` publishes all of
        // them as checked documents, so a malformed one has to fail here
        // rather than reach a peer.
        for (index, event) in self.core.catalog.events.iter().enumerate() {
            params::compile(&format!("catalog.events[{index}].payload"), &event.payload)?;
        }
        if let Some(capabilities) = &self.core.catalog.capabilities {
            params::compile("catalog.capabilities", capabilities)?;
        }
        Ok(())
    }

    /// The catalog document backing this contract: every method's and
    /// event's declaration, plain JSON. Infallible — [`Contract::builder`]
    /// and [`Contract::from_catalog`] already proved it valid; this is a
    /// clone of that proof, not a fresh check.
    ///
    /// On a contract from [`Contract::from_shared_catalog_lazy`] that proof
    /// covers names and shape only, until [`Contract::compile_all`] has
    /// succeeded: the schemas this returns, and `rpc.discover` publishes, may
    /// not be valid JSON Schema.
    #[must_use]
    pub fn catalog(&self) -> Catalog {
        (*self.core.catalog).clone()
    }

    /// Validates `params` against `method`'s schema, then deserialises it.
    ///
    /// A schema violation fails with `INVALID_PARAMS`, naming `method`, the
    /// failing RFC 6901 pointer and jsonschema's own message. A schema pass
    /// followed by a deserialisation failure means the server's own Rust
    /// type has drifted from the schema it advertises — a developer bug, not
    /// a bad request — so that becomes `INTERNAL` instead, never
    /// `INVALID_PARAMS`: the wire-visible meaning of `INVALID_PARAMS` stays
    /// exactly what the schema says it is.
    ///
    /// # Errors
    /// `METHOD_UNSUPPORTED` when `method` is not part of this contract;
    /// `INVALID_PARAMS` or `INTERNAL` as above.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::catalog::CatalogMethod;
    /// use mango_protocol::contract::Contract;
    /// use serde::Deserialize;
    /// use serde_json::json;
    ///
    /// #[derive(Debug, Deserialize)]
    /// struct EchoParams {
    ///     text: String,
    /// }
    ///
    /// let contract = Contract::builder("example", "1.0.0")
    ///     .method(CatalogMethod {
    ///         name: "text.echo".into(),
    ///         description: None,
    ///         params: json!({ "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] }),
    ///         result: json!({ "type": "object" }),
    ///         capabilities: vec![],
    ///         deprecated: false,
    ///     })
    ///     .build()
    ///     .expect("a valid contract");
    ///
    /// let ok: EchoParams = contract.parse_params("text.echo", json!({ "text": "hi" })).expect("valid");
    /// assert_eq!(ok.text, "hi");
    /// assert_eq!(
    ///     contract.parse_params::<EchoParams>("text.echo", json!({})).unwrap_err().code,
    ///     "INVALID_PARAMS",
    /// );
    /// ```
    pub fn parse_params<P: DeserializeOwned>(
        &self,
        method: &str,
        params: Value,
    ) -> Result<P, RemoteError> {
        let index = self
            .method_index(method)
            .ok_or_else(|| unsupported(&self.core.catalog.name, method))?;
        let validator = self
            .core
            .params_validator(index)
            .map_err(|error| uncompiled(method, error))?;
        check_params(method, validator, &params)?;
        decode(method, params)
    }

    /// A typed request surface over `session`, scoped to this contract's
    /// methods. Requests are not locally checked against the contract before
    /// sending — the peer's own dispatch is the check, exactly as the
    /// TypeScript SDK's `ContractClient` relies purely on its compile-time
    /// method-name type, not a runtime one.
    ///
    /// # Example
    ///
    /// ```
    /// # #[tokio::main(flavor = "current_thread")]
    /// # async fn main() {
    /// use mango_protocol::catalog::CatalogMethod;
    /// use mango_protocol::contract::{Contract, ContractHandlers};
    /// use mango_protocol::frame::PeerInfo;
    /// use mango_protocol::port::port_pair;
    /// use mango_protocol::session::{Session, SessionOptions};
    /// use serde::{Deserialize, Serialize};
    /// use serde_json::json;
    ///
    /// #[derive(Deserialize)]
    /// struct EchoParams { text: String }
    /// #[derive(Serialize, Deserialize)]
    /// struct EchoResult { text: String }
    ///
    /// let contract = Contract::builder("example", "1.0.0")
    ///     .method(CatalogMethod {
    ///         name: "text.echo".into(),
    ///         description: None,
    ///         params: json!({ "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] }),
    ///         result: json!({ "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] }),
    ///         capabilities: vec![],
    ///         deprecated: false,
    ///     })
    ///     .build()
    ///     .expect("a valid contract");
    ///
    /// let (port_a, port_b) = port_pair();
    /// let peer = |role: &str| PeerInfo { name: "e".into(), version: "0.1.0".into(), role: role.into() };
    /// let (a, _driver_a) = Session::spawn(port_a, SessionOptions::new(peer("a")));
    /// let (b, _driver_b) = Session::spawn(port_b, SessionOptions::new(peer("b")));
    ///
    /// let handlers = ContractHandlers::new().on(
    ///     "text.echo",
    ///     |params: EchoParams, _context| async move {
    ///         Ok::<_, mango_protocol::RemoteError>(EchoResult { text: params.text })
    ///     },
    /// );
    /// contract
    ///     .serve(&b, handlers, Default::default())
    ///     .expect("methods match")
    ///     .persist();
    ///
    /// a.ready().await.expect("handshake succeeds");
    /// let result: EchoResult = contract
    ///     .client(&a)
    ///     .request("text.echo", json!({ "text": "hi" }))
    ///     .await
    ///     .expect("the round trip succeeds");
    /// assert_eq!(result.text, "hi");
    /// # }
    /// ```
    #[must_use]
    pub fn client<'s>(&self, session: &'s Session) -> ContractClient<'s> {
        ContractClient::new(session)
    }

    /// Typed event emission and subscription over `session`. Neither `emit`
    /// nor `subscribe` checks `topic` against this contract locally — same
    /// as [`Contract::client`], the peer's own dispatch is the check.
    ///
    /// # Example
    ///
    /// ```
    /// # #[tokio::main(flavor = "current_thread")]
    /// # async fn main() {
    /// use mango_protocol::catalog::CatalogEvent;
    /// use mango_protocol::contract::Contract;
    /// use mango_protocol::frame::PeerInfo;
    /// use mango_protocol::port::port_pair;
    /// use mango_protocol::session::{Session, SessionOptions};
    /// use serde::{Deserialize, Serialize};
    /// use serde_json::json;
    ///
    /// #[derive(Debug, Serialize, Deserialize)]
    /// struct Tick { at: u64 }
    ///
    /// let contract = Contract::builder("example", "1.0.0")
    ///     .event(CatalogEvent {
    ///         topic: "text.tick".into(),
    ///         description: None,
    ///         payload: json!({ "type": "object" }),
    ///         stream: false,
    ///     })
    ///     .build()
    ///     .expect("a valid contract");
    ///
    /// let (port_a, port_b) = port_pair();
    /// let peer = |role: &str| PeerInfo { name: "e".into(), version: "0.1.0".into(), role: role.into() };
    /// let (a, _driver_a) = Session::spawn(port_a, SessionOptions::new(peer("a")));
    /// let (b, _driver_b) = Session::spawn(port_b, SessionOptions::new(peer("b")));
    ///
    /// // Both sides must be ready before the first `emit`, or it silently
    /// // no-ops (`Ok(false)`) and `recv` below waits forever.
    /// a.ready().await.expect("a is ready");
    /// b.ready().await.expect("b is ready");
    ///
    /// let mut ticks = contract.events(&a).subscribe::<Tick>("text.tick");
    /// contract
    ///     .events(&b)
    ///     .emit("text.tick", Tick { at: 1 }, Default::default())
    ///     .expect("emits");
    /// let tick = ticks.recv().await.expect("the stream stays open").expect("decodes as Tick");
    /// assert_eq!(tick.payload.at, 1);
    /// # }
    /// ```
    #[must_use]
    pub fn events<'s>(&self, session: &'s Session) -> ContractEvents<'s> {
        ContractEvents::new(session)
    }

    /// Registers `handlers` on `session`: each is wrapped so a request first
    /// validates against the method's `params` schema, then runs
    /// `options.guard` (seeing the validated params and the method's declared
    /// capabilities — this is what lets a consent gate be a guard instead of
    /// wrapping every handler by hand), then the handler itself, then
    /// (only when `options.validate_results` asks for it) checks the result
    /// against the method's `result` schema.
    ///
    /// `handlers` may cover any subset of this contract's declared methods —
    /// an unregistered declared method falls through to the session's own
    /// `METHOD_UNSUPPORTED`, so a contract can be served incrementally.
    /// Naming a method this contract does not declare is the one thing that
    /// is refused outright.
    ///
    /// # Errors
    /// Returns [`ValidationError`] when `handlers` names a method this
    /// contract does not declare. Nothing is registered then.
    ///
    /// # Example
    ///
    /// See [`Contract::client`] for a full round trip through the typed
    /// client this registers against.
    ///
    /// ```
    /// use mango_protocol::catalog::CatalogMethod;
    /// use mango_protocol::contract::{Contract, ContractHandlers};
    /// use mango_protocol::frame::PeerInfo;
    /// use mango_protocol::port::port_pair;
    /// use mango_protocol::session::{Session, SessionOptions};
    /// use serde_json::{Value, json};
    ///
    /// let contract = Contract::builder("example", "1.0.0")
    ///     .method(CatalogMethod {
    ///         name: "text.echo".into(),
    ///         description: None,
    ///         params: json!({ "type": "object" }),
    ///         result: json!({ "type": "object" }),
    ///         capabilities: vec![],
    ///         deprecated: false,
    ///     })
    ///     .build()
    ///     .expect("a valid contract");
    ///
    /// let (port_a, _port_b) = port_pair();
    /// let peer = PeerInfo { name: "e".into(), version: "0.1.0".into(), role: "runtime".into() };
    /// let (session, _driver) = Session::open(port_a, SessionOptions::new(peer));
    ///
    /// let handlers = ContractHandlers::new().on(
    ///     "text.echo",
    ///     |params: Value, _context| async move { Ok::<_, mango_protocol::RemoteError>(params) },
    /// );
    /// let guard = contract
    ///     .serve(&session, handlers, Default::default())
    ///     .expect("every handler names a declared method");
    /// guard.persist(); // keep the registration for the session's life
    /// ```
    pub fn serve(
        &self,
        session: &Session,
        handlers: ContractHandlers,
        options: ServeOptions,
    ) -> Result<ServeGuard, ValidationError> {
        serve::serve(self, session, handlers, options)
    }

    /// Checks a handler's `result` against `method`'s `result` schema with
    /// the validator this contract already compiled, for a server that must
    /// run the check inside its own handler wrapper (to audit the outcome,
    /// say) rather than after the handler settles, as
    /// [`ServeOptions::validate_results`] does.
    ///
    /// Unlike [`ServeOptions::validate_results`], whose reason quotes the
    /// offending value as jsonschema words it, the reason here never does: a
    /// result can hold data only the server has, and this is the check for a
    /// server that does not want that data in an `INTERNAL` message.
    ///
    /// # Errors
    /// `METHOD_UNSUPPORTED` when `method` is not part of this contract.
    /// `INTERNAL` when `result` violates the schema, as
    /// `Result of "{method}" does not match the contract at {path}: {reason}.`
    /// with `method`, `path` and `reason` details. `path` is an RFC 6901
    /// pointer (`/` for the document root) that names the missing or
    /// unexpected property itself for `required` and `additionalProperties`.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::catalog::CatalogMethod;
    /// use mango_protocol::contract::Contract;
    /// use serde_json::json;
    ///
    /// let contract = Contract::builder("example", "1.0.0")
    ///     .method(CatalogMethod {
    ///         name: "terminal.list".into(),
    ///         description: None,
    ///         params: json!({ "type": "object" }),
    ///         result: json!({
    ///             "type": "object",
    ///             "required": ["sessions"],
    ///             "properties": { "sessions": { "type": "array" } },
    ///         }),
    ///         capabilities: vec![],
    ///         deprecated: false,
    ///     })
    ///     .build()
    ///     .expect("a valid contract");
    ///
    /// assert!(contract.check_result("terminal.list", &json!({ "sessions": [] })).is_ok());
    /// let error = contract
    ///     .check_result("terminal.list", &json!({ "sessions": "SECRET" }))
    ///     .expect_err("sessions must be an array");
    /// assert_eq!(error.code, "INTERNAL");
    /// assert!(error.message.contains(" at /sessions: "));
    /// assert!(!error.message.contains("SECRET"));
    /// ```
    pub fn check_result(&self, method: &str, result: &Value) -> Result<(), RemoteError> {
        let index = self
            .method_index(method)
            .ok_or_else(|| unsupported(&self.core.catalog.name, method))?;
        let validator = self
            .core
            .result_validator(index)
            .map_err(|error| uncompiled(method, error))?;
        check_result(method, validator, result, ReasonStyle::Masked)
    }

    /// Compiles `method`'s `result` schema now, if nothing has yet, so a host
    /// that checks results itself ([`Contract::check_result`]) can find out
    /// that the schema is broken before it runs the handler. Otherwise a
    /// handler with side effects would run, and its caller would then get
    /// `INTERNAL` without knowing whether the effect happened. A no-op on a
    /// contract the eager constructors built, and after the first call.
    ///
    /// # Errors
    /// `METHOD_UNSUPPORTED` for a method the contract does not declare, as
    /// [`Contract::check_result`] answers; `INTERNAL` with `details.method`,
    /// `details.field` and `details.reason` when the schema does not compile.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::catalog::CatalogMethod;
    /// use mango_protocol::contract::Contract;
    /// use serde_json::json;
    ///
    /// let contract = Contract::builder("example", "1.0.0")
    ///     .method(CatalogMethod {
    ///         name: "text.echo".into(),
    ///         description: None,
    ///         params: json!({ "type": "object" }),
    ///         result: json!({ "type": "object" }),
    ///         capabilities: vec![],
    ///         deprecated: false,
    ///     })
    ///     .build()
    ///     .expect("a valid contract");
    /// contract.ensure_result_schema("text.echo").expect("the schema compiles");
    /// assert_eq!(
    ///     contract.ensure_result_schema("text.other").unwrap_err().code,
    ///     "METHOD_UNSUPPORTED"
    /// );
    /// ```
    pub fn ensure_result_schema(&self, method: &str) -> Result<(), RemoteError> {
        let index = self
            .method_index(method)
            .ok_or_else(|| unsupported(&self.core.catalog.name, method))?;
        self.core
            .result_validator(index)
            .map(|_| ())
            .map_err(|error| uncompiled(method, error))
    }

    /// The position of `name` in the catalog's methods, which is also the
    /// position of its validators.
    fn method_index(&self, name: &str) -> Option<usize> {
        self.core
            .catalog
            .methods
            .iter()
            .position(|method| method.name == name)
    }
}

/// The answer for a method whose schema did not compile when a request
/// needed it ([`Contract::from_shared_catalog_lazy`]). The server's own
/// contract is broken and the caller sent nothing wrong, so `INTERNAL`, not
/// `INVALID_PARAMS`, naming the method and the catalog field that failed.
///
/// The compiler's own reason goes in `details.reason`, cut to
/// [`UNCOMPILED_REASON_LIMIT`] characters: it can quote the offending part of
/// the schema, and this answer goes to a peer.
fn uncompiled(method: &str, error: &ValidationError) -> RemoteError {
    RemoteError::new(
        codes::INTERNAL,
        format!(
            "The contract's schema for \"{method}\" does not compile at {}.",
            error.field
        ),
    )
    .with_detail("method", method.to_string())
    .with_detail("field", error.field.clone())
    .with_detail(
        "reason",
        error
            .received
            .chars()
            .take(UNCOMPILED_REASON_LIMIT)
            .collect::<String>(),
    )
}

/// How much of the schema compiler's message [`uncompiled`] passes on.
const UNCOMPILED_REASON_LIMIT: usize = 200;

/// The `INVALID_PARAMS`/`INTERNAL` split [`Contract::parse_params`] and
/// [`serve`]'s per-request wrapper both need: a schema violation is always
/// `INVALID_PARAMS` naming the pointer and reason; a schema pass that still
/// fails to decode is `INTERNAL`, since that is the server's own Rust type
/// drifting from the schema it advertises, not a bad request.
fn check_params(method: &str, validator: &Validator, params: &Value) -> Result<(), RemoteError> {
    if let Some((path, reason)) = params::first_violation(validator, params) {
        return Err(RemoteError::new(
            codes::INVALID_PARAMS,
            format!("Parameters of \"{method}\" do not match the contract at {path}: {reason}."),
        )
        .with_detail("method", method.to_string())
        .with_detail("path", path)
        .with_detail("reason", reason));
    }
    Ok(())
}

/// How a result violation's `reason` words the offending value.
#[derive(Clone, Copy)]
enum ReasonStyle {
    /// jsonschema's own message, which quotes the value.
    Quoted,
    /// The value redacted ([`Contract::check_result`]).
    Masked,
}

/// Checks `result` against `method`'s `result` schema: [`ServeOptions`]'s
/// `validate_results` opt-in (run after the handler settles, quoting the
/// value) and [`Contract::check_result`] (masking it).
fn check_result(
    method: &str,
    validator: &Validator,
    result: &Value,
    style: ReasonStyle,
) -> Result<(), RemoteError> {
    let violation = match style {
        ReasonStyle::Quoted => params::first_violation(validator, result),
        ReasonStyle::Masked => params::first_violation_masked(validator, result),
    };
    if let Some((path, reason)) = violation {
        return Err(RemoteError::new(
            codes::INTERNAL,
            format!("Result of \"{method}\" does not match the contract at {path}: {reason}."),
        )
        .with_detail("method", method.to_string())
        .with_detail("path", path)
        .with_detail("reason", reason));
    }
    Ok(())
}

/// Deserialises parameters already known to have passed their schema; a
/// failure here is `INTERNAL` (see [`check_params`]), never the schema's own
/// code — this is the server's own Rust type drifting from the schema it
/// advertises, not a bad request.
fn decode<P: DeserializeOwned>(method: &str, value: Value) -> Result<P, RemoteError> {
    serde_json::from_value(value).map_err(|error| {
        RemoteError::new(
            codes::INTERNAL,
            format!(
                "Parameters of \"{method}\" passed their schema but failed to decode into the \
                 handler's Rust type: {error}."
            ),
        )
        .with_detail("method", method.to_string())
    })
}

fn unsupported(contract: &str, method: &str) -> RemoteError {
    RemoteError::new(
        codes::METHOD_UNSUPPORTED,
        format!("Method \"{method}\" is not part of contract \"{contract}\"."),
    )
    .with_detail("method", method.to_string())
    .with_detail("contract", contract.to_string())
}

/// Accumulates a contract's declaration; [`ContractBuilder::build`] checks
/// its names and compiles its schemas.
pub struct ContractBuilder {
    catalog: Catalog,
}

impl ContractBuilder {
    /// Sets the contract's prose description.
    #[must_use]
    pub fn description(mut self, description: impl Into<String>) -> Self {
        self.catalog.description = Some(description.into());
        self
    }

    /// Sets the lowest wire version the contract needs.
    #[must_use]
    pub fn protocol(mut self, protocol: ProtocolVersion) -> Self {
        self.catalog.protocol = Some(protocol);
        self
    }

    /// Sets the JSON Schema of the `hello.capabilities` object this contract
    /// expects.
    #[must_use]
    pub fn capabilities(mut self, capabilities: Value) -> Self {
        self.catalog.capabilities = Some(capabilities);
        self
    }

    /// Declares one method.
    #[must_use]
    pub fn method(mut self, method: CatalogMethod) -> Self {
        self.catalog.methods.push(method);
        self
    }

    /// Declares one event topic.
    #[must_use]
    pub fn event(mut self, event: CatalogEvent) -> Self {
        self.catalog.events.push(event);
        self
    }

    /// Checks every method's and event topic's name, then compiles every
    /// schema the catalog embeds.
    ///
    /// # Errors
    /// Returns [`ValidationError`] for an out-of-range `name`/`version`, an
    /// invalid or reserved method name or event topic, or a `params`,
    /// `result`, `payload` or `capabilities` document that is not an object
    /// holding valid JSON Schema 2020-12.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::contract::Contract;
    ///
    /// let error = Contract::builder("", "1").build().unwrap_err();
    /// assert_eq!(error.field, "catalog.name");
    /// ```
    pub fn build(self) -> Result<Contract, ValidationError> {
        Contract::from_catalog(self.catalog)
    }
}

/// Checks names — [`Catalog::validate`]'s grammar, length and
/// schema-document-shape rules, plus the reserved `rpc.` segment it does not
/// know about, since that is a contract-level rule, not a wire-schema one —
/// and wraps the catalog with room for each method's validators, compiling
/// none of them. [`ContractBuilder::build`], [`Contract::from_catalog`] and
/// [`Contract::from_shared_catalog`] follow it with [`Contract::compile_all`];
/// [`Contract::from_shared_catalog_lazy`] does not. One path for all four, so
/// declare-then-compile and deserialise-then-compile cannot drift apart.
fn compile(catalog: Arc<Catalog>) -> Result<Contract, ValidationError> {
    catalog.validate()?;
    for (index, method) in catalog.methods.iter().enumerate() {
        assert_not_reserved(&format!("catalog.methods[{index}].name"), &method.name)?;
    }
    for (index, event) in catalog.events.iter().enumerate() {
        assert_not_reserved(&format!("catalog.events[{index}].topic"), &event.topic)?;
    }
    let methods = catalog
        .methods
        .iter()
        .map(|_| CompiledMethod::default())
        .collect();
    Ok(Contract {
        core: Arc::new(ContractCore { catalog, methods }),
    })
}

fn assert_not_reserved(field: &str, name: &str) -> Result<(), ValidationError> {
    if !is_reserved_method_name(name) {
        return Ok(());
    }
    Err(ValidationError {
        field: field.to_string(),
        received: format!("{name:?}"),
        expected: "a name outside the reserved rpc. namespace".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::{Contract, UNCOMPILED_REASON_LIMIT, uncompiled};
    use crate::catalog::{CatalogEvent, CatalogMethod};
    use crate::validate::ValidationError;
    use serde::Deserialize;
    use serde_json::{Value, json};
    use std::sync::Arc;

    fn sample_method(name: &str, params: Value, result: Value) -> CatalogMethod {
        CatalogMethod {
            name: name.into(),
            description: None,
            params,
            result,
            capabilities: vec![],
            deprecated: false,
        }
    }

    fn example() -> Contract {
        Contract::builder("example", "1.2.3")
            .description("Test contract")
            .method(sample_method(
                "text.echo",
                json!({ "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] }),
                json!({ "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] }),
            ))
            .method(sample_method(
                "math.add",
                json!({
                    "type": "object",
                    "properties": { "a": { "type": "number" }, "b": { "type": "number" } },
                    "required": ["a", "b"],
                }),
                json!({ "type": "number" }),
            ))
            .event(CatalogEvent {
                topic: "text.tick".into(),
                description: None,
                payload: json!({ "type": "object" }),
                stream: false,
            })
            .build()
            .expect("a valid contract")
    }

    #[derive(Debug, Deserialize)]
    struct AddParams {
        a: f64,
        b: f64,
    }

    #[test]
    fn parse_params_narrows_or_refuses_with_invalid_params() {
        let contract = example();
        let ok: AddParams = contract
            .parse_params("math.add", json!({ "a": 1, "b": 2 }))
            .expect("valid params narrow");
        assert_eq!((ok.a, ok.b), (1.0, 2.0));

        let error = contract
            .parse_params::<AddParams>("math.add", json!({ "a": "one", "b": 2 }))
            .expect_err("a string is not a number");
        assert_eq!(error.code, "INVALID_PARAMS");
        assert_eq!(
            error.details.as_ref().and_then(|d| d.get("path")),
            Some(&json!("/a"))
        );
    }

    /// `from_shared_catalog` keeps the caller's `Arc`, so the contract adds no
    /// copy of the catalog, and method lookups read declarations from it.
    #[test]
    fn a_shared_catalog_is_held_not_copied() {
        let catalog = Arc::new(example().catalog());
        let contract = Contract::from_shared_catalog(Arc::clone(&catalog))
            .expect("the example catalog compiles");
        assert!(
            Arc::ptr_eq(&contract.core.catalog, &catalog),
            "expected the contract to hold the caller's catalog | received: a copy"
        );
        let ok: AddParams = contract
            .parse_params("math.add", json!({ "a": 1, "b": 2 }))
            .expect("math.add resolves through the shared catalog");
        assert_eq!((ok.a, ok.b), (1.0, 2.0));
    }

    /// The reason `from_catalog` keeps a concrete `Catalog` parameter: the
    /// catalog below is never annotated, and its type is inferred from the
    /// call. A generic parameter would turn this into a compile error.
    #[test]
    fn from_catalog_infers_the_type_of_an_unannotated_catalog() {
        let text = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../spec/fixtures/1/catalog-example.json"
        ));
        let catalog = serde_json::from_str(text).expect("the fixture is a valid catalog");
        let contract = Contract::from_catalog(catalog).expect("the fixture compiles");
        assert_eq!(contract.catalog().name, "example.files");
    }

    /// Serving with discover on gives the `rpc.discover` handler exactly one
    /// more share of the contract's catalog `Arc`, and unregistering gives it
    /// back. That bounds what the handler holds on to the catalog's own
    /// reference count; it does not by itself rule out a document cached
    /// beside the `Arc`, which this count cannot see.
    #[tokio::test]
    async fn the_discover_handler_holds_one_share_of_the_catalog_until_unregistered() {
        use crate::frame::PeerInfo;
        use crate::port::port_pair;
        use crate::session::{Session, SessionOptions};

        let contract = example();
        let (port, _unused) = port_pair();
        let peer = PeerInfo {
            name: "probe".into(),
            version: "0".into(),
            role: "runtime".into(),
        };
        let (session, _driver) = Session::spawn(port, SessionOptions::new(peer));
        let before = Arc::strong_count(&contract.core.catalog);

        let guard = contract
            .serve(&session, super::ContractHandlers::new(), Default::default())
            .expect("serving no handlers always succeeds");
        assert_eq!(
            Arc::strong_count(&contract.core.catalog),
            before + 1,
            "expected the discover handler to hold one share of the catalog | received strong count {} (was {before})",
            Arc::strong_count(&contract.core.catalog)
        );
        drop(guard);
        assert_eq!(
            Arc::strong_count(&contract.core.catalog),
            before,
            "expected unregistering to release the share"
        );
    }

    /// A contract's `catalog()` is published as a validated document, so every
    /// schema it embeds has to compile — not just the method ones. An event
    /// payload or a capability schema that only looks like JSON Schema would
    /// otherwise reach a peer as a supposedly checked document.
    #[test]
    fn every_embedded_schema_must_compile() {
        let malformed = json!({ "type": "not-a-type" });

        let error = Contract::builder("x", "1")
            .event(CatalogEvent {
                topic: "text.tick".into(),
                description: None,
                payload: malformed.clone(),
                stream: false,
            })
            .build()
            .expect_err("an event payload that is not a schema");
        assert_eq!(error.field, "catalog.events[0].payload");

        let error = Contract::builder("x", "1")
            .capabilities(malformed)
            .build()
            .expect_err("a capability document that is not a schema");
        assert_eq!(error.field, "catalog.capabilities");
    }

    /// Two methods whose schemas fail in different places, an event and a
    /// capability document that also fail: `math.add` has a malformed `result`,
    /// `text.echo` a malformed `params`.
    fn catalog_with_malformed_schemas() -> Arc<crate::Catalog> {
        let malformed = json!({ "type": "not-a-type" });
        Arc::new(crate::Catalog {
            name: "x".into(),
            version: "1".into(),
            description: None,
            protocol: None,
            methods: vec![
                sample_method(
                    "math.add",
                    json!({
                        "type": "object",
                        "properties": { "a": { "type": "number" }, "b": { "type": "number" } },
                        "required": ["a", "b"],
                    }),
                    malformed.clone(),
                ),
                sample_method("text.echo", malformed.clone(), json!({ "type": "object" })),
            ],
            events: vec![CatalogEvent {
                topic: "text.tick".into(),
                description: None,
                payload: malformed.clone(),
                stream: false,
            }],
            capabilities: Some(malformed),
        })
    }

    /// The lazy constructor accepts what the eager one refuses, and
    /// `compile_all` then reports exactly the error the eager constructor
    /// reports, so a test that calls it catches what a first request would
    /// otherwise find.
    #[test]
    fn compile_all_reports_what_the_eager_constructor_reports() {
        let catalog = catalog_with_malformed_schemas();
        let eager = Contract::from_shared_catalog(Arc::clone(&catalog))
            .expect_err("the eager constructor refuses");
        let lazy = Contract::from_shared_catalog_lazy(catalog)
            .expect("names are valid; no schema is compiled yet");
        let deferred = lazy.compile_all().expect_err("a schema is malformed");
        assert_eq!(deferred.field, "catalog.methods[0].result");
        assert_eq!(
            deferred, eager,
            "expected compile_all to report what from_shared_catalog reports"
        );
    }

    /// The order the eager constructors always reported in: methods (params
    /// then result), then events, then the capability document.
    #[test]
    fn compile_all_reports_methods_then_events_then_capabilities() {
        let mut catalog = (*catalog_with_malformed_schemas()).clone();
        catalog.methods.clear();
        let lazy =
            Contract::from_shared_catalog_lazy(Arc::new(catalog.clone())).expect("names are valid");
        assert_eq!(
            lazy.compile_all().unwrap_err().field,
            "catalog.events[0].payload"
        );

        catalog.events.clear();
        let lazy = Contract::from_shared_catalog_lazy(Arc::new(catalog)).expect("names are valid");
        assert_eq!(
            lazy.compile_all().unwrap_err().field,
            "catalog.capabilities"
        );
    }

    /// A lazy contract answers through a method whose own schemas compile,
    /// whatever its neighbours' schemas are.
    #[test]
    fn a_lazy_contract_serves_a_method_whose_schemas_compile() {
        let lazy = Contract::from_shared_catalog_lazy(catalog_with_malformed_schemas())
            .expect("names are valid");
        let ok: AddParams = lazy
            .parse_params("math.add", json!({ "a": 1, "b": 2 }))
            .expect("math.add's params schema compiles on first use");
        assert_eq!((ok.a, ok.b), (1.0, 2.0));
        let error = lazy
            .parse_params::<AddParams>("math.add", json!({ "a": "one", "b": 2 }))
            .expect_err("a string is not a number");
        assert_eq!(error.code, "INVALID_PARAMS");
    }

    /// A params schema that does not compile answers `INTERNAL` naming the
    /// method and the catalog field: the server's contract is broken, and the
    /// caller sent nothing wrong.
    #[test]
    fn parse_params_answers_internal_for_a_params_schema_that_does_not_compile() {
        let lazy = Contract::from_shared_catalog_lazy(catalog_with_malformed_schemas())
            .expect("names are valid");
        let error = lazy
            .parse_params::<Value>("text.echo", json!({}))
            .expect_err("text.echo's params schema does not compile");
        assert_eq!(error.code, "INTERNAL");
        let details = error.details.as_ref().expect("details");
        assert_eq!(details.get("method"), Some(&json!("text.echo")));
        assert_eq!(
            details.get("field"),
            Some(&json!("catalog.methods[1].params")),
            "expected the failing schema's field | received: {details:?}"
        );
    }

    /// The same for a result schema, through `check_result`.
    #[test]
    fn check_result_answers_internal_for_a_result_schema_that_does_not_compile() {
        let lazy = Contract::from_shared_catalog_lazy(catalog_with_malformed_schemas())
            .expect("names are valid");
        let error = lazy
            .check_result("math.add", &json!(3))
            .expect_err("math.add's result schema does not compile");
        assert_eq!(error.code, "INTERNAL");
        let details = error.details.as_ref().expect("details");
        assert_eq!(details.get("method"), Some(&json!("math.add")));
        assert_eq!(
            details.get("field"),
            Some(&json!("catalog.methods[0].result")),
            "expected the failing schema's field | received: {details:?}"
        );
    }

    /// `ensure_result_schema` finds a broken result schema without a result
    /// to check, so a host can do it before the handler runs.
    #[test]
    fn ensure_result_schema_reports_a_broken_schema_before_any_result_exists() {
        let lazy = Contract::from_shared_catalog_lazy(catalog_with_malformed_schemas())
            .expect("names are valid");
        let error = lazy
            .ensure_result_schema("math.add")
            .expect_err("math.add's result schema does not compile");
        assert_eq!(error.code, "INTERNAL");
        let details = error.details.as_ref().expect("details");
        assert_eq!(details.get("method"), Some(&json!("math.add")));
        assert_eq!(
            details.get("field"),
            Some(&json!("catalog.methods[0].result")),
            "expected the failing schema's field | received: {details:?}"
        );

        lazy.ensure_result_schema("text.echo")
            .expect("text.echo's result schema compiles");
        assert_eq!(
            lazy.ensure_result_schema("no.such").unwrap_err().code,
            "METHOD_UNSUPPORTED"
        );
    }

    /// A schema compiler's message can quote the schema, and the `INTERNAL`
    /// answer goes to a peer: the reason in its details is cut short and the
    /// message carries none of it.
    #[test]
    fn an_uncompiled_answer_bounds_the_compiler_reason() {
        let error = uncompiled(
            "text.echo",
            &ValidationError {
                field: "catalog.methods[0].params".into(),
                received: "x".repeat(UNCOMPILED_REASON_LIMIT * 5),
                expected: "a valid JSON Schema 2020-12 document".into(),
            },
        );
        let reason = error
            .details
            .as_ref()
            .and_then(|details| details.get("reason"))
            .and_then(Value::as_str)
            .expect("a reason detail");
        assert_eq!(
            reason.chars().count(),
            UNCOMPILED_REASON_LIMIT,
            "expected the reason cut to the limit | received {} characters",
            reason.chars().count()
        );
        assert!(
            !error.message.contains("xxx"),
            "expected the message to carry no compiler text | received: {}",
            error.message
        );
    }

    #[test]
    fn check_result_accepts_a_conforming_result() {
        example()
            .check_result("text.echo", &json!({ "text": "hi" }))
            .expect("a result that matches the schema");
    }

    /// The whole error shape, since a host's audit line and its peers read
    /// the code, the message and each detail.
    #[test]
    fn check_result_names_the_path_and_masks_the_value() {
        let secret = "CANARY-RESULT-5e1d";
        let error = example()
            .check_result("text.echo", &json!({ "text": 42, "extra": secret }))
            .expect_err("text must be a string");
        assert_eq!(error.code, "INTERNAL");
        assert_eq!(
            error.message,
            "Result of \"text.echo\" does not match the contract at /text: \
             value is not of type \"string\".",
            "expected a masked message at /text | received: {}",
            error.message,
        );
        let details = error.details.as_ref().expect("details");
        assert_eq!(details.get("method"), Some(&json!("text.echo")));
        assert_eq!(details.get("path"), Some(&json!("/text")));
        assert_eq!(
            details.get("reason"),
            Some(&json!("value is not of type \"string\"")),
        );
        assert!(!format!("{error:?}").contains(secret));
    }

    #[test]
    fn check_result_points_a_missing_property_at_the_property_itself() {
        let error = example()
            .check_result("text.echo", &json!({}))
            .expect_err("text is required");
        assert_eq!(
            error.details.as_ref().and_then(|d| d.get("path")),
            Some(&json!("/text"))
        );
    }

    #[test]
    fn check_result_points_a_root_violation_at_the_document_root() {
        let error = example()
            .check_result("math.add", &json!("not a number"))
            .expect_err("a string is not a number");
        assert_eq!(
            error.details.as_ref().and_then(|d| d.get("path")),
            Some(&json!("/"))
        );
    }

    fn contract_with_result_schema(schema: Value) -> Contract {
        Contract::builder("t", "1")
            .method(sample_method(
                "test.result",
                json!({ "type": "object" }),
                schema,
            ))
            .build()
            .expect("the test schema compiles")
    }

    /// Property names that need RFC 6901 escaping, each as the raw name and
    /// the token the pointer must carry.
    const POINTER_TOKENS: [(&str, &str); 5] = [
        ("a/b", "a~1b"),
        ("a~b", "a~0b"),
        ("a~/b", "a~0~1b"),
        ("a~1b", "a~01b"),
        ("", ""),
    ];

    /// `schema` and `result` as they are, and wrapped one array element deep
    /// under an `outer/~` property, with the pointer prefix the wrapper adds.
    fn at_root_and_nested(schema: Value, result: Value) -> [(Value, Value, &'static str); 2] {
        [
            (
                json!({ "properties": { "outer/~": { "type": "array", "items": schema.clone() } } }),
                json!({ "outer/~": [result.clone()] }),
                "/outer~1~0/0",
            ),
            (schema, result, ""),
        ]
    }

    #[test]
    fn check_result_escapes_a_missing_property_name_in_its_path() {
        for (property, token) in POINTER_TOKENS {
            let schema = json!({ "type": "object", "required": [property] });
            for (schema, result, prefix) in at_root_and_nested(schema, json!({})) {
                let error = contract_with_result_schema(schema)
                    .check_result("test.result", &result)
                    .expect_err("a required property is missing");
                let path = format!("{prefix}/{token}");
                assert_eq!(error.code, "INTERNAL", "{error:?}");
                assert_eq!(
                    error.details.as_ref().and_then(|d| d.get("path")),
                    Some(&json!(path)),
                    "expected path {path} for required property {property:?}"
                );
                assert!(
                    error.message.contains(&format!(" at {path}: ")),
                    "{error:?}"
                );
            }
        }
    }

    #[test]
    fn check_result_escapes_an_unexpected_property_name_in_its_path_and_masks_its_value() {
        let secret = "CANARY-SECRET-9f3a";
        for (property, token) in POINTER_TOKENS {
            let schema = json!({
                "type": "object",
                "properties": { "known": {} },
                "additionalProperties": false,
            });
            for (schema, result, prefix) in
                at_root_and_nested(schema, json!({ (property): secret }))
            {
                let error = contract_with_result_schema(schema)
                    .check_result("test.result", &result)
                    .expect_err("an unexpected property is present");
                let path = format!("{prefix}/{token}");
                assert_eq!(error.code, "INTERNAL", "{error:?}");
                assert_eq!(
                    error.details.as_ref().and_then(|d| d.get("path")),
                    Some(&json!(path)),
                    "expected path {path} for unexpected property {property:?}"
                );
                assert!(
                    error.message.contains(&format!(" at {path}: ")),
                    "{error:?}"
                );
                // The pointer must land on the offending value itself, so a
                // reader following it finds what the schema refused.
                assert_eq!(
                    result.pointer(&path),
                    Some(&json!(secret)),
                    "expected {path} to resolve to the unexpected property's value in {result}"
                );
                assert!(!format!("{error:?}").contains(secret), "{error:?}");
            }
        }
    }

    #[test]
    fn check_result_words_the_reason_for_each_keyword_the_runtime_reports() {
        let missing =
            contract_with_result_schema(json!({ "type": "object", "required": ["sessions"] }))
                .check_result("test.result", &json!({}))
                .expect_err("sessions is required");
        assert_eq!(
            missing.message,
            "Result of \"test.result\" does not match the contract at /sessions: \
             \"sessions\" is a required property."
        );

        let extra = contract_with_result_schema(json!({
            "type": "object",
            "properties": { "sessions": { "type": "array" } },
            "additionalProperties": false,
        }))
        .check_result("test.result", &json!({ "sessionCount": 3 }))
        .expect_err("sessionCount is not declared");
        assert_eq!(
            extra.message,
            "Result of \"test.result\" does not match the contract at /sessionCount: \
             Additional properties are not allowed ('sessionCount' was unexpected)."
        );
    }

    #[test]
    fn check_result_refuses_an_undeclared_method_with_method_unsupported() {
        let error = example()
            .check_result("math.multiply", &json!(1))
            .expect_err("not part of the contract");
        assert_eq!(error.code, "METHOD_UNSUPPORTED");
    }

    #[test]
    fn parse_params_refuses_an_undeclared_method_with_method_unsupported() {
        let error = example()
            .parse_params::<AddParams>("math.multiply", json!({}))
            .expect_err("not part of the contract");
        assert_eq!(error.code, "METHOD_UNSUPPORTED");
    }

    #[test]
    fn a_schema_pass_that_fails_to_decode_is_internal_not_invalid_params() {
        // The schema only requires an object; a caller's Rust type requires
        // a field the schema does not — exactly the drift `parse_params` is
        // meant to catch as the server's own bug, not the peer's bad request.
        #[derive(Debug, Deserialize)]
        struct StricterThanSchema {
            #[allow(dead_code)]
            required_by_rust_not_by_schema: String,
        }
        let contract = Contract::builder("x", "1")
            .method(sample_method("a.b", json!({ "type": "object" }), json!({})))
            .build()
            .expect("a valid contract");

        let error = contract
            .parse_params::<StricterThanSchema>("a.b", json!({}))
            .expect_err("the schema passes but decoding fails");
        assert_eq!(error.code, "INTERNAL");
    }
}
