//! External-agent hosting: the `external-agent.*` methods over the published
//! `mango-external-agents` SDK.
//!
//! The SDK owns vendor protocols, harness lifecycle and the normalised types.
//! This module owns what the SDK deliberately leaves to a host: the machine
//! and session resources behind an authorised launch, the private scratch a
//! child can see, consent and isolation cleanup, aggregate budgets, and the
//! one mapping between SDK types and the product wire.
//!
//! - [`isolation`] proves whose vendor credentials this process would use.
//! - [`launcher`] adapts the runtime's process supervision to the SDK's
//!   `ProcessLauncher` port.
//! - [`wire`] is the product wire as typed Rust; [`map`] is the one place SDK
//!   types become wire types.

// Scaffolding while the host is assembled commit by commit; removed by the
// commit that registers the methods, so nothing in the finished module is dead.
#![allow(dead_code)]

pub(crate) mod isolation;
pub(crate) mod launcher;
pub(crate) mod map;
pub(crate) mod service;
pub(crate) mod supervisor;
pub(crate) mod wire;
