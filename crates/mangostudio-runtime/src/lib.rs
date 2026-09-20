//! The MangoStudio runtime host, Rust half: the contract dispatcher and
//! the runtime-home state it will run against.
//!
//! # Dispatch
//!
//! `mangostudio-runtime-contract`'s catalog, served over a `mango-protocol`
//! session.
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
//!   `Clock`, `CallExclusivity`) that a later change implements for real.
//!   Every default refuses or does nothing; none of them ever grants or
//!   fabricates an outcome.
//! - [`consent`] — the real [`ports::authorization::Authorization`]: what
//!   `runtime.json` grants, re-read on every call.
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
//!
//! # Runtime home
//!
//! `apps/runtime` is the TypeScript runtime host; this crate is the
//! foundation of its Rust rewrite. It owns exactly four things, each
//! mirroring one TypeScript module so the two hosts agree on-disk without
//! either side reading the other's language:
//!
//! - [`config`] mirrors `apps/runtime/src/config.ts`: every environment
//!   variable this host reads, parsed in one place.
//! - [`runtime_home`] mirrors `apps/runtime/src/runtime-home.ts` and
//!   `apps/shared/src/runtime-home/paths.ts`: the `~/.mango/runtime/<slot>`
//!   layout, slot resolution, and reading `runtime.json`/`credentials.json`
//!   as schema-checked bytes.
//! - [`runtime_home::lock`] reimplements the pid-file lock protocol from
//!   `runtime-home.ts` bit for bit — not an OS lock, which a Node process on
//!   the same machine cannot see or honour. See that module's docs for why.
//! - [`runtime_home::atomic`] and [`runtime_home::owner_only`] mirror the
//!   temp-file-then-rename publication in `runtime-home.ts` and the
//!   mode/ACL split in `apps/runtime/src/services/owner-only.ts`.
//!
//! Every shape read from or written to disk is validated against
//! `mangostudio_runtime_contract::schemas::validate_runtime_home` — this
//! crate hand-writes no duplicate of `runtime-home.schema.json`.
//!
//! # Consent
//!
//! [`consent`] is the resolution this crate's `runtime_home` module used to
//! leave to "a dispatcher's job, not this crate's": `RUNTIME_CONSENT_PRESETS`,
//! `profileForAllow`, and a real [`ports::authorization::Authorization`] that
//! reads `runtime.json`'s `allow` set fresh on every call. `runtime_home`
//! still owns the one piece of that policy it always needed —
//! [`runtime_home::DefaultSetupState`], which slots start pre-consented —
//! and [`consent`] builds the rest on top of it rather than duplicating it.

pub mod audit;
pub mod blocking;
pub mod cli;
pub mod config;
pub mod consent;
pub mod event_check;
pub mod health;
pub mod manifest;
pub mod panic;
pub mod ports;
pub mod registry;
pub mod result_check;
pub mod runtime_home;
pub mod serve;
pub mod setup;
pub mod subprocess;
pub mod supervisor;
pub mod transport;
pub mod workspace;
