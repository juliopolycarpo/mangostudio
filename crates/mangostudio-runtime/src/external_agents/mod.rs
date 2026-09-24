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
//!   types become wire types, with [`map_events`] for turn events and
//!   interactions.
//! - [`supervisor`] owns the sessions; [`service`] registers the methods.

pub(crate) mod isolation;
pub(crate) mod launcher;
pub(crate) mod map;
pub(crate) mod map_events;
pub(crate) mod service;
pub(crate) mod supervisor;
pub(crate) mod wire;

/// Whether the hub said, in its hello, that it withdrew this connection's
/// external-agent isolation claim.
///
/// A second MangoStudio user is something only the hub can see, and it says
/// so after the runtime's own hello has gone out. Every per-call surface that
/// reports an attestation reads this and stays silent when it is set.
///
/// # Example
///
/// ```ignore
/// let withdrawn = hub_withdrew_isolation(&context.remote().capabilities);
/// ```
pub(crate) fn hub_withdrew_isolation(
    capabilities: &serde_json::Map<String, serde_json::Value>,
) -> bool {
    capabilities
        .get("externalAgentIsolation")
        .and_then(serde_json::Value::as_str)
        == Some("withdrawn")
}
