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
//!   implements. `transport::build_host` (crate-private) populates a
//!   production one from each implemented method family, including the nine
//!   `mcp.*` methods (see [`mcp`]).
//!   A bare [`registry::Registry::new`]
//!   stays empty, which is what its own tests and doctest fill with named
//!   fakes to prove the plumbing without a real filesystem or subprocess
//!   underneath. A method the catalog declares but this registry has not
//!   implemented is *not* registered at all, so
//!   `mango_protocol::session::dispatch`'s own no-handler branch answers it
//!   with `METHOD_UNSUPPORTED` — byte-identical to a method the catalog does
//!   not know at all. This crate never invents a second wire code for
//!   "known but unimplemented".
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
//!   `Clock`, `CallExclusivity`). Every default still refuses or does
//!   nothing, but three of the four now also have a real production
//!   adapter that `transport::build_host` (crate-private) wires into every
//!   real connection: [`consent`]'s [`consent::authorization::ConsentAuthorization`]
//!   for `Authorization`, [`audit::FileAudit`] for `Audit`, and
//!   `ports::clock::SystemClock` for `Clock`. `CallExclusivity` uses a
//!   slot-shared [`ports::exclusivity::UpdateExclusivityTracker`] so update
//!   calls cannot overlap ordinary machine effects across connections.
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
//! foundation of its Rust rewrite. Its on-disk half — the pieces that must
//! agree byte-for-byte with what `apps/runtime` reads and writes — owns
//! exactly four things, each mirroring one TypeScript module so the two
//! hosts agree on-disk without either side reading the other's language.
//! (The crate as a whole is considerably larger: 22 modules spanning
//! dispatch, consent, workspace, probing, subprocess handling and this
//! on-disk layer — the four below are only the part that has a
//! TypeScript-side byte format to match.)
//!
//! - [`config`] mirrors `apps/runtime/src/config.ts`: every environment
//!   variable that configures this host, parsed in one place. Machine
//!   probing reads the environment at the bounded detection site that owns
//!   the observation instead.
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

mod abandoned_call;
pub mod audit;
pub mod blocking;
pub mod cli;
pub mod commands;
pub mod config;
pub mod consent;
pub mod discovery;
pub mod event_check;
mod external_agents;
mod file_identity;
pub mod filesystem;
pub mod health;
mod install;
mod library;
pub mod manifest;
pub mod mcp;
pub mod panic;
pub mod ports;
mod probe_cache;
pub mod probing;
pub mod registry;
mod release;
pub mod result_check;
pub mod runtime_home;
pub mod serve;
pub mod setup;
pub mod slot_publish;
mod slot_update_lock;
pub mod subprocess;
pub mod supervisor;
pub mod terminal;
#[cfg(test)]
pub(crate) mod test_support;
pub mod transport;
mod update;
mod update_transfer;
pub mod workspace;
pub mod workspace_methods;
pub mod workspace_path;
