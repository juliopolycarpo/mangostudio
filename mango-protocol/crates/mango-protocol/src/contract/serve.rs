//! Registers a contract's typed handlers on a session: the per-request
//! validate → guard → handler → (optional) result-check pipeline, and the
//! policy guard that runs between validation and the handler.

use std::future::Future;
use std::marker::PhantomData;
use std::pin::Pin;
use std::sync::Arc;

use jsonschema::Validator;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::error::{RemoteError, codes};
use crate::session::{CallContext, HandlerGuard, Session};
use crate::validate::{RPC_DISCOVER, ValidationError};

use super::{Contract, check_params, check_result, decode};

/// Answers one request already past its schema and guard checks; erases
/// the handler's own parameter and result types so [`ContractHandlers`] can
/// hold handlers for many methods in one collection.
trait ErasedHandler: Send + Sync + 'static {
    fn call(
        &self,
        method: &str,
        params: Value,
        context: CallContext,
    ) -> Pin<Box<dyn Future<Output = Result<Value, RemoteError>> + Send>>;
}

struct TypedHandler<P, R, F> {
    handler: F,
    _types: PhantomData<fn(P) -> R>,
}

impl<P, R, F, Fut> ErasedHandler for TypedHandler<P, R, F>
where
    P: DeserializeOwned + Send + 'static,
    R: Serialize + Send + 'static,
    F: Fn(P, CallContext) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<R, RemoteError>> + Send + 'static,
{
    fn call(
        &self,
        method: &str,
        params: Value,
        context: CallContext,
    ) -> Pin<Box<dyn Future<Output = Result<Value, RemoteError>> + Send>> {
        let method = method.to_string();
        match decode::<P>(&method, params) {
            Ok(params) => {
                // The handler's own future is built now, synchronously, so
                // nothing here borrows `self` across the `await` below.
                let future = (self.handler)(params, context);
                Box::pin(async move {
                    let result = future.await?;
                    serde_json::to_value(result).map_err(|error| {
                        RemoteError::new(
                            codes::INTERNAL,
                            format!("Result of \"{method}\" failed to serialise: {error}."),
                        )
                        .with_detail("method", method.clone())
                    })
                })
            }
            Err(error) => Box::pin(async move { Err(error) }),
        }
    }
}

/// Every handler a [`Contract::serve`] call registers, keyed by method name.
///
/// # Example
///
/// ```
/// use mango_protocol::contract::ContractHandlers;
/// use serde_json::Value;
///
/// let _handlers = ContractHandlers::new().on(
///     "text.echo",
///     |params: Value, _context| async move { Ok::<_, mango_protocol::error::RemoteError>(params) },
/// );
/// ```
#[derive(Default)]
pub struct ContractHandlers {
    handlers: Vec<(String, Arc<dyn ErasedHandler>)>,
}

impl ContractHandlers {
    /// An empty handler set; [`ContractHandlers::on`] adds to it.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a typed handler for `method`. `P`/`R` need not match the
    /// method's declared schema exactly — [`Contract::serve`] validates the
    /// wire value before `P` is ever decoded, and a decode failure after
    /// that point is `INTERNAL`, not a silent type coercion.
    #[must_use]
    pub fn on<P, R, F, Fut>(mut self, method: impl Into<String>, handler: F) -> Self
    where
        P: DeserializeOwned + Send + 'static,
        R: Serialize + Send + 'static,
        F: Fn(P, CallContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<R, RemoteError>> + Send + 'static,
    {
        self.handlers.push((
            method.into(),
            Arc::new(TypedHandler {
                handler,
                _types: PhantomData,
            }),
        ));
        self
    }
}

/// Runs between schema validation and the handler, seeing the already-
/// validated `params` and the method's declared `capabilities` — this is
/// what lets a consent gate be a guard instead of a wrapper around every
/// handler. Throw (return `Err`) a [`RemoteError`] (typically `DENIED`) to
/// refuse; the SDK adds no policy of its own, since consent, authorisation
/// and their audit belong to the application.
///
/// # Example
///
/// The `'a` bound on every argument (not just `&'a self`) is what lets the
/// returned future borrow `method`/`capabilities`/`context`, as here, instead
/// of cloning them first.
///
/// ```
/// use std::future::Future;
/// use std::pin::Pin;
///
/// use mango_protocol::contract::Guard;
/// use mango_protocol::error::codes;
/// use mango_protocol::session::CallContext;
/// use mango_protocol::RemoteError;
/// use serde_json::Value;
///
/// struct RequiresCapability;
///
/// impl Guard for RequiresCapability {
///     fn check<'a>(
///         &'a self,
///         method: &'a str,
///         _params: &'a Value,
///         capabilities: &'a [String],
///         _context: &'a CallContext,
///     ) -> Pin<Box<dyn Future<Output = Result<(), RemoteError>> + Send + 'a>> {
///         Box::pin(async move {
///             if capabilities.is_empty() {
///                 return Ok(());
///             }
///             Err(RemoteError::new(codes::DENIED, format!("{method} needs {capabilities:?}")))
///         })
///     }
/// }
/// ```
pub trait Guard: Send + Sync + 'static {
    /// Checks one request. `context` gives access to the in-flight count
    /// ([`CallContext::in_flight`]) and everything else a policy might need.
    fn check<'a>(
        &'a self,
        method: &'a str,
        params: &'a Value,
        capabilities: &'a [String],
        context: &'a CallContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), RemoteError>> + Send + 'a>>;
}

/// Tunes one [`Contract::serve`] call.
///
/// # Example
///
/// ```
/// use mango_protocol::contract::ServeOptions;
///
/// let options = ServeOptions { validate_results: true, ..Default::default() };
/// assert!(options.guard.is_none());
/// // Serving a catalog means answering rpc.discover; opt out, never in.
/// assert!(options.discover);
/// ```
pub struct ServeOptions {
    /// Runs after schema validation, before the handler.
    pub guard: Option<Arc<dyn Guard>>,
    /// Validates the handler's result against the method's `result` schema
    /// before it goes on the wire. Off by default, matching the TypeScript
    /// SDK; this is real drift protection in Rust (the schema is
    /// hand-authored `Value`, not derived from the handler's `R`).
    pub validate_results: bool,
    /// Answer `rpc.discover` with this contract's catalog. On by default: a
    /// peer that serves a contract SHOULD say so (§6.4). Set `false` where
    /// the catalog itself is privileged, and the method goes back to
    /// answering `METHOD_UNSUPPORTED`.
    pub discover: bool,
}

/// Written by hand rather than derived: `bool::default()` is `false`, and a
/// derived `Default` would silently make opting *in* to `rpc.discover` the
/// thing a caller has to remember.
impl Default for ServeOptions {
    fn default() -> Self {
        Self {
            guard: None,
            validate_results: false,
            discover: true,
        }
    }
}

/// Unregisters every handler [`Contract::serve`] registered when dropped,
/// unless [`ServeGuard::persist`] is called first.
#[must_use = "dropping the guard removes every handler the contract registered"]
pub struct ServeGuard {
    guards: Vec<HandlerGuard>,
}

impl ServeGuard {
    /// Keeps every registration for the session's life.
    pub fn persist(self) {
        for guard in self.guards {
            guard.persist();
        }
    }
}

/// Everything one method's request needs beyond the wire value itself,
/// bundled so the per-request closure and [`answer`] each take one argument
/// for it instead of five.
struct MethodPolicy {
    params_validator: Arc<Validator>,
    result_validator: Arc<Validator>,
    capabilities: Vec<String>,
    guard: Option<Arc<dyn Guard>>,
    validate_results: bool,
}

/// [`Contract::serve`]'s implementation, a free function so it can reach
/// `contract`'s private [`CompiledMethod`] fields without a public accessor
/// that would otherwise exist for this alone.
pub(super) fn serve(
    contract: &Contract,
    session: &Session,
    handlers: ContractHandlers,
    options: ServeOptions,
) -> Result<ServeGuard, ValidationError> {
    let mut guards = Vec::with_capacity(handlers.handlers.len() + 1);
    if options.discover {
        // Serialised once here, not per request: `rpc.discover` answers the
        // same document every time, and a catalog that cannot serialise must
        // fail this registration rather than every call to it — the same
        // "nothing left behind to unregister" rule the TypeScript SDK follows
        // by building its catalog before it registers any handler.
        let catalog = serde_json::to_value(&contract.catalog).map_err(|error| ValidationError {
            field: "catalog".to_string(),
            received: error.to_string(),
            expected: "a catalog that serialises to JSON".to_string(),
        })?;
        let catalog = Arc::new(catalog);
        guards.push(
            session.handle(RPC_DISCOVER, move |params: Value, _context| {
                let catalog = Arc::clone(&catalog);
                async move {
                    if !params.is_object() {
                        return Err(RemoteError::new(
                            codes::INVALID_PARAMS,
                            format!("Parameters of \"{RPC_DISCOVER}\" must be an object."),
                        )
                        .with_detail("method", RPC_DISCOVER.to_string()));
                    }
                    Ok((*catalog).clone())
                }
            }),
        );
    }
    for (method, erased) in handlers.handlers {
        let compiled = contract.method(&method).ok_or_else(|| ValidationError {
            field: "handlers".to_string(),
            received: method.clone(),
            expected: format!(
                "a method declared by contract \"{}\"",
                contract.catalog.name
            ),
        })?;
        let policy = Arc::new(MethodPolicy {
            params_validator: Arc::clone(&compiled.params),
            result_validator: Arc::clone(&compiled.result),
            capabilities: compiled.definition.capabilities.clone(),
            guard: options.guard.clone(),
            validate_results: options.validate_results,
        });
        let handler_guard = session.handle(
            method.clone(),
            move |params: Value, context: CallContext| {
                answer(
                    method.clone(),
                    params,
                    context,
                    Arc::clone(&erased),
                    Arc::clone(&policy),
                )
            },
        );
        guards.push(handler_guard);
    }
    Ok(ServeGuard { guards })
}

/// One request through the full pipeline: validate → guard → handler →
/// (optional) result check. A free `async fn`, not an inline block, so
/// [`serve`]'s closure stays readable.
async fn answer(
    method: String,
    params: Value,
    context: CallContext,
    erased: Arc<dyn ErasedHandler>,
    policy: Arc<MethodPolicy>,
) -> Result<Value, RemoteError> {
    check_params(&method, &policy.params_validator, &params)?;
    if let Some(guard) = &policy.guard {
        guard
            .check(&method, &params, &policy.capabilities, &context)
            .await?;
    }
    let result = erased.call(&method, params, context).await?;
    if policy.validate_results {
        check_result(&method, &policy.result_validator, &result)?;
    }
    Ok(result)
}
