//! Port of `apps/runtime/src/services/mcp/elicitation-schema.ts`: flattens an MCP form
//! `requestedSchema` into the hub's `McpElicitationField` descriptors. Only the primitive shapes
//! the elicitation spec allows are kept; anything else is skipped so the card stays renderable.

use serde_json::{Map, Value, json};

const FIELD_FORMATS: [&str; 4] = ["email", "uri", "date", "date-time"];

/// Converts a form `requestedSchema` into ordered field descriptors.
///
/// `order` is the property order as the server sent it (see `elicitation_order`); names it does
/// not mention follow in map order, so a missing order never drops a field.
///
/// # Example
/// ```ignore
/// let fields = flatten_elicitation_schema(&json!({"type": "object", "properties": {}}), None);
/// assert!(fields.is_empty());
/// ```
pub(crate) fn flatten_elicitation_schema(schema: &Value, order: Option<&[String]>) -> Vec<Value> {
    let Some(properties) = schema
        .as_object()
        .filter(|schema| schema.get("type") == Some(&json!("object")))
        .and_then(|schema| schema.get("properties"))
        .and_then(Value::as_object)
    else {
        return Vec::new();
    };
    let required = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|names| names.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    let mut names = order
        .unwrap_or_default()
        .iter()
        .filter(|name| properties.contains_key(name.as_str()))
        .map(String::as_str)
        .collect::<Vec<_>>();
    for name in properties.keys() {
        if !names.contains(&name.as_str()) {
            names.push(name);
        }
    }
    names
        .into_iter()
        .filter_map(|name| flatten_property(name, &properties[name], required.contains(&name)))
        .collect()
}

fn text<'a>(raw: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    raw.get(key).and_then(Value::as_str)
}

fn copy_number(raw: &Map<String, Value>, key: &str, field: &mut Map<String, Value>) {
    if let Some(value) = raw.get(key).filter(|value| value.is_number()) {
        field.insert(key.into(), value.clone());
    }
}

fn flatten_property(name: &str, raw: &Value, required: bool) -> Option<Value> {
    let raw = raw.as_object()?;
    let kind = text(raw, "type")?;
    let mut field = Map::new();
    field.insert("name".into(), json!(name));
    // The TypeScript host drops an empty title or description (a falsy string).
    if let Some(title) = text(raw, "title").filter(|title| !title.is_empty()) {
        field.insert("title".into(), json!(title));
    }
    if let Some(description) = text(raw, "description").filter(|value| !value.is_empty()) {
        field.insert("description".into(), json!(description));
    }
    field.insert("required".into(), json!(required));
    match kind {
        "boolean" => {
            field.insert("kind".into(), json!("boolean"));
            if let Some(default) = raw.get("default").filter(|value| value.is_boolean()) {
                field.insert("default".into(), default.clone());
            }
        }
        "number" | "integer" => {
            field.insert("kind".into(), json!(kind));
            for key in ["minimum", "maximum", "default"] {
                copy_number(raw, key, &mut field);
            }
        }
        "array" => return flatten_multi_enum(field, raw),
        "string" => flatten_string(&mut field, raw),
        _ => return None,
    }
    Some(Value::Object(field))
}

fn flatten_string(field: &mut Map<String, Value>, raw: &Map<String, Value>) {
    if let Some(options) = enum_options(raw) {
        field.insert("kind".into(), json!("enum"));
        field.insert("options".into(), json!(options));
        if let Some(default) = text(raw, "default") {
            field.insert("default".into(), json!(default));
        }
        return;
    }
    field.insert("kind".into(), json!("string"));
    if let Some(format) = text(raw, "format").filter(|format| FIELD_FORMATS.contains(format)) {
        field.insert("format".into(), json!(format));
    }
    for key in ["minLength", "maxLength"] {
        copy_number(raw, key, field);
    }
    if let Some(default) = text(raw, "default") {
        field.insert("default".into(), json!(default));
    }
}

fn flatten_multi_enum(mut field: Map<String, Value>, raw: &Map<String, Value>) -> Option<Value> {
    let items = raw.get("items")?.as_object()?;
    let options = enum_options(items).or_else(|| any_of_options(items))?;
    field.insert("kind".into(), json!("multi_enum"));
    field.insert("options".into(), json!(options));
    for key in ["minItems", "maxItems"] {
        copy_number(raw, key, &mut field);
    }
    if let Some(defaults) = raw.get("default").and_then(Value::as_array) {
        let defaults = defaults
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();
        field.insert("default".into(), json!(defaults));
    }
    Some(Value::Object(field))
}

fn enum_options(raw: &Map<String, Value>) -> Option<Vec<Value>> {
    let values = raw
        .get("enum")?
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();
    if values.is_empty() {
        return None;
    }
    let names = raw
        .get("enumNames")
        .and_then(Value::as_array)
        .map(|names| names.iter().filter_map(Value::as_str).collect::<Vec<_>>());
    Some(
        values
            .iter()
            .enumerate()
            .map(|(index, value)| {
                let label = names
                    .as_ref()
                    .and_then(|names| names.get(index))
                    .unwrap_or(value);
                json!({ "value": value, "label": label })
            })
            .collect(),
    )
}

fn any_of_options(raw: &Map<String, Value>) -> Option<Vec<Value>> {
    let options = raw
        .get("anyOf")?
        .as_array()?
        .iter()
        .filter_map(Value::as_object)
        .filter_map(|entry| {
            let value = text(entry, "const")?;
            let label = text(entry, "title").unwrap_or(value);
            Some(json!({ "value": value, "label": label }))
        })
        .collect::<Vec<_>>();
    (!options.is_empty()).then_some(options)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flattens_string_enum_multi_enum_number_and_boolean_fields() {
        let order = ["name", "tier", "tags", "age", "notify"].map(String::from);
        let fields = flatten_elicitation_schema(
            &json!({
                "type": "object",
                "required": ["name", "tier"],
                "properties": {
                    "name": { "type": "string", "title": "Name", "minLength": 1 },
                    "tier": { "type": "string", "enum": ["free", "pro"], "enumNames": ["Free", "Pro"], "default": "free" },
                    "tags": { "type": "array", "items": { "type": "string", "enum": ["a", "b"] } },
                    "age": { "type": "integer", "minimum": 0, "maximum": 120 },
                    "notify": { "type": "boolean", "default": true },
                },
            }),
            Some(&order),
        );
        assert_eq!(
            fields,
            vec![
                json!({ "name": "name", "title": "Name", "required": true, "kind": "string", "minLength": 1 }),
                json!({ "name": "tier", "required": true, "kind": "enum", "options": [{ "value": "free", "label": "Free" }, { "value": "pro", "label": "Pro" }], "default": "free" }),
                json!({ "name": "tags", "required": false, "kind": "multi_enum", "options": [{ "value": "a", "label": "a" }, { "value": "b", "label": "b" }] }),
                json!({ "name": "age", "required": false, "kind": "integer", "minimum": 0, "maximum": 120 }),
                json!({ "name": "notify", "required": false, "kind": "boolean", "default": true }),
            ]
        );
    }

    #[test]
    fn names_missing_from_the_recorded_order_still_appear() {
        let fields = flatten_elicitation_schema(
            &json!({ "type": "object", "properties": { "b": { "type": "string" }, "a": { "type": "string" } } }),
            Some(&["b".to_owned()]),
        );
        let names = fields
            .iter()
            .map(|field| field["name"].clone())
            .collect::<Vec<_>>();
        assert_eq!(names, vec![json!("b"), json!("a")]);
    }

    #[test]
    fn returns_an_empty_list_for_non_object_schemas() {
        assert!(flatten_elicitation_schema(&json!({ "type": "string" }), None).is_empty());
        assert!(flatten_elicitation_schema(&Value::Null, None).is_empty());
    }

    #[test]
    fn keeps_known_formats_and_any_of_options_and_skips_unsupported_types() {
        let order = ["email", "color", "picks", "nested"].map(String::from);
        let fields = flatten_elicitation_schema(
            &json!({
                "type": "object",
                "properties": {
                    "email": { "type": "string", "format": "email" },
                    "color": { "type": "string", "format": "color" },
                    "picks": { "type": "array", "items": { "anyOf": [{ "const": "x", "title": "Ex" }, { "const": "y" }] }, "minItems": 1 },
                    "nested": { "type": "object" },
                },
            }),
            Some(&order),
        );
        assert_eq!(
            fields,
            vec![
                json!({ "name": "email", "required": false, "kind": "string", "format": "email" }),
                json!({ "name": "color", "required": false, "kind": "string" }),
                json!({ "name": "picks", "required": false, "kind": "multi_enum", "options": [{ "value": "x", "label": "Ex" }, { "value": "y", "label": "y" }], "minItems": 1 }),
            ]
        );
    }
}
