//! Prints the crate's catalog schema emission to stdout, for the schema-equality check.
//!
//! ```text
//! cargo run --example emit_catalog_schema --features schema
//! ```

fn main() {
    let schema = mango_protocol::schema::emit_catalog_schema();
    println!(
        "{}",
        serde_json::to_string_pretty(&schema).expect("the emission serialises")
    );
}
