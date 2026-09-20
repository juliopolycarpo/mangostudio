//! What `runtime.json` grants, and the real [`crate::ports::authorization::Authorization`]
//! built on it.
//!
//! Mirrors `apps/runtime/src/consent-source.ts` and the consent half of
//! `apps/shared/src/runtime-home/consent.ts`:
//!
//! - [`presets`] — the `full`/`readonly`/`none` capability sets, and reading
//!   a stored `allow` back into a profile name.
//! - [`source`] — re-reads `runtime.json` on every call, only when its
//!   fingerprint has actually changed, and fails closed to `none` the
//!   moment the file stops being readable.
//! - [`authorization`] — the [`crate::ports::authorization::Authorization`]
//!   this crate registers for real, once a slot's consent is being served
//!   from disk rather than from a named fake.

pub mod authorization;
pub mod presets;
pub mod source;
