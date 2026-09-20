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

pub mod panic;
