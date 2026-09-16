//! A reusable conformance suite: the session-level behaviour every transport
//! must reproduce, exercised entirely through [`Fixture`] rather than this
//! crate's own [`crate::port::MemoryPort`]. `tests/conformance.rs` runs it
//! against the in-process pair; a transport crate built on this one runs the
//! same cases against its own [`Fixture`] implementation via
//! [`run_conformance_suite`].

use std::time::Duration;

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::close::close_codes;
use crate::codec::ndjson::DEFAULT_MAX_FRAME_BYTES;
use crate::error::{RemoteError, codes};
use crate::frame::PeerInfo;
use crate::session::{
    CallContext, EventInput, RequestOptions, Session, SessionOptions, SessionState,
};
use crate::version::ProtocolVersion;

/// Two sessions a [`Fixture`] connected, and the two different ways to end
/// them.
///
/// Every method is safe to call more than once, and [`ConformancePair::close`]
/// is safe to call after [`ConformancePair::sever`] — mirrors the TypeScript
/// suite's own `ConformancePair` interface, whose `close()` always runs in a
/// `finally` even after a case already called `drop()`.
pub trait ConformancePair: Send {
    /// Side `a`.
    fn a(&self) -> &Session;
    /// Side `b`.
    fn b(&self) -> &Session;
    /// Severs the connection the way a crash or a cut network would: no
    /// close frame, no graceful shutdown, the transport is just gone.
    fn sever(&mut self) -> impl Future<Output = ()> + Send;
    /// Ends both sides gracefully and releases whatever this fixture holds.
    fn close(&mut self) -> impl Future<Output = ()> + Send;
}

/// A connection to side `a` only, its far end raw bytes as if from a peer —
/// [`Fixture::connect_raw`]'s product, for a byte-oriented transport that can
/// receive a hand-written line nothing decoded first.
pub trait RawConnection: Send {
    /// Side `a`.
    fn a(&self) -> &Session;
    /// Writes one raw line as if the peer had sent it.
    fn write(&mut self, line: &str) -> impl Future<Output = ()> + Send;
    /// Ends the connection.
    fn close(&mut self) -> impl Future<Output = ()> + Send;
}

/// The [`Fixture::Raw`] a fixture names when it never supports
/// [`Fixture::connect_raw`] — this crate's own in-process fixture among them,
/// since a [`crate::port::MemoryPort`] never round-trips through literal
/// bytes a test could hand-write. Uninhabited, so every method here is
/// unreachable by construction rather than merely unimplemented, the same
/// reasoning as [`std::convert::Infallible`].
#[derive(Debug)]
pub enum NoRawConnection {}

impl RawConnection for NoRawConnection {
    fn a(&self) -> &Session {
        match *self {}
    }

    async fn write(&mut self, _line: &str) {
        match *self {}
    }

    async fn close(&mut self) {
        match *self {}
    }
}

/// A transport [`run_conformance_suite`] can exercise: connects a pair, and
/// optionally a raw-bytes half-connection, over whatever carries the frames.
///
/// # Example
///
/// This crate's own in-process pair, implementing [`Fixture`] the same way
/// `tests/conformance.rs` does, then running the full suite against it.
///
/// ```
/// # #[tokio::main(flavor = "current_thread")]
/// # async fn main() {
/// use mango_protocol::port::port_pair;
/// use mango_protocol::session::{Session, SessionClosure, SessionOptions};
/// use mango_protocol::testing::{ConformancePair, Fixture, NoRawConnection, run_conformance_suite};
/// use tokio::task::JoinHandle;
///
/// struct Pair {
///     a: Session,
///     b: Session,
///     driver_a: Option<JoinHandle<SessionClosure>>,
///     driver_b: Option<JoinHandle<SessionClosure>>,
/// }
///
/// impl ConformancePair for Pair {
///     fn a(&self) -> &Session { &self.a }
///     fn b(&self) -> &Session { &self.b }
///
///     async fn sever(&mut self) {
///         if let Some(driver_b) = self.driver_b.take() {
///             driver_b.abort();
///         }
///     }
///
///     async fn close(&mut self) {
///         self.a.close_now(mango_protocol::close_codes::RELEASED, None);
///         self.b.close_now(mango_protocol::close_codes::RELEASED, None);
///         if let Some(driver_a) = self.driver_a.take() { let _ = driver_a.await; }
///         if let Some(driver_b) = self.driver_b.take() { let _ = driver_b.await; }
///     }
/// }
///
/// struct InProcess;
///
/// impl Fixture for InProcess {
///     type Pair = Pair;
///     type Raw = NoRawConnection;
///
///     async fn connect(&self, a: SessionOptions, b: SessionOptions) -> Pair {
///         let (port_a, port_b) = port_pair();
///         let (session_a, driver_a) = Session::spawn(port_a, a);
///         let (session_b, driver_b) = Session::spawn(port_b, b);
///         Pair { a: session_a, b: session_b, driver_a: Some(driver_a), driver_b: Some(driver_b) }
///     }
/// }
///
/// run_conformance_suite(&InProcess).await;
/// # }
/// ```
pub trait Fixture: Send + Sync {
    /// The pair this fixture produces.
    type Pair: ConformancePair;
    /// The raw connection [`Fixture::connect_raw`] produces; [`NoRawConnection`]
    /// for a fixture that never supports one.
    type Raw: RawConnection;

    /// Connects two sessions, `a` and `b`, over this fixture's transport.
    fn connect(
        &self,
        a: SessionOptions,
        b: SessionOptions,
    ) -> impl Future<Output = Self::Pair> + Send;

    /// True when frames may be split across messages, so two concurrent
    /// oversized results could interleave if the transport got that wrong.
    /// `false` (the default) for a fixture, like this crate's own in-process
    /// one, that always delivers a frame whole.
    fn chunked(&self) -> bool {
        false
    }

    /// True when this fixture can produce a [`Fixture::connect_raw`]
    /// connection. `false` (the default) for a fixture whose transport has no
    /// byte layer to inject a hand-written line into.
    fn supports_raw(&self) -> bool {
        false
    }

    /// Connects only side `a`, its peer raw bytes this fixture hands to the
    /// transport verbatim. Only called when [`Fixture::supports_raw`] returns
    /// `true`; the default panics; a fixture that returns `true` must
    /// override this too.
    fn connect_raw(&self, _a: SessionOptions) -> impl Future<Output = Self::Raw> + Send {
        async {
            unimplemented!("Fixture::supports_raw() returned true with no connect_raw() override")
        }
    }
}

/// Side `a`'s identity in every conformance case.
///
/// # Example
///
/// ```
/// use mango_protocol::testing::conformance_a;
///
/// assert_eq!(conformance_a().role, "hub");
/// ```
#[must_use]
pub fn conformance_a() -> PeerInfo {
    PeerInfo {
        name: "conformance-a".into(),
        version: "a.0".into(),
        role: "hub".into(),
    }
}

/// Side `b`'s identity in every conformance case.
#[must_use]
pub fn conformance_b() -> PeerInfo {
    PeerInfo {
        name: "conformance-b".into(),
        version: "b.0".into(),
        role: "runtime".into(),
    }
}

/// The `test.echo`/`test.bulk`/`test.forever`/`test.refuse` handlers every
/// case needs, registered for `peer`, with liveness disabled (mirrors the
/// TypeScript suite's `livenessIntervalMs: false` — the conformance cases
/// have their own timing, not this session's ping cadence). A case that
/// needs a different protocol version or frame ceiling chains a further
/// `with_*` call on the result.
///
/// # Example
///
/// ```
/// use mango_protocol::testing::{conformance_a, conformance_options};
///
/// let options = conformance_options(conformance_a());
/// assert!(options.liveness_interval.is_none());
/// ```
#[must_use]
pub fn conformance_options(peer: PeerInfo) -> SessionOptions {
    SessionOptions::new(peer)
        .with_liveness_interval(None)
        .handle("test.echo", echo)
        .handle("test.bulk", bulk)
        .handle("test.forever", forever)
        .handle("test.refuse", refuse)
}

/// Connects `fixture` with both sides' default conformance options — the
/// `conformance_a()`/`conformance_b()` pairing nearly every case uses.
async fn connect_default<F: Fixture>(fixture: &F) -> F::Pair {
    fixture
        .connect(
            conformance_options(conformance_a()),
            conformance_options(conformance_b()),
        )
        .await
}

/// Echoes its params back so a case can prove what crossed the wire.
async fn echo(params: Value, _context: CallContext) -> Result<Value, RemoteError> {
    Ok(params)
}

/// Produces a result of a requested byte size, to exercise limits.
async fn bulk(params: Value, _context: CallContext) -> Result<Value, RemoteError> {
    let bytes = params.get("bytes").and_then(Value::as_u64).ok_or_else(|| {
        RemoteError::new(
            codes::INVALID_PARAMS,
            "Parameters of \"test.bulk\" must be an object with a numeric \"bytes\" member.",
        )
    })?;
    let bytes = usize::try_from(bytes).unwrap_or(usize::MAX);
    Ok(json!({ "blob": "x".repeat(bytes) }))
}

/// Never settles until its token is cancelled, so `cancel` has something to
/// abort.
async fn forever(_params: Value, context: CallContext) -> Result<Value, RemoteError> {
    context.cancel().cancelled().await;
    Err(RemoteError::new(
        codes::CANCELLED,
        "\"test.forever\" was cancelled.",
    ))
}

/// Fails with a chosen wire code, echoing it back in `details`.
async fn refuse(params: Value, _context: CallContext) -> Result<Value, RemoteError> {
    let code = params
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or(codes::INTERNAL);
    let message = params
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("refused");
    Err(RemoteError::new(code, message).with_detail("echoed", true))
}

/// Lets a request or event actually cross the fixture's transport and reach
/// the peer before the next assertion. This suite runs in real time (a
/// fixture need not support paused time), so a short sleep is the direct
/// equivalent of the TypeScript suite's own `settled()` helper.
async fn settled() {
    tokio::time::sleep(Duration::from_millis(20)).await;
}

/// Every case name this suite runs, in the order `packages/protocol/src/
/// testing/conformance.ts` declares them, before [`Fixture::chunked`] and
/// [`Fixture::supports_raw`] gate the last three. `tests/conformance_drift.rs`
/// asserts this list, not the runner's control flow, matches that file's own
/// `it(...)` names verbatim; [`run_conformance_suite`] asserts its own control
/// flow matches this list, so the two checks cannot silently drift apart.
///
/// # Example
///
/// ```
/// use mango_protocol::testing::CONFORMANCE_CASES;
///
/// assert_eq!(CONFORMANCE_CASES.len(), 23);
/// ```
pub const CONFORMANCE_CASES: [&str; 23] = [
    "completes the handshake in both directions and exposes the peers",
    "negotiates the effective minor downward",
    "refuses a different major with 4426 on both sides",
    "round-trips a request and its result in both directions",
    "serves concurrent requests in both directions",
    "reports an unsupported method without ending the session",
    "carries a handler-chosen error code and its details",
    "refuses a request past the in-flight ceiling and stays open",
    "refuses a reserved rpc. method before it reaches the wire",
    "refuses rpc.discover below the minor that defines it",
    "delivers an event stream and its end marker in order",
    "numbers events per topic when no stream id is given",
    "refuses one stream key past the local ceiling",
    "answers a protocol ping with a pong in both directions",
    "cancels an in-flight request and reports it as cancelled",
    "times out a request locally and ignores the late answer",
    "fails in-flight requests with UNAVAILABLE when the connection drops",
    "propagates a close reason code to the peer",
    "refuses a result past the frame limit without ending the session",
    "honours the lower announced frame limit when sending",
    "keeps two concurrent oversized results from interleaving",
    "closes with 4426 when the peer sends a hello it cannot read",
    "ignores unknown envelope members",
];

async fn completes_the_handshake_in_both_directions_and_exposes_the_peers<F: Fixture>(fixture: &F) {
    let mut pair = connect_default(fixture).await;
    let (from_a, from_b) = tokio::join!(pair.a().ready(), pair.b().ready());
    let from_a = from_a.expect("a's handshake succeeds");
    let from_b = from_b.expect("b's handshake succeeds");
    assert_eq!(from_a.peer, conformance_b());
    assert_eq!(from_b.peer, conformance_a());
    assert_eq!(from_a.effective_minor, from_b.effective_minor);
    assert_eq!(pair.a().state(), SessionState::Ready);
    assert_eq!(pair.b().state(), SessionState::Ready);
    pair.close().await;
}

async fn negotiates_the_effective_minor_downward<F: Fixture>(fixture: &F) {
    let a = conformance_options(conformance_a()).with_protocol(ProtocolVersion::new(1, 3));
    let b = conformance_options(conformance_b()).with_protocol(ProtocolVersion::new(1, 1));
    let mut pair = fixture.connect(a, b).await;
    let (from_a, from_b) = tokio::join!(pair.a().ready(), pair.b().ready());
    let from_a = from_a.expect("compatible majors negotiate");
    let from_b = from_b.expect("compatible majors negotiate");
    assert_eq!(from_a.effective_minor, 1);
    assert_eq!(from_b.effective_minor, 1);
    assert_eq!(from_a.protocol, ProtocolVersion::new(1, 1));
    assert_eq!(from_b.protocol, ProtocolVersion::new(1, 3));
    pair.close().await;
}

async fn refuses_a_different_major_with_4426_on_both_sides<F: Fixture>(fixture: &F) {
    let a = conformance_options(conformance_a()).with_protocol(ProtocolVersion::new(2, 0));
    let b = conformance_options(conformance_b());
    let mut pair = fixture.connect(a, b).await;
    let error_a = pair
        .a()
        .ready()
        .await
        .expect_err("a major mismatch refuses readiness");
    assert_eq!(error_a.code, codes::PROTOCOL_MISMATCH);
    let error_b = pair
        .b()
        .ready()
        .await
        .expect_err("a major mismatch refuses readiness");
    assert_eq!(error_b.code, codes::PROTOCOL_MISMATCH);
    let closure_a = pair.a().closed().await;
    let closure_b = pair.b().closed().await;
    assert_eq!(closure_a.code, close_codes::PROTOCOL_MISMATCH);
    assert_eq!(closure_b.code, close_codes::PROTOCOL_MISMATCH);
    assert!(closure_a.fatal);
    pair.close().await;
}

async fn round_trips_a_request_and_its_result_in_both_directions<F: Fixture>(fixture: &F) {
    let mut pair = connect_default(fixture).await;
    let params = json!({ "nested": { "list": [1, 2, 3], "text": "héllo · ünicode · 🥭" } });
    let echoed = pair
        .a()
        .request("test.echo", params.clone())
        .await
        .expect("test.echo succeeds");
    assert_eq!(echoed, params);
    let echoed_b = pair
        .b()
        .request("test.echo", json!({ "from": "b" }))
        .await
        .expect("test.echo succeeds");
    assert_eq!(echoed_b, json!({ "from": "b" }));
    pair.close().await;
}

async fn serves_concurrent_requests_in_both_directions<F: Fixture>(fixture: &F) {
    let mut pair = connect_default(fixture).await;
    let (r1, r2, r3, r4) = tokio::join!(
        pair.a().request("test.echo", json!(1)),
        pair.b().request("test.echo", json!(2)),
        pair.a().request("test.echo", json!(3)),
        pair.b().request("test.echo", json!(4)),
    );
    assert_eq!(r1.expect("succeeds"), json!(1));
    assert_eq!(r2.expect("succeeds"), json!(2));
    assert_eq!(r3.expect("succeeds"), json!(3));
    assert_eq!(r4.expect("succeeds"), json!(4));
    pair.close().await;
}

async fn reports_an_unsupported_method_without_ending_the_session<F: Fixture>(fixture: &F) {
    let mut pair = connect_default(fixture).await;
    let error = pair
        .a()
        .request("test.absent", json!({}))
        .await
        .expect_err("no handler is registered");
    assert_eq!(error.code, codes::METHOD_UNSUPPORTED);
    let ok = pair
        .a()
        .request("test.echo", json!({ "ok": true }))
        .await
        .expect("the session is still open");
    assert_eq!(ok, json!({ "ok": true }));
    pair.close().await;
}

async fn carries_a_handler_chosen_error_code_and_its_details<F: Fixture>(fixture: &F) {
    let mut pair = connect_default(fixture).await;
    let error = pair
        .a()
        .request(
            "test.refuse",
            json!({ "code": "APP_REFUSED", "message": "no" }),
        )
        .await
        .expect_err("the handler refuses");
    assert_eq!(error.code, "APP_REFUSED");
    assert_eq!(error.message, "no");
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|details| details.get("echoed")),
        Some(&json!(true))
    );
    pair.close().await;
}

async fn refuses_a_request_past_the_in_flight_ceiling_and_stays_open<F: Fixture>(fixture: &F) {
    let mut pair = fixture
        .connect(
            conformance_options(conformance_a()),
            conformance_options(conformance_b()).with_max_in_flight(1),
        )
        .await;
    let cancel = CancellationToken::new();
    let a = pair.a().clone();
    let held_options = RequestOptions {
        cancel: Some(cancel.clone()),
        ..Default::default()
    };
    let held = tokio::spawn(async move {
        a.request_with("test.forever", json!({}), held_options)
            .await
    });
    settled().await;

    let refused = pair
        .a()
        .request("test.echo", json!({ "queued": true }))
        .await
        .expect_err("b is already holding its one slot");
    assert_eq!(refused.code, codes::UNAVAILABLE);
    let details = refused
        .details
        .as_ref()
        .expect("the refusal names its kind");
    assert_eq!(details.get("kind"), Some(&json!("in_flight_limit")));
    assert_eq!(details.get("limit"), Some(&json!(1)));

    // Retryable, not fatal: the slot frees when the held request settles and
    // the very same call goes through.
    cancel.cancel();
    let _ = held.await.expect("the held request task did not panic");
    settled().await;
    let answer = pair
        .a()
        .request("test.echo", json!({ "queued": true }))
        .await
        .expect("the slot freed");
    assert_eq!(answer, json!({ "queued": true }));
    pair.close().await;
}

async fn refuses_a_reserved_rpc_method_before_it_reaches_the_wire<F: Fixture>(fixture: &F) {
    let mut pair = connect_default(fixture).await;
    // Undefined at every minor, so it never reaches the peer at all.
    let error = pair
        .a()
        .request("rpc.nowhere", json!({}))
        .await
        .expect_err("rpc. is reserved");
    assert_eq!(error.code, codes::INVALID_REQUEST);
    pair.close().await;
}

async fn refuses_rpc_discover_below_the_minor_that_defines_it<F: Fixture>(fixture: &F) {
    let b = conformance_options(conformance_b()).with_protocol(ProtocolVersion::new(1, 0));
    let mut pair = fixture
        .connect(conformance_options(conformance_a()), b)
        .await;
    let remote = pair.a().ready().await.expect("the handshake succeeds");
    assert_eq!(remote.effective_minor, 0);

    // A 1.0 peer cannot have meant this method, so the requester never sends
    // it: the refusal is local and names the minor it needed.
    let error = pair
        .a()
        .request("rpc.discover", json!({}))
        .await
        .expect_err("rpc.discover is defined from minor 1");
    assert_eq!(error.code, codes::INVALID_REQUEST);
    let details = error.details.as_ref().expect("the refusal names the minor");
    assert_eq!(details.get("effectiveMinor"), Some(&json!(0)));

    let answer = pair
        .a()
        .request("test.echo", json!({ "alive": true }))
        .await
        .expect("the session is unharmed");
    assert_eq!(answer, json!({ "alive": true }));
    pair.close().await;
}

async fn delivers_an_event_stream_and_its_end_marker_in_order<F: Fixture>(fixture: &F) {
    let mut pair = connect_default(fixture).await;
    // emit() no-ops (Ok(false)) before the handshake completes; both sides
    // must be ready before the first one, or it silently never reaches the
    // wire and the recv() below waits forever.
    pair.a().ready().await.expect("a is ready");
    pair.b().ready().await.expect("b is ready");
    let mut events = pair.a().events();

    let emit = |payload: Value, end: bool| EventInput {
        topic: "test.stream".into(),
        payload,
        stream_id: Some("stream-1".into()),
        end,
    };
    assert!(
        pair.b()
            .emit(emit(json!({ "line": "first" }), false))
            .expect("emits")
    );
    assert!(
        pair.b()
            .emit(emit(json!({ "line": "second" }), false))
            .expect("emits")
    );
    assert!(
        pair.b()
            .emit(emit(json!({ "line": "last" }), true))
            .expect("emits")
    );
    // One round trip after the last emit guarantees every event landed.
    pair.a()
        .request("test.echo", json!({}))
        .await
        .expect("round trip barrier");

    let first = events.recv().await.expect("the stream stays open");
    let second = events.recv().await.expect("the stream stays open");
    let last = events.recv().await.expect("the stream stays open");
    assert_eq!(first.seq, 0);
    assert_eq!(first.payload, json!({ "line": "first" }));
    assert_eq!(first.end, None);
    assert_eq!(second.seq, 1);
    assert_eq!(second.payload, json!({ "line": "second" }));
    assert_eq!(last.seq, 2);
    assert_eq!(last.payload, json!({ "line": "last" }));
    assert!(last.end.is_some());

    // The stream key was released: the next event on it restarts at zero.
    assert!(pair.b().emit(emit(Value::Null, false)).expect("emits"));
    pair.a()
        .request("test.echo", json!({}))
        .await
        .expect("round trip barrier");
    let restarted = events.recv().await.expect("the stream stays open");
    assert_eq!(restarted.seq, 0);

    pair.close().await;
}

async fn numbers_events_per_topic_when_no_stream_id_is_given<F: Fixture>(fixture: &F) {
    let mut pair = connect_default(fixture).await;
    // See delivers_an_event_stream_and_its_end_marker_in_order: emit() no-ops
    // before the handshake completes.
    pair.a().ready().await.expect("a is ready");
    pair.b().ready().await.expect("b is ready");
    let mut events = pair.b().events();
    assert!(
        pair.a()
            .emit(EventInput {
                topic: "test.heartbeat".into(),
                payload: json!({ "at": 1 }),
                stream_id: None,
                end: false,
            })
            .expect("emits")
    );
    assert!(
        pair.a()
            .emit(EventInput {
                topic: "test.heartbeat".into(),
                payload: json!({ "at": 2 }),
                stream_id: None,
                end: false,
            })
            .expect("emits")
    );
    pair.b()
        .request("test.echo", json!({}))
        .await
        .expect("round trip barrier");
    let first = events.recv().await.expect("the stream stays open");
    let second = events.recv().await.expect("the stream stays open");
    assert_eq!(first.seq, 0);
    assert_eq!(second.seq, 1);
    pair.close().await;
}

async fn refuses_one_stream_key_past_the_local_ceiling<F: Fixture>(fixture: &F) {
    let mut pair = fixture
        .connect(
            conformance_options(conformance_a()).with_max_stream_keys(2),
            conformance_options(conformance_b()),
        )
        .await;
    pair.a().ready().await.expect("a is ready");
    pair.b().ready().await.expect("b is ready");

    let emit = |stream: &str, end: bool| EventInput {
        topic: "test.stream".into(),
        payload: Value::Null,
        stream_id: Some(stream.into()),
        end,
    };
    assert_eq!(pair.a().emit(emit("s-1", false)), Ok(true));
    assert_eq!(pair.a().emit(emit("s-2", false)), Ok(true));

    // Local, so nothing reaches the peer: a sender at this ceiling has leaked
    // stream ids, which is a defect in the sender.
    let refused = pair
        .a()
        .emit(emit("s-3", false))
        .expect_err("a third key is one past the ceiling");
    assert_eq!(refused.code, codes::UNAVAILABLE);
    let details = refused
        .details
        .as_ref()
        .expect("the refusal names its kind");
    assert_eq!(details.get("kind"), Some(&json!("stream_key_limit")));

    assert_eq!(pair.a().emit(emit("s-1", true)), Ok(true));
    assert_eq!(pair.a().emit(emit("s-3", false)), Ok(true));
    pair.close().await;
}

async fn answers_a_protocol_ping_with_a_pong_in_both_directions<F: Fixture>(fixture: &F) {
    let mut pair = connect_default(fixture).await;
    let mut pongs_a = pair.a().pongs();
    let mut pongs_b = pair.b().pongs();
    pair.a().ping();
    pair.b().ping();
    pongs_a.recv().await.expect("a receives a pong");
    pongs_b.recv().await.expect("b receives a pong");
    pair.close().await;
}

async fn cancels_an_in_flight_request_and_reports_it_as_cancelled<F: Fixture>(fixture: &F) {
    let mut pair = connect_default(fixture).await;
    let cancel = CancellationToken::new();
    let a = pair.a().clone();
    let options = RequestOptions {
        cancel: Some(cancel.clone()),
        ..Default::default()
    };
    let pending =
        tokio::spawn(async move { a.request_with("test.forever", json!({}), options).await });
    settled().await;
    cancel.cancel();
    let error = pending
        .await
        .expect("the request task did not panic")
        .expect_err("the request was cancelled");
    assert_eq!(error.code, codes::CANCELLED);
    pair.close().await;
}

async fn times_out_a_request_locally_and_ignores_the_late_answer<F: Fixture>(fixture: &F) {
    let mut pair = connect_default(fixture).await;
    let options = RequestOptions {
        timeout: Some(Duration::from_millis(50)),
        ..Default::default()
    };
    let error = pair
        .a()
        .request_with("test.forever", json!({}), options)
        .await
        .expect_err("the local deadline passes");
    assert_eq!(error.code, codes::TIMEOUT);
    let ok = pair
        .a()
        .request("test.echo", json!({ "still": "alive" }))
        .await
        .expect("the session is still open");
    assert_eq!(ok, json!({ "still": "alive" }));
    pair.close().await;
}

async fn fails_in_flight_requests_with_unavailable_when_the_connection_drops<F: Fixture>(
    fixture: &F,
) {
    let mut pair = connect_default(fixture).await;
    let a = pair.a().clone();
    let pending = tokio::spawn(async move { a.request("test.forever", json!({})).await });
    settled().await;
    pair.sever().await;
    let error = pending
        .await
        .expect("the request task did not panic")
        .expect_err("the connection dropped");
    assert_eq!(error.code, codes::UNAVAILABLE);
    // Teardown flips the state (step 2) before it fails pending requests
    // (step 5), so by the time `pending` above yielded UNAVAILABLE the state
    // was already Closed; no further wait needed.
    assert_eq!(pair.a().state(), SessionState::Closed);
    pair.close().await;
}

async fn propagates_a_close_reason_code_to_the_peer<F: Fixture>(fixture: &F) {
    let mut pair = connect_default(fixture).await;
    pair.a().ready().await.expect("a is ready");
    pair.b().ready().await.expect("b is ready");
    pair.b().close_now(
        close_codes::SUPERSEDED,
        Some("superseded by a newer connection"),
    );
    let closure = pair.a().closed().await;
    assert_eq!(closure.code, close_codes::SUPERSEDED);
    assert!(closure.fatal);
    let closure_b = pair
        .b()
        .closure()
        .expect("b already recorded its own closure");
    assert_eq!(closure_b.code, close_codes::SUPERSEDED);
    pair.close().await;
}

async fn refuses_a_result_past_the_frame_limit_without_ending_the_session<F: Fixture>(fixture: &F) {
    let mut pair = connect_default(fixture).await;
    let options = RequestOptions {
        timeout: Some(Duration::from_secs(30)),
        ..Default::default()
    };
    let error = pair
        .a()
        .request_with(
            "test.bulk",
            json!({ "bytes": DEFAULT_MAX_FRAME_BYTES + 1 }),
            options,
        )
        .await
        .expect_err("the result exceeds the frame limit");
    assert_eq!(error.code, codes::FRAME_TOO_LARGE);
    let ok = pair
        .a()
        .request("test.echo", json!({ "ok": true }))
        .await
        .expect("the session is still open");
    assert_eq!(ok, json!({ "ok": true }));
    pair.close().await;
}

async fn honours_the_lower_announced_frame_limit_when_sending<F: Fixture>(fixture: &F) {
    let a = conformance_options(conformance_a()).with_max_frame_bytes(4096);
    let mut pair = fixture
        .connect(a, conformance_options(conformance_b()))
        .await;
    let too_big = pair
        .a()
        .request("test.bulk", json!({ "bytes": 8192 }))
        .await
        .expect_err("the result exceeds the announced ceiling");
    assert_eq!(too_big.code, codes::FRAME_TOO_LARGE);
    let ok = pair
        .a()
        .request("test.bulk", json!({ "bytes": 1024 }))
        .await
        .expect("within the announced ceiling");
    assert_eq!(ok, json!({ "blob": "x".repeat(1024) }));
    pair.close().await;
}

async fn keeps_two_concurrent_oversized_results_from_interleaving<F: Fixture>(fixture: &F) {
    let mut pair = connect_default(fixture).await;
    let size = 512 * 1024;
    let long_timeout = || RequestOptions {
        timeout: Some(Duration::from_secs(30)),
        ..Default::default()
    };
    let (first, second) = tokio::join!(
        pair.a()
            .request_with("test.bulk", json!({ "bytes": size }), long_timeout()),
        pair.a()
            .request_with("test.bulk", json!({ "bytes": size + 1 }), long_timeout()),
    );
    let first = first.expect("the first bulk result arrives");
    let second = second.expect("the second bulk result arrives");
    assert_eq!(first["blob"].as_str().map(str::len), Some(size));
    assert_eq!(second["blob"].as_str().map(str::len), Some(size + 1));
    pair.close().await;
}

async fn closes_with_4426_when_the_peer_sends_a_hello_it_cannot_read<F: Fixture>(fixture: &F) {
    let mut raw = fixture
        .connect_raw(conformance_options(conformance_a()))
        .await;
    raw.write(
        "{\"type\":\"hello\",\"protocolVersion\":\"1.0.1\",\"runtimeVersion\":\"0.1.1\",\"manifest\":{}}",
    )
    .await;
    let error = raw
        .a()
        .ready()
        .await
        .expect_err("an unreadable hello refuses readiness");
    assert_eq!(error.code, codes::PROTOCOL_MISMATCH);
    let closure = raw.a().closed().await;
    assert_eq!(closure.code, close_codes::PROTOCOL_MISMATCH);
    assert!(closure.fatal);
    raw.close().await;
}

async fn ignores_unknown_envelope_members<F: Fixture>(fixture: &F) {
    let mut raw = fixture
        .connect_raw(conformance_options(conformance_a()))
        .await;
    raw.write(
        "{\"type\":\"hello\",\"protocol\":{\"major\":1,\"minor\":0},\"peer\":{\"name\":\"raw\",\
         \"version\":\"0\",\"role\":\"tool\"},\"capabilities\":{},\"x-vendor\":{\"trace\":1},\
         \"future\":true}",
    )
    .await;
    let remote = raw
        .a()
        .ready()
        .await
        .expect("a well-formed hello with unknown members still succeeds");
    assert_eq!(remote.peer.name, "raw");
    let mut pongs = raw.a().pongs();
    raw.write("{\"type\":\"pong\",\"x-at\":1}").await;
    pongs
        .recv()
        .await
        .expect("the pong still arrives despite the unknown member");
    raw.close().await;
}

/// Bounds one case: generous enough for the two bulk cases' own 30-second
/// request timeouts (mirrors the TypeScript suite's `BULK_TIMEOUT_MS`), short
/// enough that a regression hangs for seconds, not a whole CI job.
const CASE_TIMEOUT: Duration = Duration::from_secs(60);

/// Runs every case `fixture` supports, in the order [`CONFORMANCE_CASES`]
/// lists them; panics naming the first case that fails or hangs.
///
/// # Panics
/// Panics (via `assert!`/`assert_eq!`, an unexpected `Err`, or exceeding the
/// per-case timeout) on the first case that fails to behave as the
/// specification requires, and if the cases this run actually executed do
/// not match [`CONFORMANCE_CASES`] filtered by [`Fixture::chunked`]/
/// [`Fixture::supports_raw`] — a self-check that keeps this function's own
/// control flow from drifting away from the list `tests/conformance_drift.rs`
/// checks against the TypeScript suite.
pub async fn run_conformance_suite<F: Fixture>(fixture: &F) {
    let mut ran: Vec<&'static str> = Vec::with_capacity(CONFORMANCE_CASES.len());
    macro_rules! case {
        ($index:expr, $call:expr) => {{
            let name = CONFORMANCE_CASES[$index];
            tokio::time::timeout(CASE_TIMEOUT, $call)
                .await
                .unwrap_or_else(|_| {
                    panic!("conformance case {name:?} did not resolve within {CASE_TIMEOUT:?}")
                });
            ran.push(name);
        }};
    }

    case!(
        0,
        completes_the_handshake_in_both_directions_and_exposes_the_peers(fixture)
    );
    case!(1, negotiates_the_effective_minor_downward(fixture));
    case!(
        2,
        refuses_a_different_major_with_4426_on_both_sides(fixture)
    );
    case!(
        3,
        round_trips_a_request_and_its_result_in_both_directions(fixture)
    );
    case!(4, serves_concurrent_requests_in_both_directions(fixture));
    case!(
        5,
        reports_an_unsupported_method_without_ending_the_session(fixture)
    );
    case!(
        6,
        carries_a_handler_chosen_error_code_and_its_details(fixture)
    );
    case!(
        7,
        refuses_a_request_past_the_in_flight_ceiling_and_stays_open(fixture)
    );
    case!(
        8,
        refuses_a_reserved_rpc_method_before_it_reaches_the_wire(fixture)
    );
    case!(
        9,
        refuses_rpc_discover_below_the_minor_that_defines_it(fixture)
    );
    case!(
        10,
        delivers_an_event_stream_and_its_end_marker_in_order(fixture)
    );
    case!(
        11,
        numbers_events_per_topic_when_no_stream_id_is_given(fixture)
    );
    case!(12, refuses_one_stream_key_past_the_local_ceiling(fixture));
    case!(
        13,
        answers_a_protocol_ping_with_a_pong_in_both_directions(fixture)
    );
    case!(
        14,
        cancels_an_in_flight_request_and_reports_it_as_cancelled(fixture)
    );
    case!(
        15,
        times_out_a_request_locally_and_ignores_the_late_answer(fixture)
    );
    case!(
        16,
        fails_in_flight_requests_with_unavailable_when_the_connection_drops(fixture)
    );
    case!(17, propagates_a_close_reason_code_to_the_peer(fixture));
    case!(
        18,
        refuses_a_result_past_the_frame_limit_without_ending_the_session(fixture)
    );
    case!(
        19,
        honours_the_lower_announced_frame_limit_when_sending(fixture)
    );

    if fixture.chunked() {
        case!(
            20,
            keeps_two_concurrent_oversized_results_from_interleaving(fixture)
        );
    }
    if fixture.supports_raw() {
        case!(
            21,
            closes_with_4426_when_the_peer_sends_a_hello_it_cannot_read(fixture)
        );
        case!(22, ignores_unknown_envelope_members(fixture));
    }

    let mut expected: Vec<&'static str> = CONFORMANCE_CASES[..20].to_vec();
    if fixture.chunked() {
        expected.push(CONFORMANCE_CASES[20]);
    }
    if fixture.supports_raw() {
        expected.push(CONFORMANCE_CASES[21]);
        expected.push(CONFORMANCE_CASES[22]);
    }
    assert_eq!(
        ran, expected,
        "the cases this run actually executed must match CONFORMANCE_CASES, filtered by chunked()/supports_raw()"
    );
}
