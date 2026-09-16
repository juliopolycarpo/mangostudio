//! JSON Schema emission for the wire types, behind the `schema` feature.
//!
//! The repository's schema-equality check compares this emission, the
//! TypeScript SDK's TypeBox emission and `spec/schema/1/protocol.json` after a
//! normaliser has flattened the three dialects. Nothing in this module is
//! needed to speak the protocol.

use schemars::generate::SchemaSettings;
use schemars::{Schema, SchemaGenerator, json_schema};
use serde_json::{Map, Value, json};

use crate::catalog::Catalog;
use crate::close::{MAX_CLOSE_CODE, MIN_CLOSE_CODE};
use crate::frame::{Cancel, Close, ErrorResponse, Event, Hello, Request, Response};
use crate::validate::{
    MAX_ANNOUNCED_FRAME_BYTES, MAX_ANNOUNCED_IN_FLIGHT, MAX_CODE_CHARS, MAX_ID_CHARS,
    MAX_NAME_CHARS, MAX_REASON_CHARS, METHOD_NAME_PATTERN, MIN_ANNOUNCED_FRAME_BYTES,
    MIN_ANNOUNCED_IN_FLIGHT, MIN_NAME_CHARS,
};

/// The subschemas the specification states with `pattern`, `minLength`,
/// `maxLength`, `minimum` and `maximum`.
///
/// schemars derives a field's schema from its Rust type, which knows nothing of
/// those bounds — `id` would be a bare string and `close.code` a `u16` bounded
/// by `65535` rather than by `4999`. Each function here is attached to its
/// field with `#[schemars(schema_with = …)]` so the emission carries the same
/// constraints [`crate::validate`] enforces, from the same constants.
pub(crate) mod constraints {
    use super::{
        MAX_ANNOUNCED_FRAME_BYTES, MAX_ANNOUNCED_IN_FLIGHT, MAX_CLOSE_CODE, MAX_CODE_CHARS,
        MAX_ID_CHARS, MAX_NAME_CHARS, MAX_REASON_CHARS, METHOD_NAME_PATTERN,
        MIN_ANNOUNCED_FRAME_BYTES, MIN_ANNOUNCED_IN_FLIGHT, MIN_CLOSE_CODE, MIN_NAME_CHARS, Schema,
        SchemaGenerator, json_schema,
    };

    /// `req.id`, `res.id`, `err.id`, `cancel.id` and `evt.streamId`.
    pub(crate) fn id(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "string", "minLength": 1, "maxLength": MAX_ID_CHARS })
    }

    /// `req.method` and `evt.topic`.
    pub(crate) fn method_name(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "string",
            "minLength": MIN_NAME_CHARS,
            "maxLength": MAX_NAME_CHARS,
            "pattern": METHOD_NAME_PATTERN,
        })
    }

    /// `hello.peer.name` and `hello.peer.version`.
    pub(crate) fn peer_label(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "string", "minLength": 1, "maxLength": MAX_NAME_CHARS })
    }

    /// `hello.peer.role`.
    pub(crate) fn role(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "string",
            "minLength": 1,
            "maxLength": MAX_CODE_CHARS,
            "pattern": "^[a-z][a-z0-9-]*$",
        })
    }

    /// `err.error.code`.
    pub(crate) fn error_code(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "string",
            "minLength": 1,
            "maxLength": MAX_CODE_CHARS,
            "pattern": "^[A-Z][A-Z0-9_]*$",
        })
    }

    /// `err.error.message`.
    pub(crate) fn error_message(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "string", "minLength": 1 })
    }

    /// `hello.capabilities` and `err.error.details`: open objects.
    pub(crate) fn open_object(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "object" })
    }

    /// `hello.protocol.major`.
    pub(crate) fn major(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "integer", "minimum": 1 })
    }

    /// `hello.protocol.minor` and `evt.seq`.
    pub(crate) fn non_negative(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "integer", "minimum": 0 })
    }

    /// `hello.limits.maxFrameBytes`.
    pub(crate) fn max_frame_bytes(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "integer",
            "minimum": MIN_ANNOUNCED_FRAME_BYTES,
            "maximum": MAX_ANNOUNCED_FRAME_BYTES,
        })
    }

    /// `hello.limits.maxInFlight`.
    pub(crate) fn max_in_flight(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "integer",
            "minimum": MIN_ANNOUNCED_IN_FLIGHT,
            "maximum": MAX_ANNOUNCED_IN_FLIGHT,
        })
    }

    /// `close.code`.
    pub(crate) fn close_code(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "integer",
            "minimum": MIN_CLOSE_CODE,
            "maximum": MAX_CLOSE_CODE,
        })
    }

    /// `close.reason`.
    pub(crate) fn close_reason(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "string", "maxLength": MAX_REASON_CHARS })
    }

    /// `catalog.method.capabilities`: the capability names a method needs.
    pub(crate) fn capability_names(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "array",
            "items": { "type": "string", "minLength": 1 },
            "uniqueItems": true,
        })
    }

    /// `evt.end`: the literal `true`.
    pub(crate) fn end(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "boolean", "const": true })
    }
}

/// The `$defs` key the generator gives the catalog document's root type.
const CATALOG_ROOT: &str = "catalog";

/// Frame `$defs` keys that carry a payload, in the order `protocol.json` lists them.
const TAGGED_FRAMES: [&str; 7] = ["hello", "req", "res", "err", "evt", "cancel", "close"];
/// Frame `$defs` keys that are nothing but their tag.
const BARE_FRAMES: [&str; 2] = ["ping", "pong"];
/// Every frame `$defs` key, in the order `protocol.json` lists them.
const FRAME_ORDER: [&str; 9] = [
    "hello", "req", "res", "err", "evt", "cancel", "ping", "pong", "close",
];

/// The `type` member of a frame: a string fixed to the frame's tag.
fn tag_property(tag: &str) -> Value {
    json!({ "type": "string", "const": tag })
}

/// A frame whose only member is its tag, such as `ping`.
fn bare_frame(tag: &str) -> Value {
    json!({
        "type": "object",
        "required": ["type"],
        "properties": { "type": tag_property(tag) },
    })
}

/// Adds the `type` member to a derived frame schema, first in `required`.
fn add_tag(definitions: &mut Map<String, Value>, tag: &str) {
    let Some(Value::Object(frame)) = definitions.get_mut(tag) else {
        return;
    };
    let properties = frame
        .entry("properties")
        .or_insert_with(|| Value::Object(Map::new()));
    if let Value::Object(properties) = properties {
        properties.insert("type".to_owned(), tag_property(tag));
    }
    let existing = frame
        .get("required")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut required = vec![json!("type")];
    required.extend(existing.into_iter().filter(|name| name != "type"));
    frame.insert("required".to_owned(), Value::Array(required));
}

/// Emits the wire schema as one document keyed like `spec/schema/1/protocol.json`.
///
/// The result is `{"$defs": {…}}` with one entry per frame type, one per shared
/// object (`peer`, `limits`, `protocolVersion`, `errorPayload`) and a `frame`
/// entry that is a `oneOf` over every frame.
///
/// # Example
///
/// ```
/// use mango_protocol::schema::emit_schema;
///
/// let schema = emit_schema();
/// assert_eq!(schema["$defs"]["ping"]["properties"]["type"]["const"], "ping");
/// assert_eq!(schema["$defs"]["frame"]["oneOf"].as_array().unwrap().len(), 9);
/// ```
#[must_use]
pub fn emit_schema() -> Value {
    let mut generator = SchemaSettings::draft2020_12().into_generator();
    let _ = generator.subschema_for::<Hello>();
    let _ = generator.subschema_for::<Request>();
    let _ = generator.subschema_for::<Response>();
    let _ = generator.subschema_for::<ErrorResponse>();
    let _ = generator.subschema_for::<Event>();
    let _ = generator.subschema_for::<Cancel>();
    let _ = generator.subschema_for::<Close>();

    let mut definitions = generator.take_definitions(true);
    for tag in TAGGED_FRAMES {
        add_tag(&mut definitions, tag);
    }
    for tag in BARE_FRAMES {
        definitions.insert(tag.to_owned(), bare_frame(tag));
    }
    let branches: Vec<Value> = FRAME_ORDER
        .iter()
        .map(|tag| json!({ "$ref": format!("#/$defs/{tag}") }))
        .collect();
    definitions.insert("frame".to_owned(), json!({ "oneOf": branches }));

    json!({ "$defs": Value::Object(definitions) })
}

/// Emits the catalog schema as one document keyed like `spec/schema/1/catalog.json`.
///
/// The result is the catalog object itself — `type`, `required`, `properties` —
/// with a `$defs` member holding `method`, `event` and everything they
/// reference. It is a second document rather than more `$defs` on
/// [`emit_schema`]: the catalog describes a contract, not a frame, and the two
/// specification files are separate for the same reason.
///
/// # Example
///
/// ```
/// use mango_protocol::schema::emit_catalog_schema;
///
/// let schema = emit_catalog_schema();
/// assert_eq!(schema["required"], serde_json::json!(["name", "version", "methods"]));
/// assert_eq!(schema["$defs"]["method"]["properties"]["name"]["pattern"].is_string(), true);
/// ```
#[must_use]
pub fn emit_catalog_schema() -> Value {
    let mut generator = SchemaSettings::draft2020_12().into_generator();
    let _ = generator.subschema_for::<Catalog>();

    let mut definitions = generator.take_definitions(true);
    let Some(root) = definitions.remove(CATALOG_ROOT) else {
        let defined: Vec<&str> = definitions.keys().map(String::as_str).collect();
        panic!("the catalog emission defines {defined:?}; expected a {CATALOG_ROOT} entry")
    };
    let mut root = match root {
        Value::Object(object) => object,
        other => panic!("the {CATALOG_ROOT} definition is {other}; expected a JSON object"),
    };
    root.insert("$defs".to_owned(), Value::Object(definitions));
    Value::Object(root)
}

#[cfg(test)]
mod tests {
    use super::{FRAME_ORDER, emit_catalog_schema, emit_schema};
    use serde_json::{Map, Value, json};

    /// `spec/schema/1/protocol.json`, the normative document this emission mirrors.
    const SPEC: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../spec/schema/1/protocol.json"
    ));

    /// Keys a dialect adds that say nothing about the shape of a frame.
    const NOISE: [&str; 5] = ["description", "title", "format", "$comment", "$schema"];

    fn definitions() -> Value {
        emit_schema()["$defs"].clone()
    }

    /// The normaliser the repository's schema-equality check applies: inline
    /// every `$ref`, drop prose and `format`, drop `additionalProperties: true`,
    /// and strip the `null` alternative schemars adds to an `Option`.
    fn normalise(value: &Value, definitions: &Map<String, Value>) -> Value {
        match value {
            Value::Array(items) => Value::Array(
                items
                    .iter()
                    .map(|item| normalise(item, definitions))
                    .collect(),
            ),
            Value::Object(members) => {
                if let Some(Value::String(reference)) = members.get("$ref") {
                    let key = reference
                        .strip_prefix("#/$defs/")
                        .unwrap_or_else(|| panic!("received {reference}, expected a local $ref"));
                    let target = definitions
                        .get(key)
                        .unwrap_or_else(|| panic!("received $ref to {key}, which is not defined"));
                    return normalise(target, definitions);
                }
                let mut kept = Map::new();
                for (key, member) in members {
                    if NOISE.contains(&key.as_str()) {
                        continue;
                    }
                    if key == "additionalProperties" && member == &Value::Bool(true) {
                        continue;
                    }
                    kept.insert(key.clone(), normalise(member, definitions));
                }
                strip_null_alternative(kept)
            }
            other => other.clone(),
        }
    }

    /// `{"anyOf": [X, {"type": "null"}]}` is how schemars spells an absent member.
    fn strip_null_alternative(object: Map<String, Value>) -> Value {
        let Some(Value::Array(branches)) = object.get("anyOf") else {
            return Value::Object(object);
        };
        if object.len() != 1 || branches.len() != 2 {
            return Value::Object(object);
        }
        let null = json!({ "type": "null" });
        if branches[1] == null {
            return branches[0].clone();
        }
        if branches[0] == null {
            return branches[1].clone();
        }
        Value::Object(object)
    }

    /// Resolves a document's `frame` definition into one self-contained schema.
    fn flattened_frame(document: &Value) -> Value {
        let definitions = document["$defs"].as_object().expect("a $defs object");
        normalise(&definitions["frame"], definitions)
    }

    #[test]
    fn the_emission_equals_the_specification_after_normalisation() {
        let spec: Value = serde_json::from_str(SPEC).expect("the spec file is JSON");
        let emitted = flattened_frame(&emit_schema());
        let expected = flattened_frame(&spec);
        assert_eq!(
            emitted, expected,
            "the emission drifted from spec/schema/1/protocol.json"
        );
    }

    #[test]
    fn the_normaliser_only_removes_what_it_claims_to() {
        let definitions = Map::new();
        let kept = normalise(
            &json!({ "type": "string", "additionalProperties": false, "minLength": 1 }),
            &definitions,
        );
        assert_eq!(
            kept,
            json!({ "type": "string", "additionalProperties": false, "minLength": 1 })
        );
        let stripped = normalise(
            &json!({ "anyOf": [{ "type": "string" }, { "type": "null" }] }),
            &definitions,
        );
        assert_eq!(stripped, json!({ "type": "string" }));
        let two_real_branches = json!({ "anyOf": [{ "type": "string" }, { "type": "integer" }] });
        assert_eq!(
            normalise(&two_real_branches, &definitions),
            two_real_branches
        );
    }

    #[test]
    fn every_key_the_specification_names_is_present() {
        let defs = definitions();
        for key in FRAME_ORDER
            .iter()
            .chain(["errorPayload", "peer", "limits", "protocolVersion", "frame"].iter())
        {
            assert!(defs.get(*key).is_some(), "missing $defs/{key}");
        }
    }

    #[test]
    fn frame_is_a_one_of_over_every_frame_type() {
        let defs = definitions();
        let branches = defs["frame"]["oneOf"].as_array().expect("oneOf array");
        let refs: Vec<&str> = branches
            .iter()
            .map(|branch| branch["$ref"].as_str().expect("a $ref"))
            .collect();
        let expected: Vec<String> = FRAME_ORDER
            .iter()
            .map(|tag| format!("#/$defs/{tag}"))
            .collect();
        assert_eq!(refs, expected);
    }

    #[test]
    fn each_frame_requires_its_tag_first() {
        let defs = definitions();
        for tag in FRAME_ORDER {
            let frame = &defs[tag];
            assert_eq!(
                frame["properties"]["type"]["const"],
                Value::String(tag.into())
            );
            assert_eq!(
                frame["required"][0],
                Value::String("type".into()),
                "{tag} must require type first"
            );
        }
    }

    #[test]
    fn the_end_marker_is_a_boolean_fixed_to_true() {
        let evt = definitions()["evt"].clone();
        let text = serde_json::to_string(&evt["properties"]["end"]).expect("serialises");
        assert!(text.contains(r#""const":true"#), "{text}");
        assert!(text.contains(r#""boolean""#), "{text}");
    }

    #[test]
    fn shared_objects_are_referenced_rather_than_inlined() {
        let hello = definitions()["hello"].clone();
        assert_eq!(hello["properties"]["peer"]["$ref"], "#/$defs/peer");
        assert_eq!(
            hello["properties"]["protocol"]["$ref"],
            "#/$defs/protocolVersion"
        );
    }

    #[test]
    fn required_members_match_the_specification() {
        let defs = definitions();
        let required = |key: &str| -> Vec<String> {
            defs[key]["required"]
                .as_array()
                .expect("required array")
                .iter()
                .map(|name| name.as_str().expect("a string").to_owned())
                .collect()
        };
        assert_eq!(required("req"), ["type", "id", "method", "params"]);
        assert_eq!(required("res"), ["type", "id", "result"]);
        assert_eq!(required("err"), ["type", "id", "error"]);
        assert_eq!(required("evt"), ["type", "topic", "seq", "payload"]);
        assert_eq!(required("close"), ["type", "code"]);
        assert_eq!(
            required("hello"),
            ["type", "protocol", "peer", "capabilities"]
        );
    }

    #[test]
    fn the_catalog_emission_defines_its_method_and_event_and_refers_to_them() {
        let schema = emit_catalog_schema();
        assert!(
            schema["$defs"]["method"].is_object(),
            "missing $defs/method"
        );
        assert!(schema["$defs"]["event"].is_object(), "missing $defs/event");
        assert_eq!(
            schema["properties"]["methods"]["items"]["$ref"],
            "#/$defs/method"
        );
        assert_eq!(
            schema["properties"]["events"]["items"]["$ref"],
            "#/$defs/event"
        );
    }

    #[test]
    fn the_emission_is_a_json_object_with_only_defs() {
        let schema = emit_schema();
        let object = schema.as_object().expect("an object");
        assert_eq!(object.keys().collect::<Vec<_>>(), vec!["$defs"]);
    }
}
