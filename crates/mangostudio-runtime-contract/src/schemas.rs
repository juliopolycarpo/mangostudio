//! Compiled `jsonschema` validators for every shape the contract declares:
//! one per method's `params` and `result`, one per topic's payload, and one
//! each for the manifest, health, install-output and runtime-home documents.
//!
//! This is the crate's only contact point with `jsonschema` — no `jsonschema`
//! type appears in a `pub` signature here, mirroring
//! `mango_protocol::contract`'s own params module, so a future breaking
//! release of that crate stays a local, one-file fix.
//!
//! Every compile option mirrors `mango-protocol/src/contract/params.rs`
//! exactly (draft 2020-12, offline, format assertions on): the dispatcher in
//! `crates/mangostudio-runtime` compiles the same catalog through
//! [`mango_protocol::contract::Contract::from_catalog`], and a corpus that
//! gated a validator built with different options would not be testing what
//! the dispatcher actually runs.

use std::collections::HashMap;
use std::sync::OnceLock;

use jsonschema::Validator;
use serde_json::Value;

use crate::catalog::catalog;

pub(crate) const MANIFEST_SCHEMA_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../apps/shared/src/runtime-contract/generated/manifest.schema.json"
));
const HEALTH_SCHEMA_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../apps/shared/src/runtime-contract/generated/health.schema.json"
));
const INSTALL_OUTPUT_SCHEMA_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../apps/shared/src/runtime-contract/generated/install-output.schema.json"
));
const RUNTIME_HOME_SCHEMA_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../apps/shared/src/runtime-contract/generated/runtime-home.schema.json"
));

/// A schema violation: which subject rejected the value, where in its schema
/// the rejection happened, and which JSON Schema keyword it failed.
///
/// Deliberately carries none of the value that was checked. `jsonschema`'s own
/// error type embeds the offending instance in its `Display` — exactly what a
/// hub/runtime boundary must not put in a log line, since a rejected `params`
/// or `result` can carry a file's contents or a shell command's output. This
/// type reports only metadata about the schema, never the data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Violation {
    /// What was being checked, e.g. `method:fs.read-file:params` or `manifest`.
    pub subject: String,
    /// The failing schema location, as an RFC 6901-style JSON pointer.
    pub schema_path: String,
    /// The JSON Schema keyword that rejected the value (`"required"`,
    /// `"type"`, `"additionalProperties"`, …), never the value itself.
    pub keyword: String,
}

impl std::fmt::Display for Violation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{}: schema violation at {} (keyword: {})",
            self.subject, self.schema_path, self.keyword
        )
    }
}

impl std::error::Error for Violation {}

/// Compiles `schema` into a reusable validator: draft 2020-12, offline (every
/// schema in this contract is self-contained; a dangling `$ref` fails here
/// rather than reaching the network), with format assertions enabled.
pub(crate) fn compile(schema: &Value) -> Validator {
    jsonschema::draft202012::options()
        .offline()
        .should_validate_formats(true)
        .build(schema)
        .expect("a contract artifact's schema is a valid JSON Schema 2020-12 document")
}

/// Runs `validator` against `value` for `subject`, reporting the first
/// violation without ever touching `value` itself in the result.
pub(crate) fn check(
    validator: &Validator,
    subject: impl Into<String>,
    value: &Value,
) -> Result<(), Violation> {
    match validator.validate(value) {
        Ok(()) => Ok(()),
        Err(error) => Err(Violation {
            subject: subject.into(),
            schema_path: error.schema_path().as_str().to_string(),
            keyword: error.kind().keyword().to_string(),
        }),
    }
}

/// One method's compiled `params` and `result` validators.
struct MethodValidators {
    params: Validator,
    result: Validator,
}

fn method_validators() -> &'static HashMap<&'static str, MethodValidators> {
    static VALIDATORS: OnceLock<HashMap<&'static str, MethodValidators>> = OnceLock::new();
    VALIDATORS.get_or_init(|| {
        catalog()
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

fn event_validators() -> &'static HashMap<&'static str, Validator> {
    static VALIDATORS: OnceLock<HashMap<&'static str, Validator>> = OnceLock::new();
    VALIDATORS.get_or_init(|| {
        catalog()
            .events
            .iter()
            .map(|event| (event.topic.as_str(), compile(&event.payload)))
            .collect()
    })
}

/// Validates `params` against `method`'s declared schema.
///
/// # Errors
/// A [`Violation`] naming `method` when the contract has no such method
/// (`keyword` is `"unknownSubject"`, `schema_path` is empty — the same
/// keyword [`validate_event`] reports for an unknown topic, since both are
/// "the contract has nothing by this name" rather than a schema mismatch),
/// or naming the failing schema keyword and path when `params` fails the
/// method's schema.
///
/// # Example
///
/// ```
/// use mangostudio_runtime_contract::schemas::validate_params;
/// use serde_json::json;
///
/// assert!(validate_params("runtime.health", &json!({})).is_ok());
/// assert!(validate_params("fs.read-file", &json!({})).is_err());
/// ```
pub fn validate_params(method: &str, params: &Value) -> Result<(), Violation> {
    match method_validators().get(method) {
        Some(validators) => check(
            &validators.params,
            format!("method:{method}:params"),
            params,
        ),
        None => Err(unknown_subject(format!("method:{method}:params"))),
    }
}

/// Validates `result` against `method`'s declared schema. See
/// [`validate_params`] for the error shape.
///
/// # Errors
/// A [`Violation`] as documented on [`validate_params`].
pub fn validate_result(method: &str, result: &Value) -> Result<(), Violation> {
    match method_validators().get(method) {
        Some(validators) => check(
            &validators.result,
            format!("method:{method}:result"),
            result,
        ),
        None => Err(unknown_subject(format!("method:{method}:result"))),
    }
}

/// Validates `payload` against `topic`'s declared schema. See
/// [`validate_params`] for the error shape.
///
/// # Errors
/// A [`Violation`] as documented on [`validate_params`].
pub fn validate_event(topic: &str, payload: &Value) -> Result<(), Violation> {
    match event_validators().get(topic) {
        Some(validator) => check(validator, format!("topic:{topic}"), payload),
        None => Err(unknown_subject(format!("topic:{topic}"))),
    }
}

pub(crate) fn unknown_subject(subject: String) -> Violation {
    Violation {
        subject,
        schema_path: String::new(),
        keyword: "unknownSubject".to_string(),
    }
}

/// Validates `manifest` against `manifest.schema.json`.
///
/// # Errors
/// A [`Violation`] naming the failing schema keyword and path.
///
/// # Example
///
/// ```
/// use mangostudio_runtime_contract::manifest::{GitAvailability, PathStyle, RuntimeCapabilityManifest};
/// use mangostudio_runtime_contract::schemas::validate_manifest;
/// use serde_json::to_value;
///
/// let manifest = RuntimeCapabilityManifest::new(
///     "linux",
///     "x86_64",
///     PathStyle::Posix,
///     "/home/mango",
///     [],
///     GitAvailability { available: false, version: None },
/// );
/// assert!(validate_manifest(&to_value(manifest).expect("serialises")).is_ok());
/// ```
pub fn validate_manifest(manifest: &Value) -> Result<(), Violation> {
    static VALIDATOR: OnceLock<Validator> = OnceLock::new();
    let validator = VALIDATOR.get_or_init(|| {
        let schema: Value = serde_json::from_str(MANIFEST_SCHEMA_JSON)
            .expect("manifest.schema.json is well-formed JSON");
        compile(&schema)
    });
    check(validator, "manifest", manifest)
}

/// Validates `report` against `health.schema.json` — what
/// `mangostudio-runtime health --json` prints and `runtime.health` answers.
///
/// # Errors
/// A [`Violation`] naming the failing schema keyword and path.
pub fn validate_health(report: &Value) -> Result<(), Violation> {
    static VALIDATOR: OnceLock<Validator> = OnceLock::new();
    let validator = VALIDATOR.get_or_init(|| {
        let schema: Value = serde_json::from_str(HEALTH_SCHEMA_JSON)
            .expect("health.schema.json is well-formed JSON");
        compile(&schema)
    });
    check(validator, "health", report)
}

/// Validates `frame` against `install-output.schema.json` — the same payload
/// shape as the `install.output` topic, standalone for a caller that prints
/// or stores a frame outside the event wire.
///
/// # Errors
/// A [`Violation`] naming the failing schema keyword and path.
pub fn validate_install_output(frame: &Value) -> Result<(), Violation> {
    static VALIDATOR: OnceLock<Validator> = OnceLock::new();
    let validator = VALIDATOR.get_or_init(|| {
        let schema: Value = serde_json::from_str(INSTALL_OUTPUT_SCHEMA_JSON)
            .expect("install-output.schema.json is well-formed JSON");
        compile(&schema)
    });
    check(validator, "topic:install.output", frame)
}

/// Which `$defs` entry of `runtime-home.schema.json` a value is checked
/// against.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RuntimeHomeDocument {
    /// `runtime.json`: one slot's configuration.
    SlotConfig,
    /// `credentials.json`: one slot's stored credentials.
    Credentials,
    /// One line of `audit.log`.
    AuditRecord,
}

impl RuntimeHomeDocument {
    fn def_name(self) -> &'static str {
        match self {
            RuntimeHomeDocument::SlotConfig => "slotConfig",
            RuntimeHomeDocument::Credentials => "credentials",
            RuntimeHomeDocument::AuditRecord => "auditRecord",
        }
    }
}

impl std::fmt::Display for RuntimeHomeDocument {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.def_name())
    }
}

/// Validates `value` against the named `$defs` entry of
/// `runtime-home.schema.json`.
///
/// # Errors
/// A [`Violation`] naming the failing schema keyword and path.
///
/// # Example
///
/// ```
/// use mangostudio_runtime_contract::schemas::{validate_runtime_home, RuntimeHomeDocument};
/// use serde_json::json;
///
/// assert!(validate_runtime_home(
///     RuntimeHomeDocument::SlotConfig,
///     &json!({ "schemaVersion": 1, "slot": "host" }),
/// )
/// .is_ok());
/// ```
pub fn validate_runtime_home(
    document: RuntimeHomeDocument,
    value: &Value,
) -> Result<(), Violation> {
    static VALIDATORS: OnceLock<HashMap<RuntimeHomeDocument, Validator>> = OnceLock::new();
    let validators = VALIDATORS.get_or_init(|| {
        let root: Value = serde_json::from_str(RUNTIME_HOME_SCHEMA_JSON)
            .expect("runtime-home.schema.json is well-formed JSON");
        let defs = root
            .get("$defs")
            .expect("runtime-home.schema.json declares $defs")
            .clone();
        [
            RuntimeHomeDocument::SlotConfig,
            RuntimeHomeDocument::Credentials,
            RuntimeHomeDocument::AuditRecord,
        ]
        .into_iter()
        .map(|document| {
            let wrapper = serde_json::json!({
                "$defs": defs.clone(),
                "$ref": format!("#/$defs/{}", document.def_name()),
            });
            (document, compile(&wrapper))
        })
        .collect()
    });
    let validator = validators
        .get(&document)
        .expect("every RuntimeHomeDocument variant has a compiled validator");
    check(validator, format!("runtime-home:{document}"), value)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        RuntimeHomeDocument, validate_event, validate_health, validate_install_output,
        validate_manifest, validate_params, validate_result, validate_runtime_home,
    };

    #[test]
    fn a_valid_params_value_passes() {
        assert!(validate_params("runtime.health", &json!({})).is_ok());
    }

    #[test]
    fn an_invalid_params_value_names_the_failing_keyword_and_path() {
        let violation =
            validate_params("fs.read-file", &json!({})).expect_err("missing required fields");
        assert_eq!(violation.subject, "method:fs.read-file:params");
        assert_eq!(violation.keyword, "required");
        assert!(!violation.schema_path.is_empty());
    }

    #[test]
    fn an_unknown_method_is_a_violation_naming_the_subject_not_a_panic() {
        let violation = validate_params("no.such.method", &json!({})).expect_err("unknown method");
        assert_eq!(violation.subject, "method:no.such.method:params");
        assert_eq!(violation.keyword, "unknownSubject");
    }

    #[test]
    fn validate_result_checks_the_result_schema_not_params() {
        assert!(validate_result("runtime.health", &json!({})).is_err());
    }

    #[test]
    fn validate_event_checks_a_topic_payload() {
        assert!(validate_event("runtime.heartbeat", &json!({ "at": 0 })).is_ok());
        assert!(validate_event("runtime.heartbeat", &json!({})).is_err());
    }

    #[test]
    fn an_unknown_topic_is_a_violation_naming_the_subject_not_a_panic() {
        let violation = validate_event("no.such.topic", &json!({})).expect_err("unknown topic");
        assert_eq!(violation.subject, "topic:no.such.topic");
        assert_eq!(violation.keyword, "unknownSubject");
    }

    #[test]
    fn a_violation_never_carries_the_rejected_value() {
        // The canary this test protects: `jsonschema`'s own `ValidationError`
        // embeds the instance in its `Display` output. A `Violation` must not
        // — a rejected `params` or `result` can carry a file's contents.
        let secret = "CANARY-SECRET-9f3a";
        let violation = validate_params("fs.read-file", &json!({ "leaked": secret }))
            .expect_err("still missing required fields");
        assert!(!format!("{violation}").contains(secret));
        assert!(!format!("{violation:?}").contains(secret));
    }

    #[test]
    fn validate_manifest_checks_the_manifest_schema() {
        assert!(validate_manifest(&json!({})).is_err());
    }

    #[test]
    fn validate_health_checks_the_health_schema() {
        assert!(validate_health(&json!({})).is_err());
    }

    #[test]
    fn validate_install_output_checks_the_install_output_schema() {
        assert!(validate_install_output(&json!({ "stream": "stdout", "line": "" })).is_ok());
        assert!(validate_install_output(&json!({})).is_err());
    }

    #[test]
    fn validate_runtime_home_checks_the_named_def() {
        assert!(
            validate_runtime_home(
                RuntimeHomeDocument::SlotConfig,
                &json!({ "schemaVersion": 1, "slot": "host" }),
            )
            .is_ok()
        );
        assert!(validate_runtime_home(RuntimeHomeDocument::SlotConfig, &json!({})).is_err());
    }
}
