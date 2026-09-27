//! The hub contract: what a runtime may ask of the hub that connected it,
//! parsed once from the TypeScript-generated `hub-catalog.json`.
//!
//! The runtime contract ([`crate::catalog`]) runs hub → runtime. This one runs
//! the other way. A runtime validates what it sends and what it receives here,
//! so a hub from another release that answers with a shape this build never
//! reviewed is refused rather than trusted.

use std::collections::HashMap;
use std::sync::OnceLock;

use jsonschema::Validator;
use mango_protocol::Catalog;
use serde_json::Value;

use crate::schemas::{Violation, check, compile, unknown_subject};

/// `hub-catalog.json`, exactly as `bun run contracts:emit` wrote it.
const HUB_CATALOG_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../apps/shared/src/runtime-contract/generated/hub-catalog.json"
));

/// The method a runtime calls before admitting an external-agent workspace,
/// verified against the embedded catalog by this module's tests.
pub const HUB_WORKSPACE_AUTHORIZE: &str = "hub.workspace.authorize";

static HUB_CATALOG: OnceLock<Catalog> = OnceLock::new();

/// Parses and validates `hub-catalog.json`, once per process.
///
/// # Panics
/// Panics if the embedded text is not a valid [`Catalog`], for the same
/// reason [`crate::catalog::catalog`] does: it is a build-time fact.
///
/// # Example
///
/// ```
/// let catalog = mangostudio_runtime_contract::hub::hub_catalog();
/// assert_eq!(catalog.name, "mangostudio.hub");
/// ```
#[must_use]
pub fn hub_catalog() -> &'static Catalog {
    HUB_CATALOG.get_or_init(|| {
        let catalog: Catalog = serde_json::from_str(HUB_CATALOG_JSON)
            .expect("hub-catalog.json is a well-formed Catalog document");
        catalog
            .validate()
            .expect("hub-catalog.json satisfies the protocol's own catalog.validate()");
        catalog
    })
}

struct MethodValidators {
    params: Validator,
    result: Validator,
}

fn validators() -> &'static HashMap<&'static str, MethodValidators> {
    static VALIDATORS: OnceLock<HashMap<&'static str, MethodValidators>> = OnceLock::new();
    VALIDATORS.get_or_init(|| {
        hub_catalog()
            .methods
            .iter()
            .map(|method| {
                (
                    method.name.as_str(),
                    MethodValidators {
                        params: compile(&method.params),
                        result: compile(&method.result),
                    },
                )
            })
            .collect()
    })
}

/// Validates `params` against the hub method `method`'s declared schema.
///
/// # Errors
/// A [`Violation`] with keyword `unknownSubject` when the hub contract has no
/// such method, or naming the failing keyword and path.
///
/// # Example
///
/// ```
/// use mangostudio_runtime_contract::hub::{HUB_WORKSPACE_AUTHORIZE, validate_hub_params};
/// use serde_json::json;
///
/// let params = json!({ "canonicalPath": "/work", "purpose": "external-agent" });
/// assert!(validate_hub_params(HUB_WORKSPACE_AUTHORIZE, &params).is_ok());
/// assert!(validate_hub_params(HUB_WORKSPACE_AUTHORIZE, &json!({})).is_err());
/// ```
pub fn validate_hub_params(method: &str, params: &Value) -> Result<(), Violation> {
    let subject = format!("hub-method:{method}:params");
    match validators().get(method) {
        Some(validators) => check(&validators.params, subject, params),
        None => Err(unknown_subject(subject)),
    }
}

/// Validates `result` against the hub method `method`'s declared schema.
///
/// # Errors
/// A [`Violation`] as documented on [`validate_hub_params`].
///
/// # Example
///
/// ```
/// use mangostudio_runtime_contract::hub::{HUB_WORKSPACE_AUTHORIZE, validate_hub_result};
/// use serde_json::json;
///
/// assert!(validate_hub_result(HUB_WORKSPACE_AUTHORIZE, &json!({ "authorized": true })).is_ok());
/// assert!(validate_hub_result(HUB_WORKSPACE_AUTHORIZE, &json!({ "authorized": "yes" })).is_err());
/// ```
pub fn validate_hub_result(method: &str, result: &Value) -> Result<(), Violation> {
    let subject = format!("hub-method:{method}:result");
    match validators().get(method) {
        Some(validators) => check(&validators.result, subject, result),
        None => Err(unknown_subject(subject)),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_authorize_constant_names_a_method_the_hub_catalog_declares() {
        let names: Vec<&str> = hub_catalog()
            .methods
            .iter()
            .map(|method| method.name.as_str())
            .collect();
        assert_eq!(
            names,
            [HUB_WORKSPACE_AUTHORIZE],
            "expected hub methods: [{HUB_WORKSPACE_AUTHORIZE}] | received: {names:?}"
        );
    }

    #[test]
    fn the_authorize_shapes_are_closed_and_bounded() {
        let path = |length: usize| json!({ "canonicalPath": "a".repeat(length), "purpose": "external-agent" });
        assert!(validate_hub_params(HUB_WORKSPACE_AUTHORIZE, &path(4096)).is_ok());
        for (label, params) in [
            ("empty path", path(0)),
            ("4097-byte path", path(4097)),
            (
                "other purpose",
                json!({ "canonicalPath": "/w", "purpose": "shell" }),
            ),
            (
                "extra member",
                json!({ "canonicalPath": "/w", "purpose": "external-agent", "user": "u" }),
            ),
        ] {
            assert!(
                validate_hub_params(HUB_WORKSPACE_AUTHORIZE, &params).is_err(),
                "expected params refused: {label}"
            );
        }
        assert!(
            validate_hub_result(
                HUB_WORKSPACE_AUTHORIZE,
                &json!({ "authorized": true, "extra": 1 })
            )
            .is_err(),
            "expected a result with an undeclared member refused"
        );
    }

    #[test]
    fn an_unknown_hub_method_is_an_unknown_subject() {
        let violation = validate_hub_params("hub.nothing", &json!({})).unwrap_err();
        assert_eq!(violation.keyword, "unknownSubject");
    }
}
