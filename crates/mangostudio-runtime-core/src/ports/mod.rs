//! Fail-closed ports: small, named seams a later change implements for real.
//!
//! None of these is a plugin framework — each is one trait with one job.
//! Every default in this module refuses or does nothing; none of them ever
//! grants a capability or fabricates a successful outcome on its own.
//!
//! - [`authorization`] — whether a request may proceed at all. Adapts *into*
//!   `mango_protocol::contract::Guard`, the SDK's own policy seam, rather
//!   than building a second gate in front of it.
//! - [`audit`] — records what happened, after the fact. Wraps *outside* the
//!   guard, so a denial and a handler's own outcome are both recorded, in
//!   the same order `apps/runtime/src/consent-gate.ts`'s `gateHandlers`
//!   records them.
//! - [`clock`] — when something happened, for an audit entry's duration.
//! - [`wall_clock`] — when something happened, as a calendar instant, for a
//!   `setup.state` record's `at` or an audit line's `ts`.
//! - [`exclusivity`] — whether a call may run at all right now, independent
//!   of capability consent, decided by what else is in flight.

pub mod audit;
pub mod authorization;
pub mod clock;
pub mod exclusivity;
pub mod wall_clock;
