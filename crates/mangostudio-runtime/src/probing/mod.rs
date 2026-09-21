//! Environment probing: the pure logic, real host adapters, and
//! `locations` carve-out behind `probing.runtimes`,
//! `probing.version-managers` and `probing.agent-clis`.
//!
//! Three layers so far, each its own module:
//! - [`detection`] — the pure algorithms, a method-by-method Rust port of
//!   `apps/shared/src/environments/detection/`, behind small traits
//!   standing in for the filesystem/subprocess seams a real host adapter
//!   implements. No filesystem access and no subprocess spawn anywhere in
//!   this module.
//! - [`locations`] — the narrow, deliberately-scoped carve-out from
//!   `apps/shared/src/library/` that will back `probing.agent-clis`'s own
//!   `locations` array; see that module's own docs for exactly what was
//!   and was not ported.
//! - [`host`] — the real implementations of every trait [`detection`] and
//!   [`locations`] leave injected: PATH walks and filesystem checks over
//!   [`crate::blocking`], `--version`/`winget list` subprocess probes over
//!   [`crate::subprocess`], mirroring
//!   `apps/runtime/src/services/probing/host-env.ts`.
//!
//! Nothing here registers a [`crate::registry::Registry`] method yet — the
//! RPC layer built on top of these three is a following change.
pub mod detection;
pub mod host;
pub mod locations;
