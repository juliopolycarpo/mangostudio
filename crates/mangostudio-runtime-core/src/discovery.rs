//! What this build implements: `runtime.discover` and the `implementation`
//! member of `hello.capabilities`.
//!
//! `rpc.discover` returns the whole embedded catalog, which every build of
//! this contract version shares, so it proves nothing about implementation.
//! This module answers from the [`Registry`] instead: the sorted methods it
//! registered and the feature groups whose every backing method is among
//! them. Consent, machine availability, and authentication never enter, so
//! the same build answers the same fingerprint on every machine and under
//! every consent profile.
//!
//! The feature groups are derived from the registry through the same
//! [`crate::manifest`] readiness gate `features` uses, so a group cannot be
//! announced without its methods, or registered without being announced.

use std::sync::{Arc, OnceLock};

use mango_protocol::error::{RemoteError, codes};
use mangostudio_runtime_contract::manifest::{
    IMPLEMENTATION_SCHEMA_VERSION, RuntimeDiscovery, RuntimeImplementationFeatures,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

use mangostudio_runtime_contract::catalog::catalog;

use crate::hex::hex;
use crate::manifest::capability_ready;
use crate::registry::{Classification, Registry};

/// The method this module serves.
pub const DISCOVER_METHOD: &str = "runtime.discover";

/// Which feature groups `registry` implements, independent of consent.
///
/// A group counts only when every catalog method backing it is registered;
/// `update` and `terminal` additionally need a platform this build can
/// publish slots and open PTYs on.
///
/// # Example
///
/// ```
/// use mangostudio_runtime_core::discovery::implemented_features;
/// use mangostudio_runtime_core::registry::Registry;
///
/// assert!(!implemented_features(&Registry::new()).shell);
/// ```
#[must_use]
pub fn implemented_features(registry: &Registry) -> RuntimeImplementationFeatures {
    RuntimeImplementationFeatures {
        git: capability_ready(registry, "git"),
        probing: capability_ready(registry, "probing"),
        mcp: capability_ready(registry, "mcp"),
        library: capability_ready(registry, "library"),
        checkpoints: capability_ready(registry, "checkpoints"),
        fs_read: capability_ready(registry, "fsRead"),
        fs_write: capability_ready(registry, "fsWrite"),
        shell: capability_ready(registry, "shell"),
        update: cfg!(any(unix, windows)) && capability_ready(registry, "update"),
        external_agents: capability_ready(registry, "externalAgents"),
        terminal: cfg!(any(unix, windows)) && family_ready(registry, TERMINAL_PREFIX),
    }
}

/// The method-name prefix of the PTY family, announced only when every catalog method under it
/// is implemented.
pub const TERMINAL_PREFIX: &str = "terminal.";

/// Whether every catalog method whose name starts with `prefix` is
/// implemented. `false` when the catalog declares no such method, so a
/// family nothing backs is never announced.
fn family_ready(registry: &Registry, prefix: &str) -> bool {
    let mut family = catalog()
        .methods
        .iter()
        .filter(|declared| declared.name.starts_with(prefix))
        .peekable();
    family.peek().is_some()
        && family.all(|declared| registry.classify(&declared.name) == Classification::Implemented)
}

/// Lowercase hex SHA-256 of the UTF-8 text
/// `schema=<n>\nmethods=<sorted methods joined by ",">\nfeatures=<sorted
/// implemented feature keys joined by ",">\n` — the recipe
/// `RuntimeImplementationFingerprintSchema` documents.
///
/// # Example
///
/// ```
/// use mangostudio_runtime_core::discovery::implementation_fingerprint;
/// use mangostudio_runtime_contract::manifest::RuntimeImplementationFeatures;
///
/// let features = RuntimeImplementationFeatures { git: true, shell: true, ..Default::default() };
/// assert_eq!(
///     implementation_fingerprint(1, &["runtime.health", "runtime.discover"], &features),
///     "46c42301a5dc4629ab08364c6c27db791a1cc53535602ecf7364345b19b60100",
/// );
/// ```
#[must_use]
pub fn implementation_fingerprint(
    schema: u32,
    methods: &[&str],
    features: &RuntimeImplementationFeatures,
) -> String {
    let mut methods = methods.to_vec();
    methods.sort_unstable();
    methods.dedup();
    let text = format!(
        "schema={schema}\nmethods={}\nfeatures={}\n",
        methods.join(","),
        features.implemented_keys().join(",")
    );
    hex(&Sha256::digest(text.as_bytes()))
}

/// The full `runtime.discover` answer for `registry`, as it stands now.
///
/// # Example
///
/// ```
/// use mangostudio_runtime_core::discovery::discovery_of;
/// use mangostudio_runtime_core::registry::Registry;
///
/// let discovery = discovery_of(&Registry::new());
/// assert!(discovery.methods.is_empty());
/// assert_eq!(discovery.fingerprint.len(), 64);
/// ```
#[must_use]
pub fn discovery_of(registry: &Registry) -> RuntimeDiscovery {
    let methods = registry.implemented_methods();
    let features = implemented_features(registry);
    RuntimeDiscovery {
        schema: IMPLEMENTATION_SCHEMA_VERSION,
        fingerprint: implementation_fingerprint(IMPLEMENTATION_SCHEMA_VERSION, &methods, &features),
        features,
        methods: methods.into_iter().map(str::to_owned).collect(),
    }
}

/// Registers `runtime.discover`, answering the surface of the finished
/// registry — this method included.
///
/// Must be the last registration: [`Registry::implement`] refuses any method
/// added after it, because the answer is fixed here.
///
/// ```ignore
/// let registry = crate::discovery::register(crate::update::register(registry, &update, exclusivity));
/// ```
pub fn register(registry: Registry) -> Registry {
    let answer: Arc<OnceLock<RuntimeDiscovery>> = Arc::new(OnceLock::new());
    let served = Arc::clone(&answer);
    let registry = registry.implement(DISCOVER_METHOD, move |_params: Value, _context| {
        let served = Arc::clone(&served);
        async move {
            served.get().cloned().ok_or_else(|| {
                RemoteError::new(
                    codes::INTERNAL,
                    "runtime.discover was called before its registry was finished.",
                )
            })
        }
    });
    let _ = answer.set(discovery_of(&registry));
    registry
}

#[cfg(test)]
mod tests {
    use mangostudio_runtime_contract::manifest::RuntimeImplementationFeatures;
    use serde_json::{Value, json};

    use super::{discovery_of, implementation_fingerprint, implemented_features};
    use crate::registry::Registry;

    #[test]
    fn the_fingerprint_follows_the_documented_recipe() {
        let features = RuntimeImplementationFeatures {
            git: true,
            shell: true,
            ..RuntimeImplementationFeatures::default()
        };
        assert_eq!(
            implementation_fingerprint(1, &["runtime.health", "runtime.discover"], &features),
            "46c42301a5dc4629ab08364c6c27db791a1cc53535602ecf7364345b19b60100",
            "expected sha256(\"schema=1\\nmethods=runtime.discover,runtime.health\\nfeatures=git,shell\\n\")"
        );
    }

    #[test]
    fn the_fingerprint_changes_with_the_method_set_and_the_feature_set() {
        let none = RuntimeImplementationFeatures::default();
        let base = implementation_fingerprint(1, &["runtime.health"], &none);
        let more_methods = implementation_fingerprint(1, &["runtime.health", "shell.run"], &none);
        let more_features = implementation_fingerprint(
            1,
            &["runtime.health"],
            &RuntimeImplementationFeatures {
                shell: true,
                ..none
            },
        );
        assert_ne!(base, more_methods);
        assert_ne!(base, more_features);
    }

    #[test]
    fn an_empty_registry_implements_nothing() {
        let discovery = discovery_of(&Registry::new());
        assert!(discovery.methods.is_empty());
        assert_eq!(discovery.features, RuntimeImplementationFeatures::default());
    }

    #[test]
    fn a_partial_terminal_family_is_not_announced() {
        let registry =
            Registry::new().implement("terminal.list", |_params: Value, _context| async move {
                Ok::<_, mango_protocol::RemoteError>(json!({ "sessions": [] }))
            });
        assert!(!implemented_features(&registry).terminal);
    }

    #[test]
    #[should_panic(expected = "runtime.discover")]
    fn a_method_registered_after_runtime_discover_is_refused() {
        let _ = super::register(Registry::new())
            .implement("runtime.health", |_params: Value, _context| async move {
                Ok::<_, mango_protocol::RemoteError>(json!({}))
            });
    }
}
