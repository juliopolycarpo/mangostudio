//! The one queue per connection of `spec/transports/websocket.md`.
//!
//! "A queue that grows past one frame limit while the socket is not draining is
//! a peer that is not reading; the sender closes with `4400` rather than
//! holding every pending response for a socket that may never drain."
//!
//! Both halves of that sentence are tested here: a peer that stopped reading is
//! given up on with `4400`, and a peer that is reading is left alone — however
//! large the frames it is being sent.
#![cfg(feature = "websocket")]

use std::time::Duration;

use futures_util::StreamExt;
use mango_protocol::close::close_codes;
use mango_protocol::codec::ndjson::encode_frame_bytes;
use mango_protocol::frame::{Frame, Request};
use mango_protocol::port::{Inbound, Port, PortClosure, PortRx, PortTx, SendOutcome};
use mango_protocol::transports::deadline::ConnectDeadline;
use mango_protocol::transports::websocket::WebSocketOptions;
use mango_protocol::transports::websocket::client::{WebSocketConnectOptions, connect_websocket};
use serde_json::Value;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{Request as UpgradeRequest, Response};
use tokio_tungstenite::tungstenite::http::HeaderValue;

/// Small enough that a handful of frames passes it, and well under the
/// operating system's own socket buffers so a stall is this port's rule rather
/// than the kernel's.
const FRAME_LIMIT: usize = 64 * 1024;

/// The smallest message ceiling the spec allows, so one frame becomes many
/// chunks and the header overhead is at its largest.
const MESSAGE_LIMIT: usize = 2048;

fn options() -> WebSocketOptions {
    WebSocketOptions::default()
        .with_max_frame_bytes(FRAME_LIMIT)
        .with_max_message_bytes(MESSAGE_LIMIT)
}

/// A request whose encoded line is `bytes` long, to the byte.
fn frame_of(bytes: usize) -> Frame {
    let mut payload = 1;
    loop {
        let frame = Frame::Req(Request {
            id: "r-1".into(),
            method: "test.bulk".into(),
            params: Value::String("x".repeat(payload)),
        });
        let encoded = encode_frame_bytes(&frame, FRAME_LIMIT)
            .expect("within the limit")
            .len();
        if encoded == bytes {
            return frame;
        }
        assert!(encoded < bytes, "overshot {bytes} at {encoded}");
        payload += bytes - encoded;
    }
}

/// Upgrades one connection, selecting the subprotocol so this crate's dialler
/// accepts it.
#[allow(
    clippy::result_large_err,
    reason = "the handshake callback's error type is tungstenite's own ErrorResponse"
)]
async fn upgrade(socket: TcpStream) -> WebSocketStream<TcpStream> {
    tokio_tungstenite::accept_hdr_async(
        socket,
        |_request: &UpgradeRequest, mut response: Response| {
            response.headers_mut().insert(
                "sec-websocket-protocol",
                HeaderValue::from_static("mango.v1"),
            );
            Ok(response)
        },
    )
    .await
    .expect("the upgrade completes")
}

#[tokio::test]
async fn a_peer_that_stops_reading_is_closed_with_4400_rather_than_waited_on() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("a port");
    let address = listener.local_addr().expect("a bound address");
    let (start_reading, wait) = oneshot::channel::<()>();
    let (report, closed) = oneshot::channel::<Option<u16>>();

    // An acceptor that completes the upgrade and then reads nothing until the
    // sender has already given up on it.
    let acceptor = tokio::spawn(async move {
        let (socket, _address) = listener.accept().await.expect("a dialler");
        let mut stream = upgrade(socket).await;
        let _ = wait.await;
        // Now drain: the backlog moves, and the farewell queued behind it
        // arrives last.
        let mut code = None;
        while let Some(Ok(message)) = stream.next().await {
            if let Message::Close(frame) = message {
                code = frame.map(|frame| u16::from(frame.code));
                break;
            }
        }
        let _ = report.send(code);
    });

    let port = connect_websocket(
        &format!("ws://{address}/stalled"),
        &WebSocketConnectOptions::default().with_websocket(options()),
        &ConnectDeadline::default().with_timeout(Duration::from_secs(5)),
    )
    .await
    .expect("the acceptor selects mango.v1");

    let (mut tx, _rx) = port.split();
    let sending = async {
        // Far more than the frame limit: whatever the kernel's own buffers
        // absorb, the queue passes one frame limit long before this ends.
        for index in 0..2048 {
            let frame = Frame::Req(Request {
                id: format!("r-{index}"),
                method: "test.bulk".into(),
                params: Value::String("x".repeat(FRAME_LIMIT / 8)),
            });
            if tx.send(frame).await != SendOutcome::Sent {
                return index;
            }
            // Without this the writer task is never scheduled: `send_frame`
            // finishes in one poll, so a sender that only awaits it holds the
            // runtime for the whole loop and the port never attempts a single
            // socket write. The queue would then pass the limit with nothing
            // ever learned about the socket, and this case would be proving
            // the counter rather than the stalled peer it is named for.
            tokio::task::yield_now().await;
        }
        panic!("the port accepted 2048 frames without ever reporting the peer as gone");
    };

    let stopped_at = tokio::time::timeout(Duration::from_secs(20), sending)
        .await
        .expect("the port gives up on a peer that is not reading rather than blocking for ever");
    assert!(
        stopped_at > 0,
        "the first frame should still have been accepted"
    );

    let _ = start_reading.send(());
    let code = tokio::time::timeout(Duration::from_secs(20), closed)
        .await
        .expect("the farewell reaches the peer once it starts reading again")
        .expect("the acceptor reports what it read");
    assert_eq!(
        code,
        Some(close_codes::PROTOCOL_ERROR),
        "the peer is owed the code, not just a socket that stopped"
    );
    let _ = acceptor.await;
}

/// A burst that outruns the sender's own check.
///
/// `send_frame` has no await on its happy path, so a caller that never yields
/// between sends can queue arbitrarily far past the frame limit before the
/// writer task is ever scheduled. The stalled-queue rule must therefore be
/// judged by the writer task itself, the instant it finds the socket not
/// draining — not fished for by whatever `send_frame` call happens to run
/// next. This sends the whole burst back to back with no manual yield, then
/// makes no further call at all: only the writer task can still give up on
/// this peer.
#[tokio::test]
async fn a_burst_with_no_yields_still_gives_up_on_a_peer_that_is_not_reading() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("a port");
    let address = listener.local_addr().expect("a bound address");
    let (start_reading, wait) = oneshot::channel::<()>();
    let (report, closed) = oneshot::channel::<Option<u16>>();

    let acceptor = tokio::spawn(async move {
        let (socket, _address) = listener.accept().await.expect("a dialler");
        let mut stream = upgrade(socket).await;
        let _ = wait.await;
        let mut code = None;
        while let Some(Ok(message)) = stream.next().await {
            if let Message::Close(frame) = message {
                code = frame.map(|frame| u16::from(frame.code));
                break;
            }
        }
        let _ = report.send(code);
    });

    let port = connect_websocket(
        &format!("ws://{address}/burst"),
        &WebSocketConnectOptions::default().with_websocket(options()),
        &ConnectDeadline::default().with_timeout(Duration::from_secs(5)),
    )
    .await
    .expect("the acceptor selects mango.v1");

    let (mut tx, _rx) = port.split();

    // Far more than any kernel send buffer holds, sent with no yield between
    // any two of them. Every one reports `Sent`: nothing has run the writer
    // task yet to know otherwise.
    for index in 0..4096 {
        let frame = Frame::Req(Request {
            id: format!("r-{index}"),
            method: "test.bulk".into(),
            params: Value::String("x".repeat(FRAME_LIMIT / 8)),
        });
        assert_eq!(
            tx.send(frame).await,
            SendOutcome::Sent,
            "no writer-task turn has happened yet to notice the socket is not draining"
        );
    }

    // Give the writer task the run of the executor, without ever calling
    // `send_frame` again. The peer still is not reading, so if the writer
    // task does not judge the rule itself here, nothing else in this test
    // ever will.
    tokio::time::sleep(Duration::from_millis(200)).await;

    let _ = start_reading.send(());
    let code = tokio::time::timeout(Duration::from_secs(20), closed)
        .await
        .expect(
            "the writer task must give up and send the farewell on its own, \
             not wait for a sender that never asks again",
        )
        .expect("the acceptor reports what it read");
    assert_eq!(
        code,
        Some(close_codes::PROTOCOL_ERROR),
        "the peer is owed the code, not just a socket that stopped"
    );
    let _ = acceptor.await;
}

/// The writer giving up is not only a `send_frame` outcome.
///
/// Nothing here ever reads a byte from the peer, and nothing is going to
/// before this test says so — the acceptor only starts reading after `recv`
/// has already returned. A session's read loop is exactly this shape: it
/// waits on `recv` for whatever the peer sends next, and a peer that stopped
/// reading may just as well never send anything back. If the writer task's
/// own decision to give up never reaches the receive half, that `recv` has
/// no way to learn the transport is gone and holds every pending response
/// forever, which is the entire failure this transport's backpressure rule
/// exists to prevent.
#[tokio::test]
async fn a_burst_with_no_yields_also_unblocks_a_concurrent_recv() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("a port");
    let address = listener.local_addr().expect("a bound address");
    let (start_reading, wait) = oneshot::channel::<()>();

    let acceptor = tokio::spawn(async move {
        let (socket, _address) = listener.accept().await.expect("a dialler");
        let _stream = upgrade(socket).await;
        let _ = wait.await;
    });

    let port = connect_websocket(
        &format!("ws://{address}/burst-recv"),
        &WebSocketConnectOptions::default().with_websocket(options()),
        &ConnectDeadline::default().with_timeout(Duration::from_secs(5)),
    )
    .await
    .expect("the acceptor selects mango.v1");

    let (mut tx, mut rx) = port.split();

    for index in 0..4096 {
        let frame = Frame::Req(Request {
            id: format!("r-{index}"),
            method: "test.bulk".into(),
            params: Value::String("x".repeat(FRAME_LIMIT / 8)),
        });
        assert_eq!(tx.send(frame).await, SendOutcome::Sent);
    }

    // Give the writer task the run of the executor, exactly as the sibling
    // test does — the acceptor still has not read a single byte.
    tokio::time::sleep(Duration::from_millis(200)).await;

    let inbound = tokio::time::timeout(Duration::from_secs(3), rx.recv())
        .await
        .expect(
            "recv blocked on a peer that stopped reading must not wait on that \
             same peer to send something back before it agrees the transport \
             is gone",
        );
    match inbound {
        Some(Inbound::Closed(PortClosure::Closed { code, .. })) => {
            assert_eq!(
                code,
                Some(close_codes::PROTOCOL_ERROR),
                "recv is owed the same code send_frame already decided on"
            );
        }
        other => panic!("expected Closed with PROTOCOL_ERROR, got {other:?}"),
    }

    let _ = start_reading.send(());
    let _ = acceptor.await;
}

#[tokio::test]
async fn a_frame_at_the_limit_is_not_mistaken_for_a_peer_that_stopped_reading() {
    // A frame of exactly the limit is legal, and at the smallest legal message
    // ceiling its chunk headers add another 300-odd bytes. Measuring a frame
    // against the limit by its own queued size would close a healthy session
    // on a response the protocol explicitly permits.
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("a port");
    let address = listener.local_addr().expect("a bound address");

    let acceptor = tokio::spawn(async move {
        let (socket, _address) = listener.accept().await.expect("a dialler");
        let mut stream = upgrade(socket).await;
        let mut payload = 0_usize;
        while let Some(Ok(message)) = stream.next().await {
            match message {
                Message::Binary(bytes) => payload += bytes.len() - 9,
                Message::Close(_) => break,
                _ => {}
            }
            // Stop at the frame itself; the farewell that follows it carries a
            // payload of its own and is not what is being measured.
            if payload >= FRAME_LIMIT {
                break;
            }
        }
        payload
    });

    let port = connect_websocket(
        &format!("ws://{address}/healthy"),
        &WebSocketConnectOptions::default().with_websocket(options()),
        &ConnectDeadline::default().with_timeout(Duration::from_secs(5)),
    )
    .await
    .expect("the acceptor selects mango.v1");

    let (mut tx, _rx) = port.split();
    assert_eq!(
        tx.send(frame_of(FRAME_LIMIT)).await,
        SendOutcome::Sent,
        "a frame of exactly the limit is one the protocol permits"
    );
    tx.close(close_codes::RELEASED, None).await;

    let reassembled = tokio::time::timeout(Duration::from_secs(20), acceptor)
        .await
        .expect("the peer reads it all")
        .expect("the acceptor task runs");
    assert_eq!(reassembled, FRAME_LIMIT, "every chunk of the frame arrived");
}

#[tokio::test]
async fn two_frames_at_the_limit_in_a_row_reach_a_peer_that_is_reading() {
    // The queue is a peer that stopped reading only when it grows past a frame
    // limit *while the socket is not draining*. One frame of exactly the limit
    // leaves that much behind it, so a second sent before the writer task has
    // been polled sees a backlog over the limit on a perfectly healthy socket.
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("a port");
    let address = listener.local_addr().expect("a bound address");

    let acceptor = tokio::spawn(async move {
        let (socket, _address) = listener.accept().await.expect("a dialler");
        let mut stream = upgrade(socket).await;
        let mut payload = 0_usize;
        while let Some(Ok(message)) = stream.next().await {
            match message {
                Message::Binary(bytes) => payload += bytes.len() - 9,
                Message::Close(_) => break,
                _ => {}
            }
        }
        payload
    });

    let port = connect_websocket(
        &format!("ws://{address}/reading"),
        &WebSocketConnectOptions::default().with_websocket(options()),
        &ConnectDeadline::default().with_timeout(Duration::from_secs(5)),
    )
    .await
    .expect("the acceptor selects mango.v1");

    let (mut tx, _rx) = port.split();
    let first = tx.send(frame_of(FRAME_LIMIT)).await;
    let second = tx.send(frame_of(FRAME_LIMIT)).await;
    assert_eq!(first, SendOutcome::Sent, "a frame at the limit is legal");
    assert_eq!(
        second,
        SendOutcome::Sent,
        "and so is the one after it: this peer is reading, so nothing here is a peer that stopped"
    );

    tx.close(close_codes::RELEASED, None).await;
    let _ = tokio::time::timeout(Duration::from_secs(20), acceptor).await;
}
