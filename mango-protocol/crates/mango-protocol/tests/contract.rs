//! Mirrors `packages/protocol/tests/contract.test.ts`'s `defineContract`
//! describe block in full: the three definition-time/catalog cases that
//! need no session, and the five that serve, call and stream a contract
//! over one. `test(rs): mirror the TypeScript contract test suite` is
//! absorbed here rather than landing as a separate commit, the same way
//! the session suite's own dedicated commit was.
#![cfg(feature = "tokio")]

mod support;

use std::sync::Arc;

use mango_protocol::catalog::{Catalog, CatalogEvent, CatalogMethod};
use mango_protocol::contract::{Contract, ContractHandlers, EventOptions, ServeOptions};
use mango_protocol::error::codes;
use mango_protocol::frame::PeerInfo;
use mango_protocol::port::port_pair;
use mango_protocol::session::{Session, SessionOptions};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use support::{RecordingGuard, within};

fn method(
    name: &str,
    params: Value,
    result: Value,
    capabilities: Vec<String>,
    description: Option<&str>,
) -> CatalogMethod {
    CatalogMethod {
        name: name.into(),
        description: description.map(str::to_string),
        params,
        result,
        capabilities,
        deprecated: false,
    }
}

/// The same contract `packages/protocol/tests/contract.test.ts` defines:
/// `text.echo` and `math.add`, events `text.tick` and a streamed
/// `text.stream`, a capability schema, and an explicit protocol floor.
fn example() -> Contract {
    Contract::builder("example", "1.2.3")
        .description("Test contract")
        .protocol(mango_protocol::version::ProtocolVersion::new(1, 0))
        .capabilities(json!({ "type": "object", "properties": { "echo": { "type": "boolean" } } }))
        .method(method(
            "text.echo",
            json!({ "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] }),
            json!({ "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] }),
            vec!["echo".into()],
            Some("Echoes text"),
        ))
        .method(method(
            "math.add",
            json!({
                "type": "object",
                "properties": { "a": { "type": "number" }, "b": { "type": "number" } },
                "required": ["a", "b"],
            }),
            json!({ "type": "number" }),
            vec![],
            None,
        ))
        .event(CatalogEvent {
            topic: "text.tick".into(),
            description: None,
            payload: json!({ "type": "object", "properties": { "at": { "type": "number" } } }),
            stream: false,
        })
        .event(CatalogEvent {
            topic: "text.stream".into(),
            description: None,
            payload: json!({ "type": "object", "properties": { "line": { "type": "string" } } }),
            stream: true,
        })
        .build()
        .expect("a valid contract")
}

#[test]
fn rejects_invalid_or_reserved_names_at_definition_time() {
    Contract::builder("x", "1")
        .method(method("nodots", json!({}), json!({}), vec![], None))
        .build()
        .expect_err("a single segment is not a method name");

    let reserved = Contract::builder("x", "1")
        .method(method("rpc.discover", json!({}), json!({}), vec![], None))
        .build()
        .expect_err("rpc. is reserved");
    assert!(reserved.expected.contains("reserved"), "{reserved}");
}

#[test]
fn emits_a_plain_json_catalog_that_validates() {
    let catalog = example().catalog();
    assert_eq!(catalog.name, "example");
    assert_eq!(
        catalog
            .methods
            .iter()
            .map(|m| m.name.as_str())
            .collect::<Vec<_>>(),
        vec!["text.echo", "math.add"]
    );
    assert_eq!(catalog.methods[0].capabilities, vec!["echo".to_string()]);
    assert_eq!(
        catalog
            .events
            .iter()
            .map(|e| e.topic.as_str())
            .collect::<Vec<_>>(),
        vec!["text.tick", "text.stream"]
    );
    assert!(catalog.validate().is_ok());

    // "plain JSON": a round trip through serde_json changes nothing.
    let round_tripped: Value =
        serde_json::from_str(&serde_json::to_string(&catalog).expect("serialises"))
            .expect("deserialises");
    assert_eq!(
        round_tripped,
        serde_json::to_value(&catalog).expect("serialises")
    );
}

#[derive(Debug, Serialize, Deserialize)]
struct EchoParams {
    text: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct AddParams {
    a: f64,
    b: f64,
}

#[test]
fn assert_params_narrows_or_throws() {
    let contract = example();
    contract
        .parse_params::<EchoParams>("text.echo", json!({ "text": "ok" }))
        .expect("a matching value narrows");
    contract
        .parse_params::<EchoParams>("text.echo", json!({ "text": 1 }))
        .expect_err("a number is not the declared string");
}

#[test]
fn from_catalog_compiles_a_catalog_a_peer_published() {
    let catalog = example().catalog();
    let recompiled = Contract::from_catalog(catalog.clone()).expect("the same catalog recompiles");
    assert_eq!(recompiled.catalog(), catalog);
}

#[test]
fn from_catalog_refuses_a_reserved_method_name() {
    let catalog = Catalog {
        name: "x".into(),
        version: "1".into(),
        description: None,
        protocol: None,
        methods: vec![method("rpc.discover", json!({}), json!({}), vec![], None)],
        events: vec![],
        capabilities: None,
    };
    let error = Contract::from_catalog(catalog).expect_err("rpc. is reserved");
    assert!(error.expected.contains("reserved"), "{error}");
}

/// `spec/fixtures/1/catalog-example.json`, generated by `scripts/fixtures/
/// generate-catalog-example.ts` from the `example.files` contract in
/// `docs/build-a-contract.md` — the same document `contract.test.ts` reads
/// back on the TypeScript side, so both SDKs agree on one real catalog.
const CATALOG_EXAMPLE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../spec/fixtures/1/catalog-example.json"
));

#[test]
fn from_catalog_compiles_the_shared_example_fixture() {
    let catalog: Catalog =
        serde_json::from_str(CATALOG_EXAMPLE).expect("the fixture is a valid catalog document");
    let contract =
        Contract::from_catalog(catalog).expect("the shared fixture compiles as a contract");
    let catalog = contract.catalog();
    assert_eq!(catalog.name, "example.files");
    assert_eq!(
        catalog
            .methods
            .iter()
            .map(|method| method.name.as_str())
            .collect::<Vec<_>>(),
        vec!["fs.read-file", "fs.watch"]
    );
    assert_eq!(catalog.methods[0].capabilities, vec!["fs.read".to_string()]);
    assert_eq!(
        catalog
            .events
            .iter()
            .map(|event| event.topic.as_str())
            .collect::<Vec<_>>(),
        vec!["fs.changed"]
    );
}

fn peer(role: &str) -> PeerInfo {
    PeerInfo {
        name: "test".into(),
        version: "1".into(),
        role: role.into(),
    }
}

/// A ready-to-use pair, mirroring the TS suite's own `sessions()` helper.
async fn sessions() -> (Session, Session) {
    let (a, b) = port_pair();
    let (session_a, _driver_a) = Session::spawn(a, SessionOptions::new(peer("hub")));
    let (session_b, _driver_b) = Session::spawn(b, SessionOptions::new(peer("runtime")));
    within("a's ready()", session_a.ready())
        .await
        .expect("handshake succeeds");
    within("b's ready()", session_b.ready())
        .await
        .expect("handshake succeeds");
    (session_a, session_b)
}

/// The `text.echo`/`math.add` handlers every TS `contract.serve(b, {...})`
/// call registers, unmodified.
fn plain_handlers() -> ContractHandlers {
    ContractHandlers::new()
        .on("text.echo", |params: EchoParams, _context| async move {
            Ok::<_, mango_protocol::error::RemoteError>(params)
        })
        .on("math.add", |params: AddParams, _context| async move {
            Ok::<_, mango_protocol::error::RemoteError>(params.a + params.b)
        })
}

#[tokio::test]
async fn serves_typed_handlers_and_requests_through_a_typed_client() {
    let (session_a, session_b) = sessions().await;
    let contract = example();
    let guard = contract
        .serve(&session_b, plain_handlers(), ServeOptions::default())
        .expect("both methods are declared");

    let client = contract.client(&session_a);
    let echoed: EchoParams = within(
        "text.echo",
        client.request("text.echo", EchoParams { text: "hi".into() }),
    )
    .await
    .expect("text.echo succeeds");
    assert_eq!(echoed.text, "hi");

    let sum: f64 = within(
        "math.add",
        client.request("math.add", AddParams { a: 2.0, b: 3.0 }),
    )
    .await
    .expect("math.add succeeds");
    assert_eq!(sum, 5.0);

    drop(guard);
    let error = within(
        "math.add after the guard dropped",
        client.request::<AddParams, f64>("math.add", AddParams { a: 1.0, b: 1.0 }),
    )
    .await
    .expect_err("the handler was unregistered");
    assert_eq!(error.code, codes::METHOD_UNSUPPORTED);
}

#[tokio::test]
async fn answers_rpc_discover_with_the_served_catalog() {
    let (session_a, session_b) = sessions().await;
    let contract = example();
    let guard = contract
        .serve(&session_b, plain_handlers(), ServeOptions::default())
        .expect("both methods are declared");

    let discovered = within("rpc.discover", contract.client(&session_a).discover())
        .await
        .expect("the peer serves a contract");
    assert_eq!(discovered, contract.catalog());
    // The peer's document, compiled with the same checks a contract built
    // here passes, before a caller acts on it.
    Contract::from_catalog(discovered).expect("the peer's catalog compiles");

    // Unregistered with the rest: a peer that stopped serving stops answering.
    drop(guard);
    let error = within(
        "rpc.discover after the guard dropped",
        contract.client(&session_a).discover(),
    )
    .await
    .expect_err("the handler was unregistered");
    assert_eq!(error.code, codes::METHOD_UNSUPPORTED);
}

/// §6.4 defines `rpc.discover`'s parameters as an object; a raw request that
/// sends anything else (here `null`) must not reach the catalog.
#[tokio::test]
async fn rpc_discover_refuses_non_object_params() {
    let (session_a, session_b) = sessions().await;
    let contract = example();
    let _guard = contract
        .serve(&session_b, plain_handlers(), ServeOptions::default())
        .expect("both methods are declared");

    let error = within(
        "rpc.discover with null params",
        session_a.request(mango_protocol::validate::RPC_DISCOVER, json!(null)),
    )
    .await
    .expect_err("null is not an object");
    assert_eq!(error.code, codes::INVALID_PARAMS);
}

/// A peer's `rpc.discover` answer can decode into `Catalog` through Serde and
/// still violate constraints Serde cannot express — an invalid method name,
/// here. The client checks it with the same [`Catalog::validate`] the
/// TypeScript SDK's `assertCatalog` runs, rather than handing the caller a
/// document [`Contract::from_catalog`] would refuse.
#[tokio::test]
async fn client_discover_refuses_a_catalog_that_fails_validation() {
    let (session_a, session_b) = sessions().await;
    let bad_catalog = json!({
        "name": "c",
        "version": "1",
        "methods": [{ "name": "bad", "params": {}, "result": {} }],
    });
    let _guard = session_b.handle(
        mango_protocol::validate::RPC_DISCOVER,
        move |_params, _context| {
            let bad_catalog = bad_catalog.clone();
            async move { Ok(bad_catalog) }
        },
    );

    let contract = example();
    let error = within(
        "rpc.discover with an invalid catalog",
        contract.client(&session_a).discover(),
    )
    .await
    .expect_err("\"bad\" is not a dotted method name");
    assert_eq!(error.code, codes::INTERNAL);
}

#[tokio::test]
async fn leaves_rpc_discover_unanswered_when_the_catalog_is_not_offered() {
    let (session_a, session_b) = sessions().await;
    let contract = example();
    let options = ServeOptions {
        discover: false,
        ..Default::default()
    };
    contract
        .serve(&session_b, plain_handlers(), options)
        .expect("both methods are declared")
        .persist();

    let error = within("rpc.discover", contract.client(&session_a).discover())
        .await
        .expect_err("this peer does not publish its catalog");
    assert_eq!(error.code, codes::METHOD_UNSUPPORTED);

    // Opting out of the catalog does not opt out of the contract.
    let sum: f64 = within(
        "math.add",
        contract
            .client(&session_a)
            .request("math.add", AddParams { a: 2.0, b: 3.0 }),
    )
    .await
    .expect("the contract is still served");
    assert_eq!(sum, 5.0);
}

#[tokio::test]
async fn serve_guard_persist_keeps_the_handlers_after_the_guard_is_dropped() {
    let (session_a, session_b) = sessions().await;
    let contract = example();
    contract
        .serve(&session_b, plain_handlers(), ServeOptions::default())
        .expect("both methods are declared")
        .persist();

    let sum: f64 = within(
        "math.add after persist",
        contract
            .client(&session_a)
            .request("math.add", AddParams { a: 2.0, b: 3.0 }),
    )
    .await
    .expect("persist kept the handler registered with no guard left to drop");
    assert_eq!(sum, 5.0);
}

#[tokio::test]
async fn serve_refuses_a_handler_for_a_method_the_contract_does_not_declare() {
    let (_session_a, session_b) = sessions().await;
    let contract = example();
    let handlers =
        ContractHandlers::new().on("math.multiply", |params: AddParams, _context| async move {
            Ok::<_, mango_protocol::error::RemoteError>(params.a * params.b)
        });

    let error = contract
        .serve(&session_b, handlers, ServeOptions::default())
        .err()
        .expect("math.multiply is not part of the example contract");
    assert_eq!(error.field, "handlers");
    assert_eq!(error.received, "math.multiply");
}

#[tokio::test]
async fn refuses_parameters_that_fail_the_schema_with_invalid_params_and_a_path() {
    let (session_a, session_b) = sessions().await;
    let contract = example();
    let _guard = contract
        .serve(&session_b, plain_handlers(), ServeOptions::default())
        .expect("both methods are declared");

    let error = within(
        "math.add with a bad param",
        session_a.request("math.add", json!({ "a": "one", "b": 2 })),
    )
    .await
    .expect_err("a string is not a number");
    assert_eq!(error.code, codes::INVALID_PARAMS);
    assert_eq!(
        error.details.as_ref().and_then(|d| d.get("method")),
        Some(&json!("math.add"))
    );
    assert_eq!(
        error.details.as_ref().and_then(|d| d.get("path")),
        Some(&json!("/a"))
    );
}

#[tokio::test]
async fn runs_the_guard_with_the_declared_capabilities_before_the_handler() {
    let (session_a, session_b) = sessions().await;
    let contract = example();
    let guard = Arc::new(RecordingGuard::denying("echo"));
    let options = ServeOptions {
        guard: Some(Arc::clone(&guard) as Arc<dyn mango_protocol::contract::Guard>),
        ..Default::default()
    };
    let _served = contract
        .serve(&session_b, plain_handlers(), options)
        .expect("both methods are declared");

    let denied = within(
        "text.echo denied",
        session_a.request("text.echo", json!({ "text": "hi" })),
    )
    .await
    .expect_err("echo is denied");
    assert_eq!(denied.code, codes::DENIED);
    assert_eq!(
        denied.details.as_ref().and_then(|d| d.get("capability")),
        Some(&json!("echo"))
    );

    let sum = within(
        "math.add allowed",
        session_a.request("math.add", json!({ "a": 1, "b": 1 })),
    )
    .await
    .expect("math.add is not denied");
    assert_eq!(sum.as_f64(), Some(2.0));

    assert_eq!(
        guard.seen(),
        vec![
            vec!["text.echo".to_string(), "echo".to_string()],
            vec!["math.add".to_string()],
        ]
    );
}

#[tokio::test]
async fn a_guard_never_runs_when_validation_already_refused_the_request() {
    let (session_a, session_b) = sessions().await;
    let contract = example();
    let guard = Arc::new(RecordingGuard::denying("echo"));
    let options = ServeOptions {
        guard: Some(Arc::clone(&guard) as Arc<dyn mango_protocol::contract::Guard>),
        ..Default::default()
    };
    let _served = contract
        .serve(&session_b, plain_handlers(), options)
        .expect("both methods are declared");

    // math.add's schema requires both `a` and `b`; omitting `b` fails
    // validation before the guard ever runs — the executable form of the
    // guard-order divergence (validate -> guard -> handler here, guard ->
    // validate in TS) called out in this PR's Notes.
    let error = within(
        "math.add missing b",
        session_a.request("math.add", json!({ "a": 1 })),
    )
    .await
    .expect_err("params fail the schema");
    assert_eq!(error.code, codes::INVALID_PARAMS);
    assert!(
        guard.seen().is_empty(),
        "the guard must not run before validation"
    );
}

#[tokio::test]
async fn validates_results_when_asked() {
    let (session_a, session_b) = sessions().await;
    let contract = example();
    let handlers = ContractHandlers::new()
        .on("text.echo", |_params: EchoParams, _context| async move {
            Ok::<_, mango_protocol::error::RemoteError>(json!({ "text": 42 }))
        })
        .on("math.add", |params: AddParams, _context| async move {
            Ok::<_, mango_protocol::error::RemoteError>(params.a + params.b)
        });
    let options = ServeOptions {
        validate_results: true,
        ..Default::default()
    };
    let _served = contract
        .serve(&session_b, handlers, options)
        .expect("both methods are declared");

    let error = within(
        "text.echo with a bad result",
        session_a.request("text.echo", json!({ "text": "hi" })),
    )
    .await
    .expect_err("the result violates its own schema");
    assert_eq!(error.code, codes::INTERNAL);
    assert_eq!(
        error.details.as_ref().and_then(|d| d.get("path")),
        Some(&json!("/text"))
    );
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
struct TickPayload {
    at: f64,
}

#[derive(Debug, Serialize, Deserialize)]
struct StreamPayload {
    line: String,
}

#[tokio::test]
async fn emits_and_receives_typed_events() {
    let (session_a, session_b) = sessions().await;
    let contract = example();

    let mut ticks = contract
        .events(&session_a)
        .subscribe::<TickPayload>("text.tick");
    contract
        .events(&session_b)
        .emit(
            "text.tick",
            TickPayload { at: 1.0 },
            EventOptions::default(),
        )
        .expect("emit succeeds once ready");
    contract
        .events(&session_b)
        .emit(
            "text.stream",
            StreamPayload { line: "x".into() },
            EventOptions {
                stream_id: Some("s".into()),
                end: true,
            },
        )
        .expect("emit succeeds once ready");

    let received = within("the tick event", ticks.recv())
        .await
        .expect("the stream stays open")
        .expect("the payload decodes");
    assert_eq!(received.payload, TickPayload { at: 1.0 });
    assert_eq!(received.frame.topic, "text.tick");
}

#[tokio::test]
async fn typed_event_stream_recv_surfaces_a_payload_that_fails_to_decode() {
    let (session_a, session_b) = sessions().await;
    let contract = example();

    let mut mismatched = contract.events(&session_a).subscribe::<String>("text.tick");
    contract
        .events(&session_b)
        .emit(
            "text.tick",
            TickPayload { at: 1.0 },
            EventOptions::default(),
        )
        .expect("emit succeeds once ready");

    let error = within("the mismatched tick", mismatched.recv())
        .await
        .expect("the stream stays open")
        .expect_err("an object payload does not decode as a bare string");
    assert_eq!(error.code, codes::INTERNAL);
}

#[tokio::test]
async fn contract_client_request_surfaces_a_result_that_fails_to_decode() {
    let (session_a, session_b) = sessions().await;
    let contract = example();
    let _served = contract
        .serve(&session_b, plain_handlers(), ServeOptions::default())
        .expect("both methods are declared");

    let error = within(
        "math.add decoded as a string",
        contract
            .client(&session_a)
            .request::<AddParams, String>("math.add", AddParams { a: 2.0, b: 3.0 }),
    )
    .await
    .expect_err("a number result does not decode as a string");
    assert_eq!(error.code, codes::INTERNAL);
    assert!(error.message.contains("from the peer"), "{}", error.message);
}
