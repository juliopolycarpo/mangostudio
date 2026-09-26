//! Proves the dispatcher's central claim: an unknown method and a
//! known-but-unimplemented method answer byte-identical wire errors, and an
//! empty registry still answers `rpc.discover` with the whole catalog.

#[path = "support/mod.rs"]
mod support;

use std::sync::Arc;

use mango_protocol::error::codes;
use mangostudio_runtime::ports::authorization::DenyingAuthorization;
use mangostudio_runtime::registry::Registry;
use mangostudio_runtime_contract::catalog::catalog;
use serde_json::json;
use support::{serve_pair, within};

#[tokio::test]
async fn an_unknown_method_and_a_known_unimplemented_method_answer_byte_identical_errors() {
    let registry = Registry::new(); // implements nothing
    let (hub, _runtime) = serve_pair(registry, Arc::new(DenyingAuthorization)).await;

    let unknown = within(
        "a method no catalog declares",
        hub.request("no.such.method", json!({})),
    )
    .await
    .expect_err("no catalog anywhere declares this method");

    let unimplemented = within(
        "a declared but unimplemented method",
        hub.request("runtime.health", json!({})),
    )
    .await
    .expect_err("the catalog declares this method, but this registry never implemented it");

    assert_eq!(unknown.code, codes::METHOD_UNSUPPORTED);
    assert_eq!(unimplemented.code, codes::METHOD_UNSUPPORTED);
    assert_eq!(
        unknown.message,
        "Method \"no.such.method\" has no handler on this peer."
    );
    assert_eq!(
        unimplemented.message,
        "Method \"runtime.health\" has no handler on this peer."
    );

    let unknown_details = unknown.details.expect("details present");
    let unimplemented_details = unimplemented.details.expect("details present");
    assert_eq!(unknown_details.len(), 1);
    assert_eq!(unimplemented_details.len(), 1);
    assert_eq!(unknown_details["method"], json!("no.such.method"));
    assert_eq!(unimplemented_details["method"], json!("runtime.health"));
}

#[tokio::test]
async fn rpc_discover_still_answers_the_full_catalog_with_an_empty_registry() {
    let registry = Registry::new();
    let (hub, _runtime) = serve_pair(registry, Arc::new(DenyingAuthorization)).await;

    let discovered = within("rpc.discover", hub.request("rpc.discover", json!({})))
        .await
        .expect("rpc.discover always answers, regardless of what this registry implements");
    assert_eq!(discovered["name"], json!("mangostudio.runtime"));
    let methods = discovered["methods"].as_array().expect("a methods array");
    assert_eq!(methods.len(), catalog().methods.len());
}
