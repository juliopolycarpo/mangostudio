//! The catalog document (§12): an application's methods, events and capabilities.
//!
//! A catalog is a description, not a wire message. SDKs use it to type clients
//! and validate handlers; a peer may publish it through an application method.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::frame::present;
use crate::validate::{MAX_NAME_CHARS, ValidationError, is_valid_method_name};
use crate::version::ProtocolVersion;

/// One method a contract offers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "schema", schemars(rename = "method"))]
pub struct CatalogMethod {
    /// The method name, in the grammar of §6.1.
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::schema::constraints::method_name")
    )]
    pub name: String,
    /// Prose for a human reading the contract.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present::option"
    )]
    pub description: Option<String>,
    /// JSON Schema 2020-12 document for `req.params`.
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::schema::constraints::open_object")
    )]
    pub params: Value,
    /// JSON Schema 2020-12 document for `res.result`.
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::schema::constraints::open_object")
    )]
    pub result: Value,
    /// Members of `hello.capabilities` the responder requires before serving this method.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::schema::constraints::capability_names")
    )]
    pub capabilities: Vec<String>,
    /// True when the contract still serves the method but callers should move off it.
    #[serde(default, skip_serializing_if = "is_default_flag")]
    pub deprecated: bool,
}

/// True when a flag is at the value the wire leaves absent rather than stating.
fn is_default_flag(flag: &bool) -> bool {
    !*flag
}

/// One event topic a contract emits.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "schema", schemars(rename = "event"))]
pub struct CatalogEvent {
    /// The topic, in the grammar of §6.1.
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::schema::constraints::method_name")
    )]
    pub topic: String,
    /// Prose for a human reading the contract.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present::option"
    )]
    pub description: Option<String>,
    /// JSON Schema 2020-12 document for `evt.payload`.
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::schema::constraints::open_object")
    )]
    pub payload: Value,
    /// True when events on this topic carry a `streamId` and an `end` marker.
    #[serde(default, skip_serializing_if = "is_default_flag")]
    pub stream: bool,
}

/// An application contract, conforming to `spec/schema/1/catalog.json`.
///
/// # Example
///
/// ```
/// use mango_protocol::Catalog;
///
/// let catalog: Catalog = serde_json::from_str(
///     r#"{"name":"c","version":"1.0.0","methods":[]}"#,
/// )
/// .unwrap();
/// assert!(catalog.events.is_empty());
/// assert!(catalog.validate().is_ok());
/// ```
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "schema", schemars(rename = "catalog"))]
pub struct Catalog {
    /// Contract name, 1 to 128 characters.
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::schema::constraints::peer_label")
    )]
    pub name: String,
    /// Contract version, 1 to 128 characters, opaque to the protocol.
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::schema::constraints::peer_label")
    )]
    pub version: String,
    /// Prose for a human reading the contract.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present::option"
    )]
    pub description: Option<String>,
    /// The lowest wire version the contract needs.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present::option"
    )]
    pub protocol: Option<ProtocolVersion>,
    /// Every method the contract offers.
    pub methods: Vec<CatalogMethod>,
    /// Every event topic the contract emits; a missing member reads as none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub events: Vec<CatalogEvent>,
    /// JSON Schema of the `hello.capabilities` object this contract expects.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present::option"
    )]
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::schema::constraints::open_object")
    )]
    pub capabilities: Option<Value>,
}

impl Catalog {
    /// Checks the rules the catalog schema states and serde cannot.
    ///
    /// Every method name and event topic must match the grammar of §6.1; the
    /// contract's own name and version must be 1 to [`MAX_NAME_CHARS`]
    /// characters; every embedded schema document (`params`, `result`,
    /// `payload`, `capabilities`) must be an object; and a method's required
    /// capability names must be non-empty and distinct. Each of those is a
    /// catalog.json rule the Rust types alone cannot express, and each is
    /// enforced by the TypeScript `assertCatalog`, so a catalog that passes
    /// here is one both SDKs will read.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::Catalog;
    ///
    /// let catalog: Catalog = serde_json::from_str(
    ///     r#"{"name":"c","version":"1","methods":[{"name":"bad","params":{},"result":{}}]}"#,
    /// )
    /// .unwrap();
    /// assert_eq!(catalog.validate().unwrap_err().field, "catalog.methods[0].name");
    /// ```
    pub fn validate(&self) -> Result<(), ValidationError> {
        check_name("catalog.name", &self.name)?;
        check_name("catalog.version", &self.version)?;
        for (index, method) in self.methods.iter().enumerate() {
            check_grammar(&format!("catalog.methods[{index}].name"), &method.name)?;
            check_document(&format!("catalog.methods[{index}].params"), &method.params)?;
            check_document(&format!("catalog.methods[{index}].result"), &method.result)?;
            check_capabilities(
                &format!("catalog.methods[{index}].capabilities"),
                &method.capabilities,
            )?;
        }
        for (index, event) in self.events.iter().enumerate() {
            check_grammar(&format!("catalog.events[{index}].topic"), &event.topic)?;
            check_document(&format!("catalog.events[{index}].payload"), &event.payload)?;
        }
        if let Some(capabilities) = &self.capabilities {
            check_document("catalog.capabilities", capabilities)?;
        }
        Ok(())
    }
}

fn check_name(field: &str, value: &str) -> Result<(), ValidationError> {
    let count = value.chars().count();
    if (1..=MAX_NAME_CHARS).contains(&count) {
        return Ok(());
    }
    Err(ValidationError {
        field: field.to_owned(),
        received: format!("a string of {count} characters"),
        expected: format!("a string of 1 to {MAX_NAME_CHARS} characters"),
    })
}

/// Every schema document a catalog carries — `params`, `result`, `payload`,
/// `capabilities` — is an object: `#/$defs/schema` in catalog.json says so, and
/// serde cannot express it because the member is a bare `Value`.
///
/// JSON Schema itself also accepts a bare `true`/`false`, and so does the
/// compiler behind [`crate::contract::Contract`], so this is the rule that
/// keeps a Rust-built catalog from publishing a document the TypeScript SDK's
/// `assertCatalog` refuses to read.
fn check_document(field: &str, document: &Value) -> Result<(), ValidationError> {
    if document.is_object() {
        return Ok(());
    }
    Err(ValidationError {
        field: field.to_owned(),
        received: describe_json(document),
        expected: "a JSON Schema 2020-12 document, which catalog.json requires to be an object"
            .to_string(),
    })
}

/// A method's required capability names are non-empty and distinct:
/// `#/$defs/method.capabilities` in catalog.json is an array of `minLength: 1`
/// strings with `uniqueItems: true`. The `schemars` helper emits that
/// constraint for the generated schema, but nothing applies it to a catalog
/// built or deserialised at runtime — so, like [`check_document`], this is
/// what stops a Rust-built catalog naming a capability the TypeScript
/// `assertCatalog` refuses.
///
/// The quadratic scan is deliberate: these lists are a handful of names, and a
/// `HashSet` here would cost more than it saves while losing the index of the
/// duplicate the error reports.
fn check_capabilities(field: &str, names: &[String]) -> Result<(), ValidationError> {
    for (index, name) in names.iter().enumerate() {
        if name.is_empty() {
            return Err(ValidationError {
                field: format!("{field}[{index}]"),
                received: "an empty string".to_string(),
                expected: "a capability name of at least one character".to_string(),
            });
        }
        if names[..index].contains(name) {
            return Err(ValidationError {
                field: format!("{field}[{index}]"),
                received: format!("{name:?}, already named earlier in the list"),
                expected: "a capability name distinct from every other in the list".to_string(),
            });
        }
    }
    Ok(())
}

/// Names a value's JSON type for an error message, with the value itself when
/// it is small enough to be worth quoting.
fn describe_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(value) => format!("the boolean {value}"),
        Value::Number(value) => format!("the number {value}"),
        Value::String(_) => "a string".to_string(),
        Value::Array(values) => format!("an array of {} items", values.len()),
        Value::Object(_) => "an object".to_string(),
    }
}

fn check_grammar(field: &str, value: &str) -> Result<(), ValidationError> {
    if is_valid_method_name(value) {
        return Ok(());
    }
    Err(ValidationError {
        field: field.to_owned(),
        received: format!("{value:?}"),
        expected: format!(
            "at least two dot-separated lowercase segments, at most {MAX_NAME_CHARS} characters"
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::{Catalog, CatalogEvent, CatalogMethod};
    use crate::version::ProtocolVersion;
    use serde_json::{Value, json};

    fn sample() -> Catalog {
        Catalog {
            name: "fixture-contract".into(),
            version: "1.0.0".into(),
            description: None,
            protocol: Some(ProtocolVersion::new(1, 0)),
            methods: vec![CatalogMethod {
                name: "text.echo".into(),
                description: None,
                params: json!({ "type": "object" }),
                result: json!({ "type": "object" }),
                capabilities: vec!["echo".into()],
                deprecated: false,
            }],
            events: vec![CatalogEvent {
                topic: "text.stream".into(),
                description: None,
                payload: json!({ "type": "object" }),
                stream: true,
            }],
            capabilities: Some(json!({ "type": "object" })),
        }
    }

    #[test]
    fn a_well_formed_catalog_validates() {
        assert!(sample().validate().is_ok());
    }

    #[test]
    fn missing_events_deserialise_as_none_and_defaults_fill_in() {
        let catalog: Catalog = serde_json::from_str(
            r#"{"name":"c","version":"1.0.0","methods":[{"name":"a.b","params":{},"result":{}}]}"#,
        )
        .expect("decodes");
        assert!(catalog.events.is_empty());
        assert!(catalog.methods[0].capabilities.is_empty());
        assert!(!catalog.methods[0].deprecated);
        assert_eq!(catalog.protocol, None);
    }

    #[test]
    fn an_emptied_collection_is_not_serialised() {
        let mut catalog = sample();
        catalog.events.clear();
        catalog.methods[0].capabilities.clear();
        let value: Value = serde_json::to_value(&catalog).expect("serialises");
        assert!(value.get("events").is_none(), "{value}");
        assert!(value["methods"][0].get("capabilities").is_none(), "{value}");
    }

    #[test]
    fn an_absent_optional_is_not_serialised_and_null_is_refused() {
        let value: Value = serde_json::to_value(sample()).expect("serialises");
        assert!(value.get("description").is_none());
        let error = serde_json::from_str::<Catalog>(
            r#"{"name":"c","version":"1","methods":[],"description":null}"#,
        )
        .expect_err("null description is refused");
        assert!(error.to_string().contains("null"), "{error}");
    }

    #[test]
    fn a_single_segment_method_name_is_refused() {
        let mut catalog = sample();
        catalog.methods[0].name = "bad".into();
        let error = catalog.validate().expect_err("single segment");
        assert_eq!(error.field, "catalog.methods[0].name");
        assert!(error.expected.contains("two dot-separated"), "{error}");
    }

    #[test]
    fn a_bad_event_topic_is_refused() {
        let mut catalog = sample();
        catalog.events[0].topic = "Topic".into();
        assert_eq!(
            catalog.validate().expect_err("bad topic").field,
            "catalog.events[0].topic"
        );
    }

    /// `#/$defs/schema` in catalog.json is `{"type": "object"}`, and the
    /// TypeScript SDK's `assertCatalog` enforces it. JSON Schema itself also
    /// allows a bare `true`/`false`, so without this check a Rust-built
    /// catalog could publish a document the other SDK refuses to read.
    #[test]
    fn a_schema_document_that_is_not_an_object_is_refused() {
        for (field, mutate) in [
            (
                "catalog.methods[0].params",
                Box::new(|catalog: &mut Catalog| catalog.methods[0].params = json!(true))
                    as Box<dyn Fn(&mut Catalog)>,
            ),
            (
                "catalog.methods[0].result",
                Box::new(|catalog: &mut Catalog| catalog.methods[0].result = json!([])),
            ),
            (
                "catalog.events[0].payload",
                Box::new(|catalog: &mut Catalog| catalog.events[0].payload = json!("object")),
            ),
            (
                "catalog.capabilities",
                Box::new(|catalog: &mut Catalog| catalog.capabilities = Some(Value::Null)),
            ),
        ] {
            let mut catalog = sample();
            mutate(&mut catalog);
            let Err(error) = catalog.validate() else {
                panic!("expected {field} to be refused | received: a valid catalog")
            };
            assert_eq!(error.field, field);
            assert!(
                error.expected.contains("object"),
                "expected the refusal to name the shape catalog.json requires | received: {}",
                error.expected
            );
        }
    }

    /// `#/$defs/method.capabilities` in catalog.json is an array of non-empty
    /// strings with `uniqueItems: true`, and the TypeBox mirror says the same.
    /// The schemars helper emits the constraint but nothing enforced it, so a
    /// Rust-built catalog could publish a list the TypeScript SDK refuses.
    #[test]
    fn an_empty_or_duplicate_capability_name_is_refused() {
        for names in [vec![String::new()], vec!["echo".into(), "echo".into()]] {
            let mut catalog = sample();
            let last = names.len() - 1;
            catalog.methods[0].capabilities = names.clone();
            let Err(error) = catalog.validate() else {
                panic!("expected {names:?} to be refused | received: a valid catalog")
            };
            assert_eq!(
                error.field,
                format!("catalog.methods[0].capabilities[{last}]")
            );
        }
    }

    #[test]
    fn an_empty_contract_name_is_refused() {
        let mut catalog = sample();
        catalog.name = String::new();
        assert_eq!(
            catalog.validate().expect_err("empty name").field,
            "catalog.name"
        );
    }

    #[test]
    fn keeps_absent_optional_members_absent() {
        let text =
            r#"{"name":"c","version":"1.0.0","methods":[{"name":"a.b","params":{},"result":{}}]}"#;
        let catalog: Catalog = serde_json::from_str(text).expect("deserialises");

        assert_eq!(
            serde_json::to_string(&catalog).expect("serialises"),
            text,
            "an optional member absent on the wire is absent again when re-serialised"
        );
    }

    #[test]
    fn round_trips_through_json() {
        let text = serde_json::to_string(&sample()).expect("serialises");
        let back: Catalog = serde_json::from_str(&text).expect("deserialises");
        assert_eq!(back, sample());
    }
}
