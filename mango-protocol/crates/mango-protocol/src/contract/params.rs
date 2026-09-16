//! The crate's only contact point with `jsonschema`: compiling a schema once
//! and checking a value against it. No `jsonschema` type ever appears in a
//! `pub` signature outside this module, so a future breaking release of that
//! crate stays a local, one-file fix.

use jsonschema::Validator;
use jsonschema::error::ValidationErrorKind;
use serde_json::Value;

use crate::validate::ValidationError;

/// Compiles `schema` into a reusable validator.
///
/// Draft 2020-12, offline (a catalog's schemas are inline; a dangling `$ref`
/// fails here rather than reaching the network), with `format` assertions
/// enabled — 2020-12 treats `format` as annotation-only otherwise, and a
/// catalog author who wrote one expects it enforced.
pub(super) fn compile(field: &str, schema: &Value) -> Result<Validator, ValidationError> {
    jsonschema::draft202012::options()
        .offline()
        .should_validate_formats(true)
        .build(schema)
        .map_err(|error| ValidationError {
            field: field.to_string(),
            received: error.to_string(),
            expected: "a valid JSON Schema 2020-12 document".to_string(),
        })
}

/// The first violation of `validator` by `value`, as an RFC 6901 pointer (the
/// document root renders as `/`, matching the TypeScript SDK's own fallback)
/// plus jsonschema's own message. `None` when `value` validates.
///
/// `required`/`additionalProperties` point at the missing or unexpected
/// property itself, not its container — `instance_path()` alone stops one
/// level short for exactly these two keywords, since the violation is about
/// a property that (for `required`) never appears in the document at all.
pub(super) fn first_violation(validator: &Validator, value: &Value) -> Option<(String, String)> {
    let error = validator.validate(value).err()?;
    let base = error.instance_path();
    let pointer = match error.kind() {
        ValidationErrorKind::Required { property } => {
            base.join(property.as_str().unwrap_or_default())
        }
        ValidationErrorKind::AdditionalProperties { unexpected } => {
            base.join(unexpected.first().map(String::as_str).unwrap_or_default())
        }
        _ => base.clone(),
    };
    let path = if pointer.as_str().is_empty() {
        "/".to_string()
    } else {
        pointer.as_str().to_string()
    };
    Some((path, error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::{compile, first_violation};
    use serde_json::json;

    #[test]
    fn a_valid_value_has_no_violation() {
        let validator = compile("params", &json!({"type": "object"})).expect("compiles");
        assert!(first_violation(&validator, &json!({})).is_none());
    }

    #[test]
    fn a_root_type_violation_points_at_the_document_root() {
        let validator = compile("params", &json!({"type": "object"})).expect("compiles");
        let (path, _) = first_violation(&validator, &json!(1)).expect("a violation");
        assert_eq!(path, "/");
    }

    #[test]
    fn a_missing_required_property_points_at_the_property_itself() {
        let schema = json!({"type": "object", "required": ["a"]});
        let validator = compile("params", &schema).expect("compiles");
        let (path, _) = first_violation(&validator, &json!({})).expect("a violation");
        assert_eq!(path, "/a");
    }

    #[test]
    fn an_unexpected_property_points_at_the_property_itself() {
        // `additionalProperties: false` with no named `properties` compiles
        // to jsonschema's own "everything fails a false schema" validator,
        // which reports only the container, not the extra key — a real
        // catalog schema always names its properties alongside
        // `additionalProperties: false`, which is what actually produces
        // the `AdditionalProperties` error kind this test exercises.
        let schema = json!({
            "type": "object",
            "properties": { "text": { "type": "string" } },
            "additionalProperties": false,
        });
        let validator = compile("params", &schema).expect("compiles");
        let (path, _) = first_violation(&validator, &json!({"text": "hi", "unexpected": 1}))
            .expect("a violation");
        assert_eq!(path, "/unexpected");
    }

    #[test]
    fn a_nested_type_violation_points_at_the_offending_element() {
        let schema = json!({
            "type": "object",
            "properties": { "a": { "type": "array", "items": { "type": "object" } } },
        });
        let validator = compile("params", &schema).expect("compiles");
        let (path, _) = first_violation(&validator, &json!({"a": [{}, 1]})).expect("a violation");
        assert_eq!(path, "/a/1");
    }

    #[test]
    fn an_invalid_schema_document_is_refused_at_compile_time() {
        let error = compile("params", &json!({"type": "not-a-type"})).expect_err("not a schema");
        assert_eq!(error.field, "params");
        assert!(error.expected.contains("2020-12"), "{error}");
    }
}
