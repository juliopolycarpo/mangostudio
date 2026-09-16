//! Two in-process sessions exchanging a request, an event stream and a
//! cancelled call, narrated to stdout.
//!
//! ```text
//! cargo run --example session_pair --features tokio
//! ```

use std::time::Duration;

use mango_protocol::error::codes;
use mango_protocol::frame::PeerInfo;
use mango_protocol::port::port_pair;
use mango_protocol::session::{CallContext, EventInput, RequestOptions, Session, SessionOptions};
use mango_protocol::{RemoteError, close_codes};
use serde_json::json;
use tokio_util::sync::CancellationToken;

fn peer(name: &str, role: &str) -> PeerInfo {
    PeerInfo {
        name: name.into(),
        version: "0.1.0".into(),
        role: role.into(),
    }
}

#[tokio::main]
async fn main() {
    let (port_a, port_b) = port_pair();
    let (a, _driver_a) = Session::spawn(
        port_a,
        SessionOptions::new(peer("session-pair-a", "runtime")),
    );
    let (b, _driver_b) = Session::spawn(port_b, SessionOptions::new(peer("session-pair-b", "hub")));

    let remote_a = a.ready().await.expect("a's handshake succeeds");
    let remote_b = b.ready().await.expect("b's handshake succeeds");
    println!(
        "handshake: a sees peer {:?}, b sees peer {:?}",
        remote_a.peer.name, remote_b.peer.name
    );

    b.handle("demo.echo", |params, _context| async move { Ok(params) })
        .persist();
    b.handle("demo.forever", |_params, context: CallContext| async move {
        context.cancel().cancelled().await;
        Err(RemoteError::new(
            codes::CANCELLED,
            "\"demo.forever\" was cancelled.",
        ))
    })
    .persist();

    let echoed = a
        .request("demo.echo", json!({ "hi": 1 }))
        .await
        .expect("demo.echo succeeds");
    println!("request: demo.echo({{\"hi\":1}}) -> {echoed}");

    let mut events = a.events();
    for (line, end) in [("first", false), ("second", false), ("last", true)] {
        b.emit(EventInput {
            topic: "demo.tick".into(),
            payload: json!({ "line": line }),
            stream_id: Some("stream-1".into()),
            end,
        })
        .expect("emits");
    }
    // One round trip after the last emit guarantees every event already landed.
    a.request("demo.echo", json!({}))
        .await
        .expect("round trip barrier");
    for _ in 0..3 {
        let event = events.recv().await.expect("the stream stays open");
        println!(
            "event: seq {} payload {} end {}",
            event.seq,
            event.payload,
            event.end.is_some()
        );
    }

    let cancel = CancellationToken::new();
    let a_for_task = a.clone();
    let cancel_for_task = cancel.clone();
    let pending = tokio::spawn(async move {
        a_for_task
            .request_with(
                "demo.forever",
                json!({}),
                RequestOptions {
                    cancel: Some(cancel_for_task),
                    ..Default::default()
                },
            )
            .await
    });
    tokio::time::sleep(Duration::from_millis(20)).await;
    cancel.cancel();
    let error = pending
        .await
        .expect("the request task did not panic")
        .expect_err("the request was cancelled");
    println!("cancel: demo.forever -> {}", error.code);

    let closure = a.close(close_codes::RELEASED, Some("done")).await;
    println!("close: code {} reason {:?}", closure.code, closure.reason);
}
