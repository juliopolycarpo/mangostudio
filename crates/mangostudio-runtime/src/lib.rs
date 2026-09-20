//! The MangoStudio hub/runtime dispatcher: `mangostudio-runtime-contract`'s
//! catalog, served over a `mango-protocol` session.
//!
//! This crate builds on `mango_protocol::contract::Contract`,
//! `ContractHandlers`, `Guard` and `ServeOptions` — it does not implement a
//! second dispatcher. See `docs/architecture/runtime-dispatcher.md` for the
//! full design once it lands; modules are added here one at a time as this
//! crate is built out.
//!
//! - [`mod@panic`] — catches a panic inside a guard's or a handler's own
//!   future before it can reach `mango_protocol`'s dispatcher, which would
//!   otherwise put the raw panic payload on the wire, verbatim and
//!   unredacted.
//! - [`result_check`] — validates a handler's result against the contract
//!   before it is serialised, from *inside* the audit-recording wrapper
//!   rather than via
//!   [`mango_protocol::contract::ServeOptions::validate_results`]. See the
//!   module docs for why the placement matters and why this crate always
//!   runs the check, unlike the TypeScript runtime's production opt-out.
//! - [`ports`] — small, named, fail-closed seams (`Authorization`, `Audit`,
//!   `Clock`) that a later change implements for real. Every default
//!   refuses or does nothing; none of them ever grants or fabricates an
//!   outcome.

pub mod panic;
pub mod ports;
pub mod result_check;
