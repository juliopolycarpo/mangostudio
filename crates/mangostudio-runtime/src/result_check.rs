//! Checking a handler's result against the contract's `result` schema before
//! it is serialised onto the wire.
//!
//! ## Why not `ServeOptions::validate_results`
//!
//! `mango_protocol::contract::ServeOptions` has a `validate_results` flag,
//! but `Contract::serve`'s own pipeline (`contract/serve.rs::answer`) runs it
//! *after* the registered handler has already settled — which, once
//! [`crate::ports::audit`] wraps a handler to write its outcome, means an
//! `outcome: ok` line could already be recorded before the result check ever
//! runs. A malformed result would then answer the hub `INTERNAL` while the
//! runtime's own audit trail says the call succeeded — exactly the ordering
//! bug `apps/runtime/src/result-check.ts` was written to avoid in the
//! TypeScript runtime, by running its own result check *inside* the
//! audit-recording wrapper (`gateHandlers(checkResults(handlers), deps)`)
//! rather than through the SDK's own post-handler option.
//!
//! [`crate::registry::Registry::implement`] applies [`check_result`] the same
//! way: inside the closure it registers, before the audit port ever records
//! `ok`, and this crate never sets `ServeOptions::validate_results`.
//!
//! ## Why this crate always validates, unlike the TypeScript runtime
//!
//! `apps/runtime/src/config.ts` turns this check off in production, on the
//! reasoning that a shape the schema refuses is still better delivered to a
//! user than turned into a 500. This crate makes the opposite, deliberate
//! choice: it validates unconditionally, in every build. The check exists to
//! catch a handler drifting from the contract *before* a peer built from the
//! same catalog in another language copies the mistake, and a peer written in
//! Rust is exactly that other language today. Silently allowing a Rust
//! handler to drift from its own declared schema would defeat the reason this
//! crate embeds the schema at all.
//!
//! ## Why `reason` never echoes the checked value
//!
//! `jsonschema::ValidationError`'s default `Display` embeds the offending
//! instance (`"sensitive data" is not of type "string"`), which is exactly
//! what a handler's own result must never carry onto an `INTERNAL` message —
//! a result can hold a file's contents or a shell command's output. This
//! module renders the failure with [`jsonschema::ValidationError::masked`]
//! instead, which redacts every value while keeping the schema-level facts
//! (`error.kind()`, the property name, the JSON type) intact. This is a
//! deliberate divergence from `mango_protocol::contract`'s own
//! `params`/`result` checks, which use the unmasked message — reasonable
//! there, since `params` is a value the caller already sent, not one this
//! runtime is the sole holder of.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use jsonschema::Validator;
use jsonschema::error::ValidationErrorKind;
use mango_protocol::error::{RemoteError, codes};
use serde_json::Value;

use crate::ports::audit::lock;

/// Compiles `schema` the same way `mango_protocol::contract::params::compile`
/// and `mangostudio_runtime_contract::schemas::compile` do: draft 2020-12,
/// offline, with format assertions enabled. A corpus that gated a validator
/// built with different options would not be testing what this crate's own
/// dispatcher runs.
///
/// # Panics
/// Panics if `schema` is not a valid JSON Schema 2020-12 document. Every
/// schema this crate compiles comes from the embedded, checked-in contract,
/// so a failure here is a build-time fact about that artifact, not a runtime
/// condition a caller can recover from.
#[must_use]
pub fn compile_result_schema(schema: &Value) -> Validator {
    jsonschema::draft202012::options()
        .offline()
        .should_validate_formats(true)
        .build(schema)
        .expect("a catalog method's result schema is a valid JSON Schema 2020-12 document")
}

/// `method`'s compiled `result` schema, compiled once per process.
///
/// Every transport builds a fresh [`crate::registry::Registry`] per
/// connection, but the embedded catalog never changes, so each method's
/// validator is compiled on first use and shared after that. `schema` must be
/// `method`'s own catalog `result` schema; the cache is keyed by name alone.
pub(crate) fn cached_result_validator(method: &str, schema: &Value) -> Arc<Validator> {
    static VALIDATORS: OnceLock<Mutex<HashMap<String, Arc<Validator>>>> = OnceLock::new();
    let mut validators = lock(VALIDATORS.get_or_init(Mutex::default));
    Arc::clone(
        validators
            .entry(method.to_string())
            .or_insert_with(|| Arc::new(compile_result_schema(schema))),
    )
}

/// Checks `result` against `validator`, `method`'s compiled `result` schema.
///
/// # Errors
/// `INTERNAL` naming the failing instance path and reason, exactly mirroring
/// `apps/runtime/src/result-check.ts`'s wire shape:
/// - message: `Result of "{method}" does not match the contract at {path}: {reason}.`
/// - details: `{ "method": method, "path": path, "reason": reason }`
///
/// `path` is the instance-path JSON pointer the violation occurred at, with
/// `/{property}` appended when the failing keyword is `required` or
/// `additionalProperties` (the pointer alone stops one level short for a
/// property that either never appears in the document at all, or that the
/// document was not supposed to carry), defaulting to `/` for a
/// document-root violation.
///
/// This mirrors `apps/runtime/src/result-check.ts`'s wire shape, but not by
/// mirroring its code: `result-check.ts` special-cases only `required`
/// because TypeBox's own `instancePath` already points at an unexpected
/// property directly — there is nothing left for it to append. `jsonschema`
/// does not do that: an `additionalProperties` violation's `instance_path()`
/// points at the *container*, not the offending key, so this crate has to
/// append it itself to land on the same wire `path` TypeScript would report.
/// The special case matches
/// `mango_protocol::contract::params::first_violation`'s for exactly that
/// reason, not by coincidence.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::result_check::{check_result, compile_result_schema};
/// use serde_json::json;
///
/// let schema = json!({
///     "type": "object",
///     "required": ["sessions"],
///     "properties": { "sessions": { "type": "array" } },
/// });
/// let validator = compile_result_schema(&schema);
///
/// assert!(check_result("terminal.list", &validator, &json!({ "sessions": [] })).is_ok());
///
/// let error = check_result("terminal.list", &validator, &json!({})).expect_err("missing sessions");
/// assert_eq!(error.code, mango_protocol::error::codes::INTERNAL);
/// assert_eq!(
///     error.message,
///     "Result of \"terminal.list\" does not match the contract at /sessions: \"sessions\" is a required property."
/// );
/// ```
pub fn check_result(
    method: &str,
    validator: &Validator,
    result: &Value,
) -> Result<(), RemoteError> {
    let Err(error) = validator.validate(result) else {
        return Ok(());
    };
    let property = match error.kind() {
        ValidationErrorKind::Required { property } => property.as_str(),
        ValidationErrorKind::AdditionalProperties { unexpected } => {
            unexpected.first().map(String::as_str)
        }
        _ => None,
    };
    let instance_path = error.instance_path().as_str();
    let path = match property {
        Some(property) => format!("{instance_path}/{property}"),
        None if instance_path.is_empty() => "/".to_string(),
        None => instance_path.to_string(),
    };
    let reason = error.masked().to_string();
    Err(RemoteError::new(
        codes::INTERNAL,
        format!("Result of \"{method}\" does not match the contract at {path}: {reason}."),
    )
    .with_detail("method", method.to_string())
    .with_detail("path", path)
    .with_detail("reason", reason))
}

#[cfg(test)]
mod tests {
    use mango_protocol::error::codes;
    use serde_json::json;

    use std::sync::Arc;

    use super::{cached_result_validator, check_result, compile_result_schema};

    fn sessions_schema() -> jsonschema::Validator {
        compile_result_schema(&json!({
            "type": "object",
            "required": ["sessions"],
            "properties": { "sessions": { "type": "array" } },
        }))
    }

    /// A closed schema, matching the shape 48 of the catalog's actual result
    /// schemas use (`additionalProperties: false` alongside named
    /// properties) — the shape this test's regression can only fire on.
    fn closed_sessions_schema() -> jsonschema::Validator {
        compile_result_schema(&json!({
            "type": "object",
            "required": ["sessions"],
            "properties": { "sessions": { "type": "array" } },
            "additionalProperties": false,
        }))
    }

    #[test]
    fn a_valid_result_passes() {
        let validator = sessions_schema();
        assert!(check_result("terminal.list", &validator, &json!({ "sessions": [] })).is_ok());
    }

    #[test]
    fn a_missing_required_property_names_the_property_in_the_path() {
        let validator = sessions_schema();
        let error =
            check_result("terminal.list", &validator, &json!({})).expect_err("missing sessions");
        assert_eq!(error.code, codes::INTERNAL);
        assert_eq!(
            error.message,
            "Result of \"terminal.list\" does not match the contract at /sessions: \"sessions\" is a required property."
        );
        let details = error.details.expect("details present");
        assert_eq!(details["method"], json!("terminal.list"));
        assert_eq!(details["path"], json!("/sessions"));
        assert!(!details["reason"].as_str().unwrap().is_empty());
    }

    #[test]
    fn an_unexpected_property_points_at_the_property_itself_not_the_document_root() {
        let validator = closed_sessions_schema();
        let error = check_result(
            "terminal.list",
            &validator,
            &json!({ "sessions": [], "sessionCount": 3 }),
        )
        .expect_err("sessionCount is not a declared property");
        let details = error.details.expect("details present");
        assert_eq!(details["path"], json!("/sessionCount"));
        assert_eq!(
            error.message,
            "Result of \"terminal.list\" does not match the contract at /sessionCount: Additional properties are not allowed ('sessionCount' was unexpected)."
        );
    }

    #[test]
    fn a_root_type_violation_points_at_the_document_root() {
        let validator = sessions_schema();
        let error =
            check_result("terminal.list", &validator, &json!(1)).expect_err("wrong root type");
        assert_eq!(error.details.unwrap()["path"], json!("/"));
    }

    #[test]
    fn the_reason_never_echoes_the_checked_value() {
        let validator = sessions_schema();
        let secret = "CANARY-SECRET-9f3a";
        let error = check_result("terminal.list", &validator, &json!({ "sessions": secret }))
            .expect_err("wrong type for sessions");
        assert!(!error.message.contains(secret));
        assert!(
            !error.details.unwrap()["reason"]
                .as_str()
                .unwrap()
                .contains(secret)
        );
    }

    #[test]
    fn a_method_result_validator_is_compiled_once_and_shared() {
        let schema = json!({ "type": "object" });
        let first = cached_result_validator("result_check.test.cached", &schema);
        let second = cached_result_validator("result_check.test.cached", &schema);
        assert!(
            Arc::ptr_eq(&first, &second),
            "expected the second lookup to reuse the first compiled validator, got a fresh compile"
        );
        assert!(check_result("result_check.test.cached", &second, &json!({})).is_ok());
    }
}
