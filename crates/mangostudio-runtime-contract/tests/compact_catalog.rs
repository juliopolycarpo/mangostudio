//! The build-derived catalog retains every JSON token and contract behavior.

#[path = "../build_support/compact_json.rs"]
mod compact_json;

const SOURCE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../apps/shared/src/runtime-contract/generated/catalog.json"
));
const EMBEDDED: &str = include_str!(concat!(env!("OUT_DIR"), "/catalog.compact.json"));

#[test]
fn compaction_preserves_lexemes_strings_escapes_and_non_json_whitespace() {
    let source = r#" {
      "number" : 1.2300e+04, "negativeZero": -0, "order" : 1,
      "string" : " spaces\t\n\r \\\" ", "unicode": "a\u0020b é　",
      "escapedQuote": "a\" b", "pair": "\\", "array": [true, null]
    } "#;
    // Deliberately keep the lexical forms a parse/serialize minifier changes.
    let expected = r#"{"number":1.2300e+04,"negativeZero":-0,"order":1,"string":" spaces\t\n\r \\\" ","unicode":"a\u0020b é　","escapedQuote":"a\" b","pair":"\\","array":[true,null]}"#;
    assert_eq!(compact_json::compact_json(source), expected);
    let source: serde_json::Value = serde_json::from_str(source).expect("valid source JSON");
    let compact: serde_json::Value = serde_json::from_str(expected).expect("valid compact JSON");
    assert_eq!(source, compact);
    assert_eq!(compact_json::compact_json("\u{a0} \t\r\n"), "\u{a0}");
}

#[test]
fn embedded_catalog_is_deterministic_idempotent_and_semantically_equal() {
    let compact = compact_json::compact_json(SOURCE);
    assert_eq!(EMBEDDED, compact);
    assert_eq!(compact_json::compact_json(&compact), compact);
    let source: mango_protocol::Catalog = serde_json::from_str(SOURCE).expect("canonical Catalog");
    let embedded: mango_protocol::Catalog =
        serde_json::from_str(EMBEDDED).expect("embedded Catalog");
    source.validate().expect("source validates");
    embedded.validate().expect("embedded validates");
    assert_eq!(source, embedded);
    assert_eq!(&embedded, mangostudio_runtime_contract::catalog::catalog());
}
