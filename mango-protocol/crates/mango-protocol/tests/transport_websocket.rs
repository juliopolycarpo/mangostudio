//! Runs the conformance suite over a real WebSocket connection: a TCP
//! listener that upgrades with `accept_websocket`, and a dialler that offers
//! `mango.v1` and presents a bearer token.
//!
//! Two message ceilings are exercised. The 2 KiB one makes the suite's bulk
//! results many chunks, which is what the interleaving case needs to mean
//! anything.
#![cfg(all(feature = "testing", feature = "websocket"))]

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use mango_protocol::close::close_codes;
use mango_protocol::frame::Frame;
use mango_protocol::port::{Inbound, Port, PortRx, PortTx, SendOutcome};
use mango_protocol::session::{Session, SessionClosure, SessionOptions};
use mango_protocol::testing::{ConformancePair, Fixture, RawConnection, run_conformance_suite};
use mango_protocol::transports::deadline::{ConnectDeadline, ConnectError};
use mango_protocol::transports::websocket::client::{WebSocketConnectOptions, connect_websocket};
use mango_protocol::transports::websocket::server::{
    AcceptError, AcceptOptions, accept_websocket, is_origin_allowed,
};
use mango_protocol::transports::websocket::{WebSocketOptions, WebSocketPort};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

/// The credential the acceptor in these tests knows.
const TOKEN: &str = "conformance-token";

/// One accepted connection, upgraded and authorised, plus the address it came
/// in on.
struct Acceptor {
    listener: TcpListener,
    options: WebSocketOptions,
}

impl Acceptor {
    async fn bind(options: WebSocketOptions) -> Self {
        Self {
            listener: TcpListener::bind("127.0.0.1:0")
                .await
                .expect("a loopback port"),
            options,
        }
    }

    fn url(&self) -> String {
        let address = self.listener.local_addr().expect("a bound address");
        format!("ws://{address}/conformance")
    }

    async fn accept(&self) -> Result<WebSocketPort<TcpStream>, AcceptError> {
        let (socket, _address) = self.listener.accept().await.expect("a dialler arrives");
        accept_websocket(socket, self.options, |upgrade| match upgrade.bearer() {
            Some(TOKEN) => Ok(()),
            _ => Err(close_codes::UNAUTHORIZED),
        })
        .await
    }
}

async fn dial(
    url: &str,
    options: WebSocketOptions,
    token: Option<&str>,
) -> Result<mango_protocol::transports::websocket::client::DialledWebSocketPort, ConnectError> {
    let mut connect = WebSocketConnectOptions::default().with_websocket(options);
    if let Some(token) = token {
        connect = connect.with_bearer(token);
    }
    connect_websocket(
        url,
        &connect,
        &ConnectDeadline::default().with_timeout(Duration::from_secs(10)),
    )
    .await
}

struct SocketPair {
    a: Session,
    b: Session,
    driver_a: Option<JoinHandle<SessionClosure>>,
    driver_b: Option<JoinHandle<SessionClosure>>,
}

impl ConformancePair for SocketPair {
    fn a(&self) -> &Session {
        &self.a
    }

    fn b(&self) -> &Session {
        &self.b
    }

    async fn sever(&mut self) {
        // Aborting b's driver drops its half of the socket without a close
        // frame: a sees the connection vanish, which is what a crash leaves.
        if let Some(driver_b) = self.driver_b.take() {
            driver_b.abort();
        }
    }

    async fn close(&mut self) {
        self.a.close_now(close_codes::RELEASED, None);
        self.b.close_now(close_codes::RELEASED, None);
        if let Some(driver_a) = self.driver_a.take() {
            let _ = driver_a.await;
        }
        if let Some(driver_b) = self.driver_b.take() {
            let _ = driver_b.await;
        }
    }
}

/// The nine-byte chunk header of a frame that fits in one message: format
/// version 1, chunk index 0, chunk count 1.
const SINGLE_CHUNK_HEADER: [u8; 9] = [1, 0, 0, 0, 0, 0, 0, 0, 1];

/// Side `a` is the accepted connection; its peer is a socket this test sends
/// hand-built chunk messages on.
struct RawSocket {
    a: Session,
    driver: Option<JoinHandle<SessionClosure>>,
    peer: Option<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>>,
}

impl RawConnection for RawSocket {
    fn a(&self) -> &Session {
        &self.a
    }

    async fn write(&mut self, line: &str) {
        let peer = self.peer.as_mut().expect("the raw socket is still open");
        let mut message = SINGLE_CHUNK_HEADER.to_vec();
        message.extend_from_slice(line.as_bytes());
        peer.send(tokio_tungstenite::tungstenite::Message::Binary(
            message.into(),
        ))
        .await
        .expect("the socket takes the message");
    }

    async fn close(&mut self) {
        self.a.close_now(close_codes::RELEASED, None);
        if let Some(mut peer) = self.peer.take() {
            let _ = peer.close(None).await;
        }
        if let Some(driver) = self.driver.take() {
            let _ = driver.await;
        }
    }
}

struct WebSocketFixture {
    options: WebSocketOptions,
}

impl Fixture for WebSocketFixture {
    type Pair = SocketPair;
    type Raw = RawSocket;

    async fn connect(&self, a: SessionOptions, b: SessionOptions) -> SocketPair {
        let acceptor = Acceptor::bind(self.options).await;
        let url = acceptor.url();
        let dialling = tokio::spawn({
            let options = self.options;
            async move { dial(&url, options, Some(TOKEN)).await }
        });
        let accepted = acceptor.accept().await.expect("the credential is known");
        let dialled = dialling
            .await
            .expect("the dial task runs")
            .expect("the acceptor selects mango.v1");

        let (session_a, driver_a) = Session::spawn(dialled, a);
        let (session_b, driver_b) = Session::spawn(accepted, b);
        SocketPair {
            a: session_a,
            b: session_b,
            driver_a: Some(driver_a),
            driver_b: Some(driver_b),
        }
    }

    /// Frames are split across messages, so two concurrent oversized results
    /// are an interleaving test the suite knows how to run.
    fn chunked(&self) -> bool {
        true
    }

    fn supports_raw(&self) -> bool {
        true
    }

    async fn connect_raw(&self, a: SessionOptions) -> RawSocket {
        let acceptor = Acceptor::bind(self.options).await;
        let address = acceptor.listener.local_addr().expect("a bound address");
        // A bare tungstenite dial that offers the subprotocol but puts no port
        // over the socket: the messages are this test's to build.
        let dialling = tokio::spawn(async move {
            let mut request =
                tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(
                    format!("ws://{address}/conformance"),
                )
                .expect("a ws URL");
            request.headers_mut().insert(
                "sec-websocket-protocol",
                tokio_tungstenite::tungstenite::http::HeaderValue::from_static("mango.v1"),
            );
            request.headers_mut().insert(
                "authorization",
                tokio_tungstenite::tungstenite::http::HeaderValue::from_static(
                    "Bearer conformance-token",
                ),
            );
            tokio_tungstenite::connect_async(request)
                .await
                .expect("the acceptor selects mango.v1")
                .0
        });
        let accepted = acceptor.accept().await.expect("the credential is known");
        let peer = dialling.await.expect("the dial task runs");

        let (session, driver) = Session::spawn(accepted, a);
        RawSocket {
            a: session,
            driver: Some(driver),
            peer: Some(peer),
        }
    }
}

#[tokio::test]
async fn the_websocket_behaves_like_a_mango_transport() {
    run_conformance_suite(&WebSocketFixture {
        options: WebSocketOptions::default(),
    })
    .await;
}

#[tokio::test]
async fn the_websocket_behaves_like_a_mango_transport_at_a_small_message_ceiling() {
    run_conformance_suite(&WebSocketFixture {
        options: WebSocketOptions::default().with_max_message_bytes(2048),
    })
    .await;
}

#[tokio::test]
async fn a_socket_that_ended_reports_a_later_send_as_closed_not_sent() {
    // The peer's own close frame marks the writer closed; a socket that simply
    // ended, or failed, has to do the same. A frame reported as `Sent` on a
    // connection that is gone is a response the session believes it delivered,
    // and the NDJSON port has never had that gap.
    let acceptor = Acceptor::bind(WebSocketOptions::default()).await;
    let url = acceptor.url();
    let dialling =
        tokio::spawn(async move { dial(&url, WebSocketOptions::default(), Some(TOKEN)).await });
    let accepted = acceptor.accept().await.expect("the credential is known");
    let dialled = dialling
        .await
        .expect("the dial task runs")
        .expect("the acceptor selects mango.v1");

    // The far side vanishes without a close frame, which is what a crash
    // leaves behind.
    drop(accepted);

    let (mut tx, mut rx) = dialled.split();
    assert!(
        matches!(rx.recv().await, Some(Inbound::Closed(_))),
        "the socket ending is a closure"
    );
    assert_eq!(
        tx.send(Frame::Ping).await,
        SendOutcome::Closed,
        "a frame queued on a socket that is gone is not one the peer will read"
    );
}

#[tokio::test]
async fn a_credential_the_acceptor_does_not_know_is_refused_before_hello() {
    let acceptor = Acceptor::bind(WebSocketOptions::default()).await;
    let url = acceptor.url();
    let dialling =
        tokio::spawn(async move { dial(&url, WebSocketOptions::default(), Some("wrong")).await });

    let refusal = acceptor
        .accept()
        .await
        .expect_err("the credential is not the one this acceptor knows");
    assert!(
        matches!(
            refusal,
            AcceptError::Unauthorized {
                code: close_codes::UNAUTHORIZED
            }
        ),
        "{refusal}"
    );

    // The upgrade itself completed, which is what lets the dialler read a
    // code at all: a refused upgrade would reach it as a socket that never
    // opened.
    let port = dialling
        .await
        .expect("the dial task runs")
        .expect("the upgrade completed before the credential was judged");
    let peer = mango_protocol::frame::PeerInfo {
        name: "dialler".into(),
        version: "0".into(),
        role: "runtime".into(),
    };
    let (session, driver) = Session::spawn(port, SessionOptions::new(peer));
    let closure = session.closed().await;
    assert_eq!(closure.code, close_codes::UNAUTHORIZED);
    assert!(
        closure.fatal,
        "4401 is a code redialling cannot recover from"
    );
    let _ = driver.await;
}

#[tokio::test]
async fn a_dialler_that_does_not_offer_the_subprotocol_is_closed_with_4400() {
    let acceptor = Acceptor::bind(WebSocketOptions::default()).await;
    let address = acceptor.listener.local_addr().expect("a bound address");
    // A bare tungstenite dial offers no subprotocol at all.
    let dialling = tokio::spawn(async move {
        tokio_tungstenite::connect_async(format!("ws://{address}/conformance")).await
    });

    let refusal = acceptor
        .accept()
        .await
        .expect_err("a connection without mango.v1 is not a session");
    assert!(matches!(refusal, AcceptError::Subprotocol), "{refusal}");

    // The upgrade completed, so the dialler is owed a code it can read rather
    // than a socket that simply stopped.
    let (mut dialled, _response) = dialling
        .await
        .expect("the dial task runs")
        .expect("the upgrade itself succeeds");
    let mut code = None;
    while let Some(Ok(message)) = dialled.next().await {
        if let tokio_tungstenite::tungstenite::Message::Close(frame) = message {
            code = frame.map(|frame| u16::from(frame.code));
            break;
        }
    }
    assert_eq!(code, Some(close_codes::PROTOCOL_ERROR));
}

#[tokio::test]
async fn an_acceptor_that_selects_nothing_refuses_the_dial() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("a port");
    let address = listener.local_addr().expect("a bound address");
    // An acceptor that upgrades without echoing the subprotocol: a WebSocket,
    // but not a Mango Protocol one.
    tokio::spawn(async move {
        let (socket, _address) = listener.accept().await.expect("a dialler");
        let _ = tokio_tungstenite::accept_async(socket).await;
    });

    let error = dial(
        &format!("ws://{address}/conformance"),
        WebSocketOptions::default(),
        None,
    )
    .await
    .expect_err("an acceptor that selected nothing is not speaking mango.v1");
    // Whether the refusal comes from the handshake itself or from this
    // crate's own check of the selected subprotocol, what matters is that no
    // port is handed back for a connection neither side agreed the protocol
    // on.
    match error {
        ConnectError::Refused { detail, .. } => {
            assert!(detail.to_lowercase().contains("subprotocol"), "{detail}");
        }
        other => panic!("expected a refusal, got {other:?}"),
    }
}

/// The corpus, not this crate, is where the origin comparison is written
/// down; `packages/protocol/tests/fixtures-origins.test.ts` reads the same
/// file and must agree case for case.
#[test]
fn every_origin_case_agrees_with_the_corpus() {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../spec/fixtures/1/origins.json"
    )))
    .expect("origins.json is valid JSON");
    let cases = corpus["cases"].as_array().expect("a cases array");
    assert!(!cases.is_empty(), "the corpus has cases");

    for case in cases {
        let name = case["name"].as_str().expect("a name");
        let allowed: Vec<String> = case["allowed"]
            .as_array()
            .expect("an allow-list")
            .iter()
            .map(|entry| entry.as_str().expect("an origin").to_string())
            .collect();
        let expected = match case["verdict"].as_str().expect("a verdict") {
            "accept" => true,
            "reject" => false,
            other => panic!("{name}: unknown verdict {other:?}"),
        };
        assert_eq!(
            is_origin_allowed(case["origin"].as_str(), &allowed),
            expected,
            "{name}"
        );
    }
}

#[tokio::test]
async fn an_origin_outside_the_allow_list_is_refused_before_hello() {
    use tokio_tungstenite::tungstenite::handshake::client::generate_key;
    use tokio_tungstenite::tungstenite::http::{Request as HttpRequest, header};

    let listener = TcpListener::bind("127.0.0.1:0").await.expect("a port");
    let address = listener.local_addr().expect("a bound address");
    let accepting = tokio::spawn(async move {
        let (socket, _from) = listener.accept().await.expect("a dialler arrives");
        accept_websocket(
            socket,
            AcceptOptions::default().with_allowed_origins(["https://app.example"]),
            |_upgrade| Ok(()),
        )
        .await
        .map(|_port| ())
    });

    // Built by hand rather than through `connect_websocket`: the dialler this
    // case needs is a browser, and only a browser attaches `Origin`.
    let request = HttpRequest::builder()
        .uri(format!("ws://{address}/conformance"))
        .header(header::HOST, address.to_string())
        .header(header::CONNECTION, "Upgrade")
        .header(header::UPGRADE, "websocket")
        .header(header::SEC_WEBSOCKET_VERSION, "13")
        .header(header::SEC_WEBSOCKET_KEY, generate_key())
        .header(header::ORIGIN, "https://app.example.attacker.test")
        .header(
            header::SEC_WEBSOCKET_PROTOCOL,
            mango_protocol::transports::websocket::WEBSOCKET_SUBPROTOCOL,
        )
        .body(())
        .expect("a request");
    let dialling = tokio::spawn(async move { tokio_tungstenite::connect_async(request).await });

    let refusal = accepting
        .await
        .expect("the acceptor task runs")
        .expect_err("a suffix of an allowed origin is not that origin");
    match refusal {
        AcceptError::Origin { origin } => {
            assert_eq!(origin, "https://app.example.attacker.test");
        }
        other => panic!("expected an origin refusal, got {other}"),
    }

    // The upgrade completed, so the page is owed a code it can read; the
    // acceptor sent no hello, so it never learned who was listening.
    let (mut dialled, _response) = dialling
        .await
        .expect("the dial task runs")
        .expect("the upgrade itself succeeds");
    let mut code = None;
    let mut greeting = None;
    while let Some(Ok(message)) = dialled.next().await {
        match message {
            tokio_tungstenite::tungstenite::Message::Close(frame) => {
                code = frame.map(|frame| u16::from(frame.code));
                break;
            }
            tokio_tungstenite::tungstenite::Message::Binary(_)
            | tokio_tungstenite::tungstenite::Message::Text(_) => {
                greeting = Some(message);
                break;
            }
            _ => continue,
        }
    }
    assert!(
        greeting.is_none(),
        "the acceptor greeted a refused origin: {greeting:?}"
    );
    assert_eq!(code, Some(close_codes::FORBIDDEN));
}

/// An `Origin` header a browser sent but whose bytes are not valid UTF-8 must
/// not fall through `HeaderValue::to_str().ok()` into "absent" — that would
/// let a garbled header sail past an empty allow-list the same way a native
/// dialler does. It has to be refused like any other origin the allow-list
/// does not recognise.
#[tokio::test]
async fn an_undecodable_origin_is_refused_not_treated_as_absent() {
    use tokio_tungstenite::tungstenite::handshake::client::generate_key;
    use tokio_tungstenite::tungstenite::http::{HeaderValue, Request as HttpRequest, header};

    let listener = TcpListener::bind("127.0.0.1:0").await.expect("a port");
    let address = listener.local_addr().expect("a bound address");
    let accepting = tokio::spawn(async move {
        let (socket, _from) = listener.accept().await.expect("a dialler arrives");
        accept_websocket(socket, AcceptOptions::default(), |_upgrade| Ok(()))
            .await
            .map(|_port| ())
    });

    let mut request = HttpRequest::builder()
        .uri(format!("ws://{address}/conformance"))
        .header(header::HOST, address.to_string())
        .header(header::CONNECTION, "Upgrade")
        .header(header::UPGRADE, "websocket")
        .header(header::SEC_WEBSOCKET_VERSION, "13")
        .header(header::SEC_WEBSOCKET_KEY, generate_key())
        .header(
            header::SEC_WEBSOCKET_PROTOCOL,
            mango_protocol::transports::websocket::WEBSOCKET_SUBPROTOCOL,
        )
        .body(())
        .expect("a request");
    request.headers_mut().insert(
        header::ORIGIN,
        HeaderValue::from_bytes(b"\xff\xfe").expect("raw bytes are a valid header value"),
    );
    let dialling = tokio::spawn(async move { tokio_tungstenite::connect_async(request).await });

    let refusal = accepting
        .await
        .expect("the acceptor task runs")
        .expect_err("the default allow-list admits no browser, undecodable or not");
    assert!(
        matches!(refusal, AcceptError::Origin { .. }),
        "expected an origin refusal, got {refusal}"
    );

    let (mut dialled, _response) = dialling
        .await
        .expect("the dial task runs")
        .expect("the upgrade itself succeeds");
    let mut code = None;
    while let Some(Ok(message)) = dialled.next().await {
        if let tokio_tungstenite::tungstenite::Message::Close(frame) = message {
            code = frame.map(|frame| u16::from(frame.code));
            break;
        }
    }
    assert_eq!(code, Some(close_codes::FORBIDDEN));
}

#[tokio::test]
async fn a_dialler_without_an_origin_is_not_treated_as_a_browser() {
    let acceptor = Acceptor::bind(WebSocketOptions::default()).await;
    let url = acceptor.url();
    let dialling =
        tokio::spawn(async move { dial(&url, WebSocketOptions::default(), Some(TOKEN)).await });

    // The default allow-list is empty, which admits no browser — and a native
    // dialler attaches no Origin, so the empty list does not touch it.
    acceptor
        .accept()
        .await
        .expect("a dialler that sent no Origin is judged on its credential alone");
    let _ = dialling.await.expect("the dial task runs");
}
