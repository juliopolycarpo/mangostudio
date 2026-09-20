//! The MangoStudio hub/runtime contract, embedded in Rust.
//!
//! `apps/shared/src/runtime-contract/` is the single source of truth: a
//! TypeBox schema for every method, event, and document the hub and a
//! runtime exchange. This crate does not restate any of it. It embeds the six
//! artifacts `bun run contracts:emit` writes under
//! `apps/shared/src/runtime-contract/generated/` with [`include_str!`],
//! parses `catalog.json` into [`mango_protocol::Catalog`], compiles a
//! `jsonschema` validator for every shape it declares, and mirrors the
//! contract's non-schema constants (error kinds, the manifest's feature
//! flags, runtime-home file names) as typed Rust.
//!
//! See `docs/architecture/runtime-contract.md` for why there is no Rust code
//! generation, and how the conformance corpus in
//! [`buildCorpus`](https://github.com/juliopolycarpo/mangostudio/blob/main/scripts/runtime-contract/corpus.ts)
//! (checked into `generated/conformance-corpus.json`) proves this crate's
//! validators agree with TypeBox's, not merely that both read the same text.
//!
//! This crate is Tokio-free and carries no OS dependency: it is inventory and
//! validation only. `mangostudio-runtime` (a later crate) is the dispatcher
//! that serves the contract over a real transport.
//!
//! # Layout
//!
//! - [`catalog`] — the parsed catalog and lookups over it.
//! - [`schemas`] — compiled validators for every method, topic, and document.
//! - [`errors`] — the error code and `details.kind` vocabulary.
//! - [`manifest`] — the `hello.capabilities` manifest a runtime announces.
//! - [`strings`] — the contract's non-schema constants.
//!
//! # Example
//!
//! ```
//! use mangostudio_runtime_contract::catalog::{capabilities_of, catalog};
//! use mangostudio_runtime_contract::schemas::validate_params;
//! use serde_json::json;
//!
//! assert_eq!(catalog().name, "mangostudio.runtime");
//! assert_eq!(capabilities_of("shell.run"), Some(["shell".to_string()].as_slice()));
//! assert!(validate_params("runtime.health", &json!({})).is_ok());
//! ```

pub mod catalog;
pub mod errors;
pub mod manifest;
pub mod schemas;
pub mod strings;
