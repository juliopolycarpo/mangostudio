//! What `runtime.json` grants, and the real [`crate::ports::authorization::Authorization`]
//! built on it.
//!
//! Mirrors `apps/runtime/src/consent-source.ts` and the consent half of
//! `apps/shared/src/runtime-home/consent.ts`:
//!
//! - [`presets`] — the `full`/`readonly`/`none` capability sets, and reading
//!   a stored `allow` back into a profile name.
//! - [`source`] — re-reads `runtime.json` on every call, never trusting a
//!   cached copy, and fails closed to `none` the moment the file stops
//!   being readable.
//! - [`authorization`] — the [`crate::ports::authorization::Authorization`]
//!   this crate registers for real, once a slot's consent is being served
//!   from disk rather than from a named fake.
//! - [`invocation`] — consent for `stdio`/`serve`/`connect`, the entry
//!   points a person or a hub starts directly rather than answering ahead of
//!   time with `setup`. Mirrors `runtime-home.ts`'s `consentByInvocation` and
//!   `cli.ts`'s `stdioConsent`.
//! - `read` — the bounded, tri-state consent read (granted, denied, or
//!   unknown) the live-resource watchers and launch checks share.
//! - `stop_only` — the methods that only end or detach something already running, which
//!   the guard lets through an inconclusive consent read.
//! - [`config`] — the fully-resolved, default-filled `runtime.json` shape
//!   `runtime.health` reports, mirroring `resolveRuntimeSlotConfig`.

pub mod authorization;
pub mod config;
pub mod invocation;
pub mod presets;
pub(crate) mod read;
pub mod source;
#[cfg(test)]
pub(crate) mod stall_gate;
pub(crate) mod stop_only;
