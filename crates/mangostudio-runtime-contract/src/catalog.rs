//! The catalog: every method and topic the hub/runtime contract defines,
//! parsed once from the TypeScript-generated `catalog.json`.

use std::sync::OnceLock;

use mango_protocol::Catalog;
use mango_protocol::catalog::{CatalogEvent, CatalogMethod};

/// `catalog.json`, exactly as `bun run contracts:emit` wrote it.
///
/// The one and only copy: nothing under `crates/` restates this text. See
/// the crate's ownership doc for why the Rust side embeds it rather than
/// generating its own.
const CATALOG_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../apps/shared/src/runtime-contract/generated/catalog.json"
));

static CATALOG: OnceLock<Catalog> = OnceLock::new();

/// Parses and validates `catalog.json`, once per process.
///
/// # Panics
/// Panics if the embedded text fails to parse as a [`Catalog`] or fails
/// [`Catalog::validate`]. Both are build-time facts about a file this crate
/// controls the emission of, not a runtime condition a caller can recover
/// from — the same reasoning [`mango_protocol::contract::Contract::builder`]
/// uses for a contract declared in source.
///
/// # Example
///
/// ```
/// let catalog = mangostudio_runtime_contract::catalog::catalog();
/// assert_eq!(catalog.name, "mangostudio.runtime");
/// ```
#[must_use]
pub fn catalog() -> &'static Catalog {
    CATALOG.get_or_init(|| {
        let catalog: Catalog = serde_json::from_str(CATALOG_JSON)
            .expect("catalog.json is a well-formed Catalog document");
        catalog
            .validate()
            .expect("catalog.json satisfies the protocol's own catalog.validate()");
        catalog
    })
}

/// The catalog's declared method named `name`, or `None` when the contract
/// carries no such method.
///
/// Never hardcodes a method name of its own: every caller, including this
/// crate's own tests, reaches a method only by looking it up here.
///
/// # Example
///
/// ```
/// use mangostudio_runtime_contract::catalog::method;
///
/// assert!(method("fs.read-file").is_some());
/// assert!(method("fs.does-not-exist").is_none());
/// ```
#[must_use]
pub fn method(name: &str) -> Option<&'static CatalogMethod> {
    catalog().methods.iter().find(|method| method.name == name)
}

/// The catalog's declared event topic named `topic`, or `None` when the
/// contract carries no such topic.
///
/// # Example
///
/// ```
/// use mangostudio_runtime_contract::catalog::event;
///
/// assert!(event("runtime.heartbeat").is_some());
/// assert!(event("no.such.topic").is_none());
/// ```
#[must_use]
pub fn event(topic: &str) -> Option<&'static CatalogEvent> {
    catalog().events.iter().find(|event| event.topic == topic)
}

/// Every capability `method` requires the machine's owner to have granted,
/// or `None` when `method` is not part of the contract.
///
/// A method the contract lists with no capabilities (today, only
/// `runtime.health`) answers `Some(&[])`, distinct from `None` for a method
/// that does not exist at all.
///
/// # Example
///
/// ```
/// use mangostudio_runtime_contract::catalog::capabilities_of;
///
/// assert_eq!(capabilities_of("fs.read-file"), Some(["fsRead".to_string()].as_slice()));
/// assert_eq!(capabilities_of("runtime.health"), Some([].as_slice()));
/// assert_eq!(capabilities_of("no.such.method"), None);
/// ```
#[must_use]
pub fn capabilities_of(method_name: &str) -> Option<&'static [String]> {
    method(method_name).map(|method| method.capabilities.as_slice())
}

#[cfg(test)]
mod tests {
    use super::{capabilities_of, catalog, event, method};

    #[test]
    fn parses_and_validates_the_embedded_catalog() {
        let catalog = catalog();
        assert_eq!(catalog.name, "mangostudio.runtime");
        assert!(catalog.validate().is_ok());
    }

    /// A baseline regression assertion, not a duplication-free invariant: the
    /// counts below are hand-typed against the catalog as of this writing
    /// (67 methods, 6 topics), so a method or topic added to — or removed
    /// from — the contract makes this specific assertion fail, prompting an
    /// update to the numbers rather than proving the two counts can never
    /// drift apart on their own.
    #[test]
    fn the_catalog_carries_the_current_baseline_of_methods_and_topics() {
        let catalog = catalog();
        assert_eq!(catalog.methods.len(), 67);
        assert_eq!(catalog.events.len(), 6);
    }

    #[test]
    fn looks_up_a_known_method_and_refuses_an_unknown_one() {
        assert!(method("fs.read-file").is_some());
        assert!(method("fs.does-not-exist").is_none());
    }

    #[test]
    fn looks_up_a_known_topic_and_refuses_an_unknown_one() {
        assert!(event("runtime.heartbeat").is_some());
        assert!(event("no.such.topic").is_none());
    }

    #[test]
    fn reads_a_methods_declared_capabilities() {
        assert_eq!(
            capabilities_of("fs.read-file"),
            Some(["fsRead".to_string()].as_slice())
        );
        assert_eq!(capabilities_of("runtime.health"), Some([].as_slice()));
        assert_eq!(capabilities_of("no.such.method"), None);
    }
}
