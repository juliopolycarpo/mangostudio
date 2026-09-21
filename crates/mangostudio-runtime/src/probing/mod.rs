//! Environment probing: `probing.runtimes`, `probing.version-managers` and
//! `probing.agent-clis`.
//!
//! Four layers, each its own module:
//! - [`detection`] — the pure algorithms, a method-by-method Rust port of
//!   `apps/shared/src/environments/detection/`, behind small traits
//!   standing in for the filesystem/subprocess seams a real host adapter
//!   implements. No filesystem access and no subprocess spawn anywhere in
//!   this module.
//! - [`locations`] — the narrow, deliberately-scoped carve-out from
//!   `apps/shared/src/library/` that backs `probing.agent-clis`'s own
//!   `locations` array; see that module's own docs for exactly what was
//!   and was not ported.
//! - [`host`] — the real implementations of every trait [`detection`] and
//!   [`locations`] leave injected: PATH walks and filesystem checks over
//!   [`crate::blocking`], `--version`/`winget list` subprocess probes over
//!   [`crate::subprocess`], mirroring
//!   `apps/runtime/src/services/probing/host-env.ts`.
//! - [`methods`] — the three RPC handlers built on top of the other three,
//!   mirroring `apps/runtime/src/services/probing/service.ts`. This
//!   module's own `register` function is what the transport layer's own
//!   `build_host` calls.
pub mod detection;
pub mod host;
pub mod locations;
pub mod methods;

/// Registers `probing.runtimes`, `probing.version-managers`, and
/// `probing.agent-clis` on `registry`. A one-line indirection so
/// [`crate::transport::build_host`] reads `crate::probing::register(...)`
/// rather than reaching into this module's `methods` submodule directly —
/// the same shallow-facade shape [`crate::health::register`] and
/// [`crate::workspace_methods::register`] already give their own callers.
pub(crate) fn register(registry: crate::registry::Registry) -> crate::registry::Registry {
    methods::register(registry)
}
