//! The MangoStudio hub/runtime dispatcher: `mangostudio-runtime-contract`'s
//! catalog, served over a `mango-protocol` session.
//!
//! This crate builds on `mango_protocol::contract::Contract`,
//! `ContractHandlers`, `Guard` and `ServeOptions` — it does not implement a
//! second dispatcher. What it adds on top:
//!
//! - [`registry`] — a registry of the methods this build actually
//!   implements. Empty in production for now (method implementations are a
//!   later change); tests fill it with named fakes to prove the plumbing.
//!   A method the catalog declares but this registry has not implemented is
//!   *not* registered at all, so `mango_protocol::session::dispatch`'s own
//!   no-handler branch answers it with `METHOD_UNSUPPORTED` — byte-identical
//!   to a method the catalog does not know at all. This crate never invents
//!   a second wire code for "known but unimplemented".
//! - [`result_check`] — validates a handler's result against the contract
//!   before it is serialised, from *inside* the audit-recording wrapper
//!   rather than via [`mango_protocol::contract::ServeOptions::validate_results`].
//!   See the module docs for why the placement matters and why this crate
//!   always runs the check, unlike the TypeScript runtime's
//!   production opt-out.
//! - [`mod@panic`] — catches a panic inside a guard's or a handler's own future
//!   before it can reach `mango_protocol`'s dispatcher, which would otherwise
//!   put the raw panic payload on the wire, verbatim and unredacted.
//! - [`ports`] — small, named, fail-closed seams (`Authorization`, `Audit`,
//!   `Clock`) that a later change implements for real. Every default refuses
//!   or does nothing; none of them ever grants or fabricates an outcome.
//! - [`manifest`] — builds the `hello.capabilities` manifest this runtime
//!   announces, gated on both consent (what the machine's owner granted) and
//!   implementation (what this registry actually serves).
//! - [`serve`] — wires a [`registry::Registry`] and a set of ports into one
//!   [`mango_protocol::contract::Contract::serve`] call.
//!
//! See `docs/architecture/runtime-dispatcher.md` for the full design: why
//! result validation runs inside the audit wrapper rather than through
//! `ServeOptions`, why this crate always validates (unlike the TypeScript
//! runtime's production opt-out), the panic-isolation mechanism, and how
//! `manifest::build_features` extends the TypeScript runtime's own
//! allow→features formula with an implementation gate.
//!
//! # Example
//!
//! ```
//! use mangostudio_runtime::registry::Registry;
//!
//! let registry = Registry::new();
//! assert!(registry.implemented_methods().is_empty());
//! assert!(!registry.unimplemented_methods().is_empty());
//! ```

pub mod manifest;
pub mod panic;
pub mod ports;
pub mod registry;
pub mod result_check;
pub mod serve;
