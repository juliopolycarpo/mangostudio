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
//! corresponding feature to be [`Registry::classify`]'d as
//! [`Classification::Implemented`] — fail-closed, so a feature backed by
//! nine methods and implemented by three of them is not advertised at all.
//! With an empty [`Registry`] (what this module's own tests build), every
//! capability-gated feature computes `false` regardless of `allow` — the
//! fail-closed floor this gate guarantees. The production registry
//! `crate::transport::build_host_with_restart` (crate-private) registers only
//! the method groups this build implements, so the same gate keeps every
//! feature backed by an unregistered method unadvertised there too, not just
//! in the empty case. That function is the one list of what is implemented;
//! this comment deliberately does not repeat it.
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

/// Whether every method backing `capability`'s feature is implemented.
///
/// `false` when the catalog carries no method for `capability` at all (a
/// capability nothing backs is never "ready"), and `false` as soon as one
/// required method is missing — a partially-implemented capability is not
/// advertised as available.
pub(crate) fn capability_ready(registry: &Registry, capability: &str) -> bool {
    let mut required = catalog()
        .methods
        .iter()
        .filter(|declared| declared.capabilities.iter().any(|c| c == capability))
        // Snapshot and library methods require filesystem consent, but their
        // implementation gates belong to checkpoints and library. Requiring
        // them here hides working filesystem tools until unrelated groups ship.
        .filter(|declared| {
            !matches!(capability, "fsRead" | "fsWrite")
                || declared.name.starts_with("fs.")
                || declared.name.starts_with("workspace.")
        })
        .peekable();
    required.peek().is_some()
        && required.all(|declared| registry.classify(&declared.name) == Classification::Implemented)
}

/// Whether at least one tool group is usable: the one derivation of
/// `features.tools`.
///
/// Reads only *effective* features — each already consented, implemented,
/// and (for `git`) backed by a present binary — never the raw `allow`
/// flags, so consent alone can never advertise absent handlers or
/// executables. `apps/runtime/src/manifest.ts` ORs the raw `allow.*` flags
/// instead; this is the stricter rule both hosts converge on. The eight
/// groups counted match that source's choice: `update`, `externalAgents`,
/// and the `toolchain` request shape are not tool groups. `shell` counts on
/// consent and implementation alone, matching `features.shell`: `install.run`
/// spawns its argv directly, so the group stays usable with no detected
/// interactive shell (`shells` reports that separately).
///
/// # Example
///
/// ```
/// use mangostudio_runtime::manifest::{build_features, effective_tools};
/// use mangostudio_runtime::registry::Registry;
/// use mangostudio_runtime_contract::manifest::RuntimeCapabilityAllow;
///
/// let allow = RuntimeCapabilityAllow {
///     fs_read: true, fs_write: true, shell: true, git: true, probing: true,
///     mcp: true, library: true, checkpoints: true, update: true,
///     external_agents: Some(true),
/// };
/// let mut features = build_features(&Registry::new(), &allow, true);
/// assert!(!effective_tools(&features));
/// features.fs_read = true;
/// assert!(effective_tools(&features));
/// ```
#[must_use]
pub fn effective_tools(features: &RuntimeCapabilityFeatures) -> bool {
    features.fs_read
        || features.fs_write
        || features.shell
        || features.git
        || features.mcp
        || features.probing
        || features.library
        || features.checkpoints
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
    let update = cfg!(any(unix, windows)) && allow.update && capability_ready(registry, "update");
    let external_agents =
        allow.external_agents == Some(true) && capability_ready(registry, "externalAgents");
    let mut features = RuntimeCapabilityFeatures {
        tools: false,
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
    };
    features.tools = effective_tools(&features);
    features
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::{build_features, effective_tools};
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
    fn update_feature_requires_publication_support_on_this_platform() {
        let registry = [
            "runtime.update.begin",
            "runtime.update.chunk",
            "runtime.update.commit",
        ]
        .into_iter()
        .fold(Registry::new(), |registry, method| {
            registry.implement(method, |_params: Value, _context| async {
                Ok::<_, mango_protocol::RemoteError>(json!({}))
            })
        });
        let features = build_features(&registry, &full_allow(), true);
        assert_eq!(features.update, cfg!(any(unix, windows)));
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

    /// The gate this whole module exists for, now observable for real:
    /// with `crate::probing::register` implementing all three
    /// `probing.*` methods, `features.probing` still needs `allow.probing`
    /// granted — an implemented capability is not a granted one.
    #[test]
    fn probing_flips_true_only_when_all_three_methods_are_implemented_and_allowed() {
        let registry = crate::probing::register(Registry::new());

        let allowed = build_features(&registry, &full_allow(), true);
        assert!(
            allowed.probing,
            "all three probing.* methods are implemented and allow.probing is granted"
        );

        let mut denied_allow = full_allow();
        denied_allow.probing = false;
        let denied = build_features(&registry, &denied_allow, true);
        assert!(
            !denied.probing,
            "a consent denial must still suppress probing even though every method is implemented"
        );
    }

    /// A partially-implemented `probing` (two of its three methods, built
    /// directly rather than through `crate::probing::register` so this
    /// test does not depend on that module's own internals) must not be
    /// advertised — the same "every required method, or none of it" rule
    /// `a_partially_implemented_capability_stays_false` already pins for
    /// `checkpoints`. This is also this crate's mutation guard for
    /// `probing_flips_true_only_when_all_three_methods_are_implemented_and_allowed`:
    /// removing one of `crate::probing::methods::register`'s three
    /// `.implement(...)` calls turns that other test's own `allowed.probing`
    /// assertion red, by the identical mechanism this test exercises
    /// directly.
    #[test]
    fn probing_stays_false_if_only_two_of_its_three_methods_are_implemented() {
        let registry = Registry::new()
            .implement("probing.runtimes", |_params: Value, _context| async move {
                Ok::<_, mango_protocol::RemoteError>(json!({ "statuses": [] }))
            })
            .implement(
                "probing.version-managers",
                |_params: Value, _context| async move {
                    Ok::<_, mango_protocol::RemoteError>(json!({ "statuses": [] }))
                },
            );
        // "probing.agent-clis" deliberately left unimplemented.
        let features = build_features(&registry, &full_allow(), true);
        assert!(
            !features.probing,
            "a partially-implemented capability (2 of 3 probing.* methods) must not be advertised"
        );
    }

    fn implement_methods(methods: &[&'static str]) -> Registry {
        methods.iter().fold(Registry::new(), |registry, method| {
            registry.implement(*method, |_params: Value, _context| async {
                Ok::<_, mango_protocol::RemoteError>(json!({}))
            })
        })
    }

    fn only_git_allowed() -> RuntimeCapabilityAllow {
        RuntimeCapabilityAllow {
            fs_read: false,
            fs_write: false,
            shell: false,
            git: true,
            probing: false,
            mcp: false,
            library: false,
            checkpoints: false,
            update: false,
            external_agents: None,
        }
    }

    /// Consent to a group whose executable is absent must not advertise tools.
    #[test]
    fn tools_stays_false_when_the_only_consented_group_lacks_its_executable() {
        let registry = implement_methods(&["git.exec", "gh.exec", "gh.mutate"]);

        let absent = build_features(&registry, &only_git_allowed(), false);
        assert!(
            !absent.tools,
            "expected tools: false (allow.git with no git binary) | received: {absent:?}"
        );

        let present = build_features(&registry, &only_git_allowed(), true);
        assert!(
            present.git && present.tools,
            "expected git and tools: true (allow.git, implemented, binary present) | received: {present:?}"
        );
    }

    /// Consent to a group with no registered handlers must not advertise tools.
    #[test]
    fn tools_stays_false_when_the_only_consented_group_has_no_handlers() {
        let features = build_features(&Registry::new(), &only_git_allowed(), true);
        assert!(
            !features.tools,
            "expected tools: false (allow.git, no git.* handler) | received: {features:?}"
        );
    }

    /// `update` and `externalAgents` are not tool groups: effective alone, they
    /// still leave `tools` false.
    #[test]
    fn tools_ignores_groups_that_are_not_tool_groups() {
        let mut features = build_features(&Registry::new(), &full_allow(), true);
        features.update = true;
        features.external_agents = true;
        assert!(
            !effective_tools(&features),
            "expected tools: false (only update/externalAgents/toolchain effective) | received: {features:?}"
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

    #[test]
    fn filesystem_registration_enables_checkpoints_without_library() {
        let home = crate::test_support::scratch_dir("manifest-filesystem");
        let registry = crate::filesystem::register(
            crate::workspace_methods::register(Registry::new()),
            crate::consent::source::ConsentSource::new(
                crate::runtime_home::RuntimeSlot::Host,
                home.to_path_buf(),
            ),
        );
        let ready = build_features(&registry, &full_allow(), false);
        assert!(ready.fs_read && ready.fs_write && ready.tools);
        assert!(ready.checkpoints && !ready.library);
        let mut allow = full_allow();
        allow.fs_read = false;
        let denied = build_features(&registry, &allow, false);
        assert!(!denied.fs_read);
        assert!(denied.fs_write);
    }
}
