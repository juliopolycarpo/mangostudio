//! Result objects that take ownership of the values they carry.
//!
//! `serde_json::json!({"entries": entries})` serializes `&entries` into a new `Value` tree, so a
//! field that already holds a built `Value::Array` is deep-copied: every nested object, map and
//! string is allocated a second time and the first tree is dropped. The same goes for a `String`
//! field: `to_value(&string)` clones it. `fs.list-directory`, `fs.glob` and `fs.grep` carry up to
//! tens of thousands of entries, `fs.read-file` carries the file window, a mutation snapshot
//! carries the whole prior file in base64 and a terminal answer carries its scrollback, so those
//! copies doubled (or, for snapshots, quadrupled) the allocations and the peak memory of a call.
//! [`object`] moves the fields in instead. [`into_value`] does the same for a whole result:
//! `serde_json::to_value(value)` of a `Value` is a deep copy too, and every handler's answer
//! passes through it on its way out.

use std::any::Any;

use serde::Serialize;
use serde_json::Value;

/// `result` as a `Value`: moved as it is when it already is one, serialized otherwise.
///
/// `serde_json::to_value` has no shortcut for a `Value`, so a handler that returns the tree it
/// built had every entry of it allocated a second time. A typed result still serializes once.
///
/// # Example
///
/// ```ignore
/// let value = into_value(json!({"entries": [1, 2, 3]}))?; // no copy
/// let value = into_value(vec![1, 2, 3])?; // serialized
/// ```
pub(crate) fn into_value<R: Serialize + 'static>(result: R) -> serde_json::Result<Value> {
    let mut slot = Some(result);
    if let Some(value) = (&mut slot as &mut dyn Any).downcast_mut::<Option<Value>>() {
        return Ok(value.take().expect("the slot was filled just above"));
    }
    serde_json::to_value(slot.take().expect("the slot was filled just above"))
}

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

/// Asserts two values serialize to the same bytes. `Value` equality ignores key order, and the
/// runtime build keeps insertion order (`serde_json/preserve_order` is enabled through
/// `agent-client-protocol-schema`), so a reordered field changes the wire without failing `assert_eq!`.
#[cfg(test)]
macro_rules! assert_wire_eq {
    ($actual:expr, $expected:expr, $($message:tt)+) => {
        assert_eq!(
            serde_json::to_string(&$actual).expect("the actual value serializes"),
            serde_json::to_string(&$expected).expect("the expected value serializes"),
            $($message)+
        )
    };
}
#[cfg(test)]
pub(crate) use assert_wire_eq;

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
    fn a_value_result_keeps_the_buffer_it_was_built_in() {
        let entries = vec![json!({"name": "a"}), json!({"name": "b"})];
        let built_at = entries.as_ptr();

        let value = into_value(Value::Array(entries)).expect("a Value converts");

        let carried_at = value.as_array().expect("an array stays an array").as_ptr();
        assert_eq!(
            carried_at, built_at,
            "expected a Value result to be returned as built (buffer {built_at:p}) | \
             received a copy at {carried_at:p}"
        );
    }

    #[test]
    fn a_typed_result_is_serialized() {
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Answer {
            file_count: u32,
            names: Vec<&'static str>,
        }

        let value = into_value(Answer {
            file_count: 2,
            names: vec!["a", "b"],
        })
        .expect("a struct serializes");

        assert_eq!(
            value,
            json!({"fileCount": 2, "names": ["a", "b"]}),
            "expected the typed result as its serde form | received a different value"
        );
    }

    #[test]
    fn a_result_that_cannot_serialize_is_an_error_not_a_panic() {
        // A map keyed by something other than a string has no JSON form.
        let unserializable = std::collections::BTreeMap::from([((1, 2), "pair")]);

        assert!(into_value(unserializable).is_err());
    }

    #[test]
    #[should_panic(expected = "reordered")]
    fn the_wire_assertion_fails_on_a_reordered_field() {
        let built = object([("b", Value::from(1)), ("a", Value::from(2))]);

        assert_wire_eq!(built, json!({"a": 2, "b": 1}), "reordered");
    }

    #[test]
    fn an_object_keeps_the_order_its_fields_were_given_in() {
        let built = object([("b", Value::from(1)), ("a", Value::from(2))]);

        assert_eq!(
            built.to_string(),
            r#"{"b":1,"a":2}"#,
            "expected insertion order on the wire | received {built}"
        );
    }

    #[test]
    fn an_empty_field_list_is_an_empty_object() {
        assert_eq!(object([]), json!({}));
    }
}
