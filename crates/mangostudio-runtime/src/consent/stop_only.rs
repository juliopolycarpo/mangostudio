//! The catalog methods that only reduce effects: each ends, cancels, or detaches something
//! already running and starts nothing.
//!
//! The catalog carries no effect metadata, so the set is an explicit list, pinned by a test
//! against the catalog. The guard lets these through a consent read that did not finish (see
//! [`super::authorization`]): the watchers keep live resources on that same inconclusive read,
//! so refusing the stop would leave nothing able to end them. An explicit denial still refuses
//! them — the watcher revokes the resource itself in that case.
//!
//! `terminal.close` is absent on purpose: it declares no capability, so the guard never reads
//! consent for it at all.

/// Every stop-only method name, in catalog order.
pub(crate) const STOP_ONLY_METHODS: [&str; 5] = [
    "mcp.disconnect",
    "external-agent.cancel",
    "external-agent.close",
    "install.cancel",
    "terminal.detach",
];

/// Whether `method` only reduces effects, and so may proceed on an inconclusive consent read.
///
/// # Example
/// ```ignore
/// assert!(is_stop_only("install.cancel"));
/// assert!(!is_stop_only("install.run"));
/// ```
pub(crate) fn is_stop_only(method: &str) -> bool {
    STOP_ONLY_METHODS.contains(&method)
}

#[cfg(test)]
mod tests {
    use mangostudio_runtime_contract::catalog::catalog;

    use super::{STOP_ONLY_METHODS, is_stop_only};

    /// Name suffixes that mark a method as stop-shaped. The catalog uses `.cancel`,
    /// `.disconnect`, `.detach` and `.close` today; the rest cover verbs a later method may use.
    const STOP_SHAPED_SUFFIXES: [&str; 7] = [
        ".cancel",
        ".disconnect",
        ".detach",
        ".close",
        ".stop",
        ".abort",
        ".kill",
    ];

    /// Stop-shaped, capability-bearing methods that are deliberately not stop-only, each with
    /// the reason. Empty today.
    const NOT_STOP_ONLY: [(&str, &str); 0] = [];

    #[test]
    fn every_stop_shaped_catalog_method_is_classified() {
        let unclassified: Vec<&str> = catalog()
            .methods
            .iter()
            .filter(|method| !method.capabilities.is_empty())
            .map(|method| method.name.as_str())
            .filter(|name| STOP_SHAPED_SUFFIXES.iter().any(|s| name.ends_with(s)))
            .filter(|name| !is_stop_only(name))
            .filter(|name| !NOT_STOP_ONLY.iter().any(|(excluded, _)| excluded == name))
            .collect();
        assert!(
            unclassified.is_empty(),
            "expected every capability-bearing stop-shaped method to be in STOP_ONLY_METHODS or \
             NOT_STOP_ONLY with a reason | received unclassified: {unclassified:?}"
        );
    }

    #[test]
    fn the_stop_only_set_is_pinned_against_the_catalog() {
        let pinned: Vec<(&str, bool)> = catalog()
            .methods
            .iter()
            .filter(|method| is_stop_only(&method.name))
            .map(|method| (method.name.as_str(), method.capabilities.is_empty()))
            .collect();
        let expected: Vec<(&str, bool)> = STOP_ONLY_METHODS
            .iter()
            .map(|name| (*name, false))
            .collect();
        assert_eq!(
            pinned, expected,
            "expected every stop-only method to exist in the catalog, in catalog order, and to \
             declare a capability (otherwise the guard never reads consent for it) | received \
             {pinned:?}"
        );
    }

    #[test]
    fn effect_producing_neighbours_are_not_stop_only() {
        let leaked: Vec<&str> = [
            "mcp.connect",
            "mcp.call-tool",
            "external-agent.turn",
            "install.run",
            "terminal.open",
            "terminal.attach",
            "terminal.write",
        ]
        .into_iter()
        .filter(|method| is_stop_only(method))
        .collect();
        assert!(
            leaked.is_empty(),
            "expected no effect-producing method to be stop-only | received {leaked:?}"
        );
    }
}
