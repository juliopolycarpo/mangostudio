//! Result objects that take ownership of the values they carry.
//!
//! `serde_json::json!({"entries": entries})` serializes `&entries` into a new `Value` tree, so a
//! field that already holds a built `Value::Array` is deep-copied: every nested object, map and
//! string is allocated a second time and the first tree is dropped. The same goes for a `String`
//! field: `to_value(&string)` clones it. `fs.list-directory`, `fs.glob` and `fs.grep` carry up to
//! tens of thousands of entries, `fs.read-file` carries the file window, a mutation snapshot
//! carries the whole prior file in base64 and a terminal answer carries its scrollback, so those
//! copies doubled (or, for snapshots, quadrupled) the allocations and the peak memory of a call.
//! [`object`] moves the fields in instead.

use serde_json::Value;

/// A JSON object from `fields` with each value moved in rather than copied.
///
/// # Example
///
/// ```ignore
/// let entries = vec![json!({"name": "a", "type": "file"})];
/// let result = object([("path", Value::from(".")), ("entries", Value::Array(entries))]);
/// assert_eq!(result["entries"][0]["name"], "a");
/// ```
pub(crate) fn object(fields: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    Value::Object(
        fields
            .into_iter()
            .map(|(name, value)| (name.to_owned(), value))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn an_array_field_keeps_the_buffer_it_was_built_in() {
        let entries = vec![json!({"name": "a", "type": "file"}), json!({"name": "b"})];
        let built_at = entries.as_ptr();

        let result = object([
            ("path", Value::from(".")),
            ("entries", Value::Array(entries)),
        ]);

        let carried_at = result["entries"]
            .as_array()
            .expect("the entries field is an array")
            .as_ptr();
        assert_eq!(
            carried_at, built_at,
            "expected the entries array to be moved into the object (buffer {built_at:p}) | \
             received a copy at {carried_at:p}"
        );
    }

    #[test]
    fn every_field_keeps_its_value() {
        let result = object([
            ("pattern", Value::from("a.*")),
            ("matches", Value::Array(vec![json!({"line": 1})])),
            ("truncated", Value::Bool(false)),
        ]);

        assert_eq!(
            result,
            json!({"pattern": "a.*", "matches": [{"line": 1}], "truncated": false}),
            "expected every field to carry its value | received a different object"
        );
    }

    #[test]
    fn an_empty_field_list_is_an_empty_object() {
        assert_eq!(object([]), json!({}));
    }
}
