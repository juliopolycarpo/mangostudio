//! Building the `features` map a runtime announces in `hello.capabilities`,
//! gated on both what the machine's owner granted *and* what this build
//! actually implements.
//!
//! `apps/runtime/src/manifest.ts` computes `features` from `allow` (what was
//! granted) intersected with a handful of environment facts (git's own
//! `--version` probe, which shells are on `PATH`) — it has no "is this
//! method implemented" gate at all, because every declared method already
//! has a real handler in that runtime. This crate adds exactly that gate:
//! [`build_features`] mirrors `manifest.ts`'s allow→features formula field
//! for field, then additionally requires every catalog method carrying the
//! corresponding capability to be [`Registry::classify`]'d as
//! [`Classification::Implemented`] — fail-closed, so a feature backed by
//! nine methods and implemented by three of them is not advertised at all.
//! With an empty [`Registry`], every capability-gated feature computes
//! `false` regardless of `allow`, which is this crate's whole acceptance
//! bar for this change: an empty registry must advertise essentially
//! nothing.
//!
//! `toolchain` is the one feature `manifest.ts` hardcodes to `true`
//! unconditionally, because it names a *shape* a spawn method's `params`
//! schema may declare, not a capability of its own. This module mirrors that
//! hardcode rather than inventing a gate nothing asked for: advertising it
//! grants nothing by itself, since no spawn method is callable until its own
//! capability is both granted and implemented.

use mangostudio_runtime_contract::catalog::catalog;
use mangostudio_runtime_contract::manifest::{RuntimeCapabilityAllow, RuntimeCapabilityFeatures};

use crate::registry::{Classification, Registry};

/// Whether every catalog method requiring `capability` is implemented.
///
/// `false` when the catalog carries no method for `capability` at all (a
/// capability nothing backs is never "ready"), and `false` as soon as one
/// required method is missing — a partially-implemented capability is not
/// advertised as available.
fn capability_ready(registry: &Registry, capability: &str) -> bool {
    let mut required = catalog()
        .methods
        .iter()
        .filter(|declared| declared.capabilities.iter().any(|c| c == capability))
        .peekable();
    required.peek().is_some()
        && required.all(|declared| registry.classify(&declared.name) == Classification::Implemented)
}

/// Builds the `features` map for `registry`, gated on `allow` and, for
/// `features.git`, on `git_available` (whether this host actually has a
/// usable `git` binary — probing for it is out of this crate's scope, so the
/// caller supplies the fact).
///
/// # Example
///
/// An empty registry advertises nothing, even under a fully-granted `allow`:
///
/// ```
/// use mangostudio_runtime::manifest::build_features;
/// use mangostudio_runtime::registry::Registry;
/// use mangostudio_runtime_contract::manifest::RuntimeCapabilityAllow;
///
/// let allow = RuntimeCapabilityAllow {
///     fs_read: true, fs_write: true, shell: true, git: true, probing: true,
///     mcp: true, library: true, checkpoints: true, update: true,
///     external_agents: Some(true),
/// };
/// let features = build_features(&Registry::new(), &allow, true);
/// assert!(!features.tools);
/// assert!(!features.fs_read);
/// assert!(!features.checkpoints);
/// // `toolchain` mirrors the TypeScript runtime's own unconditional `true`.
/// assert!(features.toolchain);
/// ```
#[must_use]
pub fn build_features(
    registry: &Registry,
    allow: &RuntimeCapabilityAllow,
    git_available: bool,
) -> RuntimeCapabilityFeatures {
    let fs_read = allow.fs_read && capability_ready(registry, "fsRead");
    let fs_write = allow.fs_write && capability_ready(registry, "fsWrite");
    let shell = allow.shell && capability_ready(registry, "shell");
    let git = allow.git && git_available && capability_ready(registry, "git");
    let probing = allow.probing && capability_ready(registry, "probing");
    let mcp = allow.mcp && capability_ready(registry, "mcp");
    let library = allow.library && capability_ready(registry, "library");
    let checkpoints = allow.checkpoints && capability_ready(registry, "checkpoints");
    let update = allow.update && capability_ready(registry, "update");
    let external_agents =
        allow.external_agents == Some(true) && capability_ready(registry, "externalAgents");
    // NOT a mirror of `manifest.ts`'s own `tools` line: that formula ORs the
    // *raw* `allow.*` flags, with no implementation gate at all (every
    // method already has a handler in that runtime, so there is nothing to
    // gate). ORing the *already-gated* `fs_read`/`fs_write`/… above instead
    // is deliberate: `manifest.ts`'s formula would make an empty registry
    // advertise `tools: true` purely from a fully-granted `allow`, which is
    // exactly what this crate's own tests forbid. The eight capabilities
    // summed here — `update` and `externalAgents` excluded — match the
    // TypeScript source's choice of which flags count.
    //
    // One further divergence worth stating plainly: `git` here also folds in
    // `git_available`, so a host with `allow.git = true`, all three `git.*`
    // methods implemented, but no `git` binary present answers TypeScript's
    // `tools: true` and this crate's `tools: false`.
    let tools = fs_read || fs_write || shell || git || mcp || probing || library || checkpoints;
    RuntimeCapabilityFeatures {
        tools,
        git,
        probing,
        mcp,
        library,
        checkpoints,
        fs_read,
        fs_write,
        shell,
        update,
        external_agents,
        toolchain: true,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::build_features;
    use crate::registry::Registry;
    use mangostudio_runtime_contract::manifest::RuntimeCapabilityAllow;

    fn full_allow() -> RuntimeCapabilityAllow {
        RuntimeCapabilityAllow {
            fs_read: true,
            fs_write: true,
            shell: true,
            git: true,
            probing: true,
            mcp: true,
            library: true,
            checkpoints: true,
            update: true,
            external_agents: Some(true),
        }
    }

    #[test]
    fn an_empty_registry_advertises_essentially_nothing_even_under_full_allow() {
        let features = build_features(&Registry::new(), &full_allow(), true);
        assert!(!features.tools);
        assert!(!features.git);
        assert!(!features.probing);
        assert!(!features.mcp);
        assert!(!features.library);
        assert!(!features.checkpoints);
        assert!(!features.fs_read);
        assert!(!features.fs_write);
        assert!(!features.shell);
        assert!(!features.update);
        assert!(!features.external_agents);
        // `toolchain` is the one feature this crate mirrors as an
        // unconditional hardcode, matching `manifest.ts` — see the module
        // docs for why that is safe even with nothing else implemented.
        assert!(features.toolchain);
    }

    #[test]
    fn an_ungranted_capability_stays_false_even_if_fully_implemented() {
        let registry = implement_all_checkpoints_methods();
        let mut allow = full_allow();
        allow.checkpoints = false;
        let features = build_features(&registry, &allow, true);
        assert!(!features.checkpoints, "consent was not granted");
    }

    #[test]
    fn a_capability_with_every_backing_method_implemented_and_allowed_turns_on() {
        let registry = implement_all_checkpoints_methods();
        let features = build_features(&registry, &full_allow(), true);
        assert!(features.checkpoints);
        assert!(features.tools, "checkpoints alone is enough to grant tools");
        // Nothing else was implemented.
        assert!(!features.fs_read);
        assert!(!features.shell);
    }

    #[test]
    fn a_partially_implemented_capability_stays_false() {
        let registry =
            Registry::new().implement("snapshot.capture", |_params: Value, _context| async move {
                Ok::<_, mango_protocol::RemoteError>(json!({ "exists": false }))
            });
        // Only one of the three `checkpoints` methods is implemented.
        let features = build_features(&registry, &full_allow(), true);
        assert!(
            !features.checkpoints,
            "a partially-implemented capability must not advertise"
        );
    }

    fn implement_all_checkpoints_methods() -> Registry {
        Registry::new()
            .implement("snapshot.capture", |_params: Value, _context| async move {
                Ok::<_, mango_protocol::RemoteError>(json!({ "exists": false }))
            })
            .implement("snapshot.hash", |_params: Value, _context| async move {
                Ok::<_, mango_protocol::RemoteError>(json!({ "hash": "deadbeef" }))
            })
            .implement("snapshot.revert", |_params: Value, _context| async move {
                Ok::<_, mango_protocol::RemoteError>(json!({ "revertedFiles": 0 }))
            })
    }
}
