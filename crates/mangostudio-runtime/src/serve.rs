//! Wiring a [`crate::registry::Registry`] and an [`Authorization`] port into
//! one [`mango_protocol::contract::Contract::serve`] call.
//!
//! This is the only place this crate calls `Contract::serve`. It always
//! builds the same [`ServeOptions`]: `discover: true` (a peer that serves a
//! contract should say so — matching the TypeScript runtime, which never
//! opts out either), `validate_results: false` (this crate's own result
//! check runs inside [`crate::registry::Registry::implement`]'s wrapper
//! instead — see [`crate::result_check`] for why), and `guard` set to a
//! [`crate::ports::authorization::AuthorizationGuard`] built from
//! `authorization` and the registry's own [`Audit`]/[`crate::ports::clock::Clock`] ports.

use std::sync::Arc;

use mango_protocol::contract::{Contract, ServeGuard, ServeOptions};
use mango_protocol::session::Session;
use mango_protocol::validate::ValidationError;

use crate::ports::audit::Audit;
use crate::ports::authorization::{Authorization, AuthorizationGuard};
use crate::registry::Registry;

/// Registers `registry`'s handlers on `session` under `contract`, gated by
/// an [`AuthorizationGuard`] built from `authorization` and `slot`.
///
/// # Errors
/// [`ValidationError`] when `registry` implements a method `contract` does
/// not declare — unreachable in practice, since
/// [`crate::registry::Registry::implement`] already panics on that mismatch
/// at registration time, before `serve` is ever called.
///
/// # Example
///
/// ```
/// use std::sync::Arc;
///
/// use mango_protocol::contract::Contract;
/// use mango_protocol::frame::PeerInfo;
/// use mango_protocol::port::port_pair;
/// use mango_protocol::session::{Session, SessionOptions};
/// use mangostudio_runtime::ports::authorization::DenyingAuthorization;
/// use mangostudio_runtime::registry::Registry;
/// use mangostudio_runtime_contract::catalog::catalog;
///
/// # #[tokio::main(flavor = "current_thread")]
/// # async fn main() {
/// let contract = Contract::from_catalog(catalog().clone()).expect("the embedded catalog compiles");
/// let (port, _unused) = port_pair();
/// let peer = PeerInfo { name: "runtime".into(), version: "0.0.0".into(), role: "runtime".into() };
/// let (session, _driver) = Session::open(port, SessionOptions::new(peer));
///
/// let guard = mangostudio_runtime::serve::serve(
///     &contract,
///     &session,
///     Registry::new(),
///     Arc::new(DenyingAuthorization),
///     "host",
/// )
/// .expect("Registry::implement already panics on a catalog mismatch at registration time");
/// guard.persist();
/// # }
/// ```
pub fn serve(
    contract: &Contract,
    session: &Session,
    registry: Registry,
    authorization: Arc<dyn Authorization>,
    slot: impl Into<String>,
) -> Result<ServeGuard, ValidationError> {
    let audit: Arc<dyn Audit> = registry.audit();
    let clock = registry.clock();
    let exclusivity = registry.exclusivity();
    let guard = AuthorizationGuard::new(authorization, exclusivity, audit, clock, slot);
    let options = ServeOptions {
        guard: Some(Arc::new(guard)),
        validate_results: false,
        discover: true,
    };
    contract.serve(session, registry.into_contract_handlers(), options)
}
