//! Runtime, version-manager and agent-CLI detection: a pure port of
//! `apps/shared/src/environments/detection/`, one submodule per source
//! file over there (`agent_cli_definitions` mirrors
//! `agent-cli-definitions.ts`, and so on).
//!
//! # Why traits, not direct filesystem/subprocess calls
//!
//! Every detector over there takes its filesystem and subprocess access as
//! injected parameters specifically so the algorithm itself can be tested
//! without touching a real disk — this crate keeps that shape, as a Rust
//! trait per TypeScript "deps" interface: [`binary_scan::BinaryScanDeps`],
//! [`version_manager_support::ManagedVersionFileSystem`],
//! [`nvm::NvmFileSystem`], [`auth_signal::AuthSignalFs`]. A later change
//! implements each trait against real I/O; this one implements them against
//! named fakes, in this module's own tests.
//!
//! # Why `Arc<dyn Trait>`, not a borrowed reference
//!
//! [`binary_scan::scan_runtime`] probes its candidates with bounded
//! concurrency. The TypeScript original does this on a single-threaded
//! event loop, interleaving promises; Rust has no such loop to interleave
//! on, so bounded concurrency here means real concurrent tasks
//! (`tokio::task::JoinSet`), and a task spawned onto an executor must own
//! `'static` data. Every port trait in this module is therefore
//! `Send + Sync + 'static`, and callers hand it in behind an [`std::sync::Arc`]
//! — the same shape this crate's other ports
//! ([`crate::ports::authorization::Authorization`],
//! [`crate::ports::audit::Audit`]) already use.

use std::future::Future;
use std::pin::Pin;

/// A boxed, pinned, `Send` future — the same shape
/// [`crate::ports::authorization::Authorization`] and
/// [`mango_protocol::contract::Guard`] already return, spelled out once here
/// because every trait in this module needs it.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub mod agent_cli_definitions;
pub mod auth_signal;
pub mod binary_scan;
pub mod duplicate_analysis;
pub mod fnm;
pub mod lts_policy;
pub mod node_release_schedule;
pub mod nvm;
pub mod path_env;
pub mod runtime_definitions;
pub mod types;
pub mod version_manager_support;
pub mod winget_ownership;
