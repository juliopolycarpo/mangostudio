//! Environment probing: the pure logic behind `probing.runtimes`,
//! `probing.version-managers` and `probing.agent-clis`.
//!
//! This module is a method-by-method Rust port of
//! `apps/shared/src/environments/detection/` — the TypeScript runtime's own
//! injected-dependency detection layer, ported the same way the rest of
//! this crate is: a pure core plus small traits standing in for the
//! filesystem/subprocess seams a real host adapter will implement.
//!
//! Nothing here registers a [`crate::registry::Registry`] method yet. This
//! is the first of two changes: it ports the algorithms and their trait
//! boundaries, with no filesystem access and no subprocess spawn anywhere
//! in the module. A second change implements those traits against a real
//! host (PATH walks, `--version` subprocess probes over
//! [`crate::subprocess`]/[`crate::blocking`]) and wires the three RPC
//! methods on top of what is built here.
pub mod detection;
