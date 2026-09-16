//! The WebSocket transport of `spec/transports/websocket.md`: one connection
//! carries one session, frames travel as chunked binary messages under the
//! `mango.v1` subprotocol, and the WebSocket close code carries the reason
//! code.
//!
//! This module owns no server. [`websocket_port`] takes an already-upgraded
//! [`WebSocketStream`] and hands back a [`Port`], so the same code serves a
//! socket a `hyper` upgrade produced, one `tokio-tungstenite` accepted, and
//! one [`connect`](client::connect_websocket) dialled. [`client`] dials;
//! [`server`] does the upgrade-time work — the subprotocol and the bearer —
//! for a peer that has no HTTP stack of its own yet.

use std::future::{Future, poll_fn};
use std::marker::PhantomData;
use std::pin::pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, WebSocketConfig};

use crate::close::{close_code_for_codec_error, close_codes};
use crate::codec::chunk::{
    CHUNK_HEADER_BYTES, ChunkReassembler, DEFAULT_MAX_MESSAGE_BYTES, encode_chunks,
};
use crate::codec::ndjson::DEFAULT_MAX_FRAME_BYTES;
use crate::error::{CodecError, CodecErrorKind};
use crate::frame::Frame;
use crate::port::{Inbound, Port, PortClosure, PortRx, PortTx, SendOutcome};

use super::CLOSE_FLUSH_GRACE;
use super::ndjson::clamp_reason;

pub mod client;
pub mod server;

/// The subprotocol a Mango Protocol 1 dialler offers and an acceptor selects.
pub const WEBSOCKET_SUBPROTOCOL: &str = "mango.v1";

/// RFC 6455 caps the close reason at 123 UTF-8 bytes; the `close` frame
/// carries the full one.
const MAX_CLOSE_REASON_BYTES: usize = 123;

/// Recorded on both halves when the writer gives up on a queue that outgrew
/// one frame limit while the socket was not draining.
const STALLED_QUEUE_REASON: &str =
    "the send queue outgrew one frame limit while the socket was not draining";

/// How this transport frames, and how much it will hold for a socket that is
/// not draining.
///
/// # Example
///
/// ```
/// use mango_protocol::transports::websocket::WebSocketOptions;
///
/// let options = WebSocketOptions::default().with_max_message_bytes(2048);
/// assert_eq!(options.max_message_bytes, 2048);
/// ```
#[derive(Debug, Clone, Copy)]
pub struct WebSocketOptions {
    /// Largest frame this port reassembles and sends; 16 MiB by default (§11).
    pub max_frame_bytes: usize,
    /// Message ceiling for the chunker. The reference 16 KiB is also what a
    /// Bun server caps an inbound message at, so a Rust peer never sends one
    /// a Bun hub would drop.
    pub max_message_bytes: usize,
    /// Send a `close` frame before closing the socket. The close code already
    /// carries the reason, so a peer may turn it off; when both are sent the
    /// frame goes first.
    pub send_close_frame: bool,
}

impl Default for WebSocketOptions {
    fn default() -> Self {
        Self {
            max_frame_bytes: DEFAULT_MAX_FRAME_BYTES,
            max_message_bytes: DEFAULT_MAX_MESSAGE_BYTES,
            send_close_frame: true,
        }
    }
}

impl WebSocketOptions {
    /// Sets the frame ceiling this port reassembles and sends within.
    ///
    /// # Panics
    ///
    /// Panics when `max_frame_bytes` is below
    /// [`crate::codec::ndjson::MIN_MAX_FRAME_BYTES`], naming both.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::transports::websocket::WebSocketOptions;
    ///
    /// let options = WebSocketOptions::default().with_max_frame_bytes(1 << 20);
    /// assert_eq!(options.max_frame_bytes, 1 << 20);
    /// ```
    #[must_use]
    pub fn with_max_frame_bytes(mut self, max_frame_bytes: usize) -> Self {
        self.max_frame_bytes = crate::codec::limits::check_max_frame_bytes(max_frame_bytes);
        self
    }

    /// Sets the message ceiling the chunker splits a frame to fit.
    ///
    /// # Panics
    ///
    /// Panics when `max_message_bytes` is below
    /// [`crate::codec::chunk::MIN_MAX_MESSAGE_BYTES`], naming both.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::transports::websocket::WebSocketOptions;
    ///
    /// let options = WebSocketOptions::default().with_max_message_bytes(4096);
    /// assert_eq!(options.max_message_bytes, 4096);
    /// ```
    #[must_use]
    pub fn with_max_message_bytes(mut self, max_message_bytes: usize) -> Self {
        self.max_message_bytes = crate::codec::limits::check_at_least(
            "max_message_bytes",
            max_message_bytes,
            crate::codec::chunk::MIN_MAX_MESSAGE_BYTES,
        );
        self
    }

    /// Stops the port writing a `close` frame ahead of the socket close.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::transports::websocket::WebSocketOptions;
    ///
    /// let options = WebSocketOptions::default().without_close_frame();
    /// assert!(!options.send_close_frame);
    /// ```
    #[must_use]
    pub const fn without_close_frame(mut self) -> Self {
        self.send_close_frame = false;
        self
    }

    /// The tungstenite configuration these options imply.
    ///
    /// The queue the spec's Backpressure section is about is this port's own,
    /// not tungstenite's: it writes straight through to the socket, so its
    /// write buffer never accumulates and could not be measured.
    ///
    /// The ceiling here bounds an *incoming* message, and it is deliberately
    /// not [`WebSocketOptions::max_message_bytes`]. That number is this
    /// sender's own setting — websocket.md calls it "a local setting of at
    /// least 2048 bytes" — and the receiver's obligations, which the spec
    /// lists exhaustively, include no ceiling on a message at all. A peer is
    /// free to put a whole frame in one message, so that is what is allowed;
    /// the reassembler still refuses anything whose payload passes the frame
    /// limit.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::codec::chunk::CHUNK_HEADER_BYTES;
    /// use mango_protocol::transports::websocket::WebSocketOptions;
    ///
    /// // A peer that sends one 2 KiB chunk and a peer that sends the whole
    /// // frame at once are both conforming, so neither is cut off.
    /// let options = WebSocketOptions::default().with_max_message_bytes(2048);
    /// let config = options.socket_config();
    /// assert_eq!(
    ///     config.max_message_size,
    ///     Some(options.max_frame_bytes + CHUNK_HEADER_BYTES)
    /// );
    /// ```
    #[must_use]
    pub fn socket_config(&self) -> WebSocketConfig {
        let incoming = self.max_frame_bytes.saturating_add(CHUNK_HEADER_BYTES);
        WebSocketConfig::default()
            .max_message_size(Some(incoming))
            .max_frame_size(Some(incoming))
            // Every chunk goes to the socket as it is written; this port's own
            // queue is what holds anything back.
            .write_buffer_size(0)
    }
}

/// One WebSocket connection, as a [`Port`].
///
/// # Example
///
/// ```no_run
/// # #[tokio::main(flavor = "current_thread")]
/// # async fn main() {
/// use mango_protocol::frame::PeerInfo;
/// use mango_protocol::session::{Session, SessionOptions};
/// use mango_protocol::transports::websocket::{WebSocketOptions, websocket_port};
/// # async fn upgraded() -> tokio_tungstenite::WebSocketStream<tokio::net::TcpStream> { unimplemented!() }
///
/// let port = websocket_port(upgraded().await, WebSocketOptions::default());
/// let peer = PeerInfo { name: "hub".into(), version: "1".into(), role: "hub".into() };
/// let (_session, _driver) = Session::spawn(port, SessionOptions::new(peer));
/// # }
/// ```
#[derive(Debug)]
pub struct WebSocketPort<S> {
    stream: WebSocketStream<S>,
    options: WebSocketOptions,
}

/// Wraps an already-upgraded socket as a [`Port`].
///
/// Call it in the same turn the socket was upgraded: the peer sends its
/// `hello` the moment the upgrade completes, and nothing reads the socket
/// until this port does.
///
/// # Example
///
/// ```no_run
/// # #[tokio::main(flavor = "current_thread")]
/// # async fn main() {
/// use mango_protocol::port::Port;
/// use mango_protocol::transports::websocket::{WebSocketOptions, websocket_port};
/// # async fn upgraded() -> tokio_tungstenite::WebSocketStream<tokio::net::TcpStream> { unimplemented!() }
///
/// let port = websocket_port(upgraded().await, WebSocketOptions::default());
/// assert_eq!(port.max_frame_bytes(), Some(16 * 1024 * 1024));
/// # }
/// ```
#[must_use]
pub fn websocket_port<S>(stream: WebSocketStream<S>, options: WebSocketOptions) -> WebSocketPort<S>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    WebSocketPort { stream, options }
}

impl<S> Port for WebSocketPort<S>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    type Tx = WebSocketTx<S>;
    type Rx = WebSocketRx<S>;

    fn max_frame_bytes(&self) -> Option<usize> {
        Some(self.options.max_frame_bytes)
    }

    fn split(self) -> (Self::Tx, Self::Rx) {
        let options = self.options;
        let (sink, stream) = self.stream.split();
        let writer = SocketWriter::spawn(sink, options);
        let gave_up = writer.gave_up.subscribe();
        let tx = WebSocketTx {
            writer: writer.clone(),
            options,
            socket: PhantomData,
        };
        let rx = WebSocketRx {
            stream,
            reassembler: ChunkReassembler::new(options.max_message_bytes, options.max_frame_bytes),
            writer,
            gave_up,
            closure: None,
            terminal: false,
        };
        (tx, rx)
    }
}

/// The send half of a [`WebSocketPort`].
#[derive(Debug)]
pub struct WebSocketTx<S> {
    writer: SocketWriter,
    options: WebSocketOptions,
    /// Ties this half to the socket's own type, which the writer task owns.
    socket: PhantomData<fn() -> S>,
}

impl<S> PortTx for WebSocketTx<S>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    async fn send(&mut self, frame: Frame) -> SendOutcome {
        self.writer.send_frame(&frame).await
    }

    async fn close(self, code: u16, reason: Option<String>) {
        self.writer
            .close(code, reason.as_deref(), self.options.send_close_frame)
            .await;
    }
}

/// The receive half of a [`WebSocketPort`].
#[derive(Debug)]
pub struct WebSocketRx<S> {
    stream: SplitStream<WebSocketStream<S>>,
    reassembler: ChunkReassembler,
    writer: SocketWriter,
    /// True once the writer task gives up on a queue that outgrew one frame
    /// limit while the socket was not draining, before the write behind it
    /// ever resolves — see `drive`. A peer that stopped reading may also
    /// never send anything back, so `recv` cannot wait on `stream.next()`
    /// alone to learn the same thing the write half already decided.
    gave_up: watch::Receiver<bool>,
    /// Why the socket ended; held until it is the next thing to hand out.
    closure: Option<PortClosure>,
    terminal: bool,
}

impl<S> PortRx for WebSocketRx<S>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    async fn recv(&mut self) -> Option<Inbound> {
        loop {
            if let Some(closure) = self.closure.take() {
                self.terminal = true;
                return Some(Inbound::Closed(closure));
            }
            if self.terminal {
                return None;
            }
            // Checked before anything here awaits, the same way a closure
            // recorded from the socket itself is: a signal that landed while
            // this was handing out an earlier frame must not be missed.
            if *self.gave_up.borrow_and_update() {
                self.writer.mark_closed();
                self.closure = Some(PortClosure::Closed {
                    code: Some(close_codes::PROTOCOL_ERROR),
                    reason: Some(STALLED_QUEUE_REASON.to_owned()),
                });
                continue;
            }
            // `StreamExt::next` on a `SplitStream` is cancel-safe: a call
            // dropped because another `select!` branch won the race leaves a
            // partially received message in the socket's own buffer.
            let message = tokio::select! {
                message = self.stream.next() => message,
                _ = self.gave_up.changed() => {
                    // Nothing to do here: the next iteration's check at the
                    // top of the loop is what records and hands out the
                    // closure, exactly as it would if this arm had never won.
                    continue;
                }
            };
            match message {
                Some(Ok(message)) => {
                    if let Some(item) = self.on_message(message).await {
                        return Some(item);
                    }
                }
                Some(Err(error)) => {
                    // The socket is gone, exactly as it is when the peer sends
                    // a close frame: a send queued after this would be reported
                    // as sent and never carried.
                    self.writer.mark_closed();
                    self.closure = Some(PortClosure::Closed {
                        code: None,
                        reason: Some(error.to_string()),
                    });
                }
                None => {
                    self.writer.mark_closed();
                    self.closure = Some(PortClosure::Closed {
                        code: None,
                        reason: None,
                    });
                }
            }
        }
    }
}

impl<S> WebSocketRx<S>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    /// One incoming message, or `None` when it produced nothing a session
    /// needs to see yet.
    async fn on_message(&mut self, message: Message) -> Option<Inbound> {
        match message {
            Message::Binary(bytes) => match self.reassembler.push(&bytes) {
                Ok(Some(frame)) => Some(Inbound::Frame(frame)),
                Ok(None) => None,
                Err(error) => {
                    self.refuse(error).await;
                    None
                }
            },
            Message::Text(text) => {
                self.refuse(CodecError::new(
                    CodecErrorKind::Schema,
                    format!(
                        "received a text message of {} bytes, expected a binary message, the only kind {WEBSOCKET_SUBPROTOCOL} carries",
                        text.len()
                    ),
                ))
                .await;
                None
            }
            Message::Close(frame) => {
                // The socket is going; a send queued after this would be
                // reported as sent and never carried.
                self.writer.mark_closed();
                self.closure = Some(peer_closure(frame.as_ref()));
                None
            }
            // Control frames and raw frames are the socket's own business;
            // tungstenite answers a ping itself.
            Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => None,
        }
    }

    /// A message the decoder refused: tell the peer with the code the refusal
    /// maps to, then stop. A chunk stream cannot be resynchronised.
    async fn refuse(&mut self, error: CodecError) {
        let code = close_code_for_codec_error(&error);
        let reason = error.to_string();
        // Recorded before the await, never after: `recv` is cancel-safe, and a
        // closure written on the far side of an await is one a caller that
        // lost a `select!` race would never be told about. Losing it here
        // would downgrade a refusal to the plain release an ended socket
        // reports, so a dialler would retry a peer whose frames it cannot
        // read.
        self.closure = Some(PortClosure::ProtocolError { error, code });
        self.writer.close(code, Some(&reason), true).await;
    }
}

/// What the peer's close frame means to a session: a reason code from the
/// `4000..=4999` table, or the link simply ending.
fn peer_closure(frame: Option<&CloseFrame>) -> PortClosure {
    let Some(frame) = frame else {
        return PortClosure::Closed {
            code: None,
            reason: None,
        };
    };
    let code = u16::from(frame.code);
    if !(close_codes::RELEASED..=crate::close::MAX_CLOSE_CODE).contains(&code) {
        // `1000`, `1006` and the rest of RFC 6455's own range say nothing
        // about why the session ended.
        return PortClosure::Closed {
            code: None,
            reason: None,
        };
    }
    PortClosure::Closed {
        code: Some(code),
        reason: (!frame.reason.is_empty()).then(|| frame.reason.to_string()),
    }
}

/// The socket's send half, behind the one queue per connection that
/// websocket.md's Backpressure section describes.
///
/// A task owns the sink; a send hands its chunks over and returns. That is
/// what makes the queue observable at all: a sender that simply awaited the
/// socket would have no queue to measure, and a peer that stopped reading
/// would stall it for ever rather than be given up on. The counter is the
/// bytes handed over and not yet written, and passing one frame limit is the
/// signal the spec names.
///
/// The receive half holds one of these too, for the farewell a refused
/// message calls for — the same thing the TypeScript port writes from
/// `#failReceive`.
#[derive(Debug, Clone)]
struct SocketWriter {
    commands: mpsc::UnboundedSender<WriteCommand>,
    /// Bytes handed to the writer task and not yet written.
    queued_bytes: Arc<AtomicUsize>,
    /// False once anything closed the socket; every later send is reported as
    /// the transport being gone rather than queued behind a dead one.
    open: Arc<AtomicBool>,
    /// True while the socket has answered `Pending` to a write — it is holding
    /// what it was given rather than taking more.
    ///
    /// This is the "while the socket is not draining" half of websocket.md's
    /// Backpressure rule, and the counterpart of the TypeScript port's
    /// `#paused`. It stays true for as long as one write remains stuck, so
    /// every `send_frame` call in that window gets its own chance to see a
    /// backlog that grew past the limit *after* the write it is behind
    /// stalled — a single check made only at the instant of stalling could
    /// not see that growth, since nothing re-polls a write already suspended
    /// on the socket to notice the queue behind it changing shape.
    paused: Arc<AtomicBool>,
    /// Flips true the instant `drive` gives up on a queue that outgrew one
    /// frame limit while the socket was not draining, before the write behind
    /// it ever resolves. `WebSocketRx::recv` subscribes to this: a peer that
    /// stopped reading may also never send anything back, so nothing else
    /// would ever wake a `recv` blocked on that same peer.
    gave_up: Arc<watch::Sender<bool>>,
    /// Held, never read: dropping the last handle aborts the writer task, so
    /// one still stuck on a socket that will not take the farewell cannot
    /// outlive the port.
    _task: Arc<AbortOnDrop>,
    options: WebSocketOptions,
}

/// One item for the writer task.
#[derive(Debug)]
enum WriteCommand {
    /// One frame's chunks, written contiguously so two frames never
    /// interleave, and the byte count to release from the queue afterwards.
    Chunks {
        messages: Vec<Vec<u8>>,
        bytes: usize,
    },
    /// Close the socket with this code and stop.
    Close {
        code: u16,
        reason: Option<String>,
        done: oneshot::Sender<()>,
    },
}

/// A writer task that is aborted when the last handle to it goes.
#[derive(Debug)]
struct AbortOnDrop(JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

impl SocketWriter {
    fn spawn<S>(sink: SplitSink<WebSocketStream<S>, Message>, options: WebSocketOptions) -> Self
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let (commands, receiver) = mpsc::unbounded_channel();
        let queued_bytes = Arc::new(AtomicUsize::new(0));
        let open = Arc::new(AtomicBool::new(true));
        let paused = Arc::new(AtomicBool::new(false));
        let gave_up = Arc::new(watch::Sender::new(false));
        let task = tokio::spawn(drive(
            sink,
            receiver,
            Arc::clone(&queued_bytes),
            Arc::clone(&open),
            Arc::clone(&paused),
            Arc::clone(&gave_up),
            options,
        ));
        Self {
            commands,
            queued_bytes,
            open,
            paused,
            gave_up,
            _task: Arc::new(AbortOnDrop(task)),
            options,
        }
    }

    /// Queues one frame's chunks.
    ///
    /// Reports [`SendOutcome::Sent`] once they are the writer's, the way the
    /// TypeScript port reports a message the socket buffered. A queue that has
    /// passed one frame limit *while the socket is not draining* is a peer
    /// that is not reading: the socket is closed with `4400` and the session
    /// is told the transport is gone, rather than every pending response being
    /// held for a socket that may never drain. Both halves are required — a
    /// backlog on a socket that is still taking bytes is just a busy sender.
    ///
    /// This is not the only place that rule is judged: this function has no
    /// await on its happy path, so a caller that never sends again after the
    /// backlog passes the limit would never trigger this check at all. `drive`
    /// judges the same rule itself the instant a write answers `Pending`, for
    /// exactly that case.
    async fn send_frame(&self, frame: &Frame) -> SendOutcome {
        if !self.open.load(Ordering::Acquire) {
            return SendOutcome::Closed;
        }
        let messages = match encode_chunks(
            frame,
            self.options.max_message_bytes,
            self.options.max_frame_bytes,
        ) {
            Ok(messages) => messages,
            Err(error) => return SendOutcome::Refused(error),
        };
        let bytes: usize = messages.iter().map(Vec::len).sum();
        // What was already waiting, this frame excluded. A frame is never
        // measured against the limit by its own size: one of exactly the frame
        // limit is legal, and its chunk headers would push any total over.
        let waiting = self.queued_bytes.fetch_add(bytes, Ordering::AcqRel);
        if self
            .commands
            .send(WriteCommand::Chunks { messages, bytes })
            .is_err()
        {
            self.queued_bytes.fetch_sub(bytes, Ordering::AcqRel);
            self.open.store(false, Ordering::Release);
            return SendOutcome::Closed;
        }
        // Both halves of the rule, never the backlog alone: a queue over the
        // limit is only a peer that stopped reading if the socket is also not
        // taking what it is given.
        if waiting > self.options.max_frame_bytes && self.paused.load(Ordering::Acquire) {
            self.close(
                close_codes::PROTOCOL_ERROR,
                Some(STALLED_QUEUE_REASON),
                true,
            )
            .await;
            return SendOutcome::Closed;
        }
        SendOutcome::Sent
    }

    /// Closes the socket with the reason code, having queued the farewell
    /// frame of §10 ahead of it when this port sends one.
    ///
    /// Waits a bounded grace for the close to reach the socket: on a healthy
    /// connection that is immediate, and a peer that will not take it must not
    /// hold up a teardown.
    async fn close(&self, code: u16, reason: Option<&str>, send_close_frame: bool) {
        if !self.open.swap(false, Ordering::AcqRel) {
            return;
        }
        if send_close_frame {
            self.queue_farewell(code, reason);
        }
        let (done, finished) = oneshot::channel();
        if self
            .commands
            .send(WriteCommand::Close {
                code,
                reason: reason.map(ToOwned::to_owned),
                done,
            })
            .is_err()
        {
            return;
        }
        let _ = tokio::time::timeout(CLOSE_FLUSH_GRACE, finished).await;
    }

    /// Records that the socket is gone without writing anything: the peer
    /// closed it, so a frame queued after this would be reported as sent and
    /// never carried.
    fn mark_closed(&self) {
        self.open.store(false, Ordering::Release);
    }

    /// Queues the farewell of §10, keeping its code even when its reason is
    /// what will not encode.
    fn queue_farewell(&self, code: u16, reason: Option<&str>) {
        let Some(messages) = farewell_messages(code, reason, self.options) else {
            return;
        };
        let bytes: usize = messages.iter().map(Vec::len).sum();
        self.queued_bytes.fetch_add(bytes, Ordering::AcqRel);
        let _ = self.commands.send(WriteCommand::Chunks { messages, bytes });
    }
}

/// The farewell of §10 as chunk messages, dropping its reason if that is what
/// it takes to encode one.
///
/// The reason is the part that may not fit. It is clamped to the schema's
/// [`MAX_REASON_CHARS`](crate::validate::MAX_REASON_CHARS) first — a refusal
/// message, or a caller's own text, can run past it, and a frame the codec
/// refuses is one the peer never reads — and then dropped altogether if a
/// lowered frame limit still will not take it, because JSON escapes one NUL
/// into six bytes. The code is what the peer needs: dropping the whole record
/// for the sake of its reason would leave a refused peer with no `close` frame
/// at all, which is the same thing the NDJSON port refuses to do. `None` means
/// no `close` frame can be encoded with this code at all.
fn farewell_messages(
    code: u16,
    reason: Option<&str>,
    options: WebSocketOptions,
) -> Option<Vec<Vec<u8>>> {
    for candidate in [reason.map(clamp_reason), None] {
        let frame = Frame::Close(crate::frame::Close {
            code,
            reason: candidate,
        });
        if let Ok(messages) =
            encode_chunks(&frame, options.max_message_bytes, options.max_frame_bytes)
        {
            return Some(messages);
        }
    }
    None
}

/// The writer task: one queue per connection, drained in order.
async fn drive<S>(
    mut sink: SplitSink<WebSocketStream<S>, Message>,
    mut commands: mpsc::UnboundedReceiver<WriteCommand>,
    queued_bytes: Arc<AtomicUsize>,
    open: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    gave_up: Arc<watch::Sender<bool>>,
    options: WebSocketOptions,
) where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    while let Some(command) = commands.recv().await {
        match command {
            WriteCommand::Chunks { messages, bytes } => {
                // Released as the writer takes them, not after they are
                // written: what the counter measures is the queue behind the
                // socket, and the frame being written is no longer in it.
                queued_bytes.fetch_sub(bytes, Ordering::AcqRel);
                // Raised only while the socket itself has answered `Pending` —
                // it has the bytes and will not take more yet. That is what
                // "not draining" means to a sender deciding whether a backlog
                // is a peer that stopped reading, and it is the same thing the
                // TypeScript port's `#paused` records when its sink reports a
                // chunk as buffered rather than sent. A write that completes
                // in one poll never raises it, so a busy sender is never
                // mistaken for a stalled socket. `send_frame` reads this on
                // every call it makes for as long as one write stays stuck,
                // which is what catches a backlog that grows past the limit
                // only after the write behind it stalled.
                //
                // The instant of stalling is also judged right here, for the
                // caller that never calls `send_frame` again to ask: nothing
                // re-polls a write already suspended on the socket, so this is
                // the only chance to notice the backlog was already over the
                // limit before anything else changes.
                let mut give_up = false;
                let written = {
                    let mut write = pin!(write_chunks(&mut sink, messages));
                    poll_fn(|cx| {
                        let polled = write.as_mut().poll(cx);
                        let pending = polled.is_pending();
                        paused.store(pending, Ordering::Release);
                        if pending && queued_bytes.load(Ordering::Acquire) > options.max_frame_bytes
                        {
                            give_up = true;
                            // Set the instant the rule fires, not after this
                            // write finally drains: a sender already past
                            // this point must see `Closed` without waiting
                            // for a peer that may never take another byte,
                            // and a concurrent `recv` — which this same peer
                            // may also never send anything to unblock — must
                            // not wait on it either.
                            open.store(false, Ordering::Release);
                            gave_up.send_replace(true);
                        }
                        polled
                    })
                    .await
                };
                if !written {
                    open.store(false, Ordering::Release);
                    break;
                }
                if give_up {
                    close_stalled_peer(&mut sink, options).await;
                    break;
                }
            }
            WriteCommand::Close { code, reason, done } => {
                let frame = CloseFrame {
                    code: CloseCode::from(code),
                    reason: clamp_close_reason(reason.as_deref().unwrap_or_default()).into(),
                };
                let _ = sink.send(Message::Close(Some(frame))).await;
                let _ = done.send(());
                break;
            }
        }
    }
    release_unwritten(&mut commands, &queued_bytes);
    let _ = sink.close().await;
}

/// Gives up on a peer whose queue outgrew one frame limit before its very
/// first stall was even noticed: the farewell of §10 first, unless the caller
/// turned it off, then the native `close` carrying the same code.
///
/// Called by the writer task on its own initiative. [`SocketWriter::close`]
/// reaches the same close by queuing a [`WriteCommand::Close`] instead, for
/// every other caller that decides to stop — including
/// [`SocketWriter::send_frame`]'s own check on `paused`, which is what still
/// catches a backlog that only grows past the limit after a write already
/// stalled.
async fn close_stalled_peer<S>(
    sink: &mut SplitSink<WebSocketStream<S>, Message>,
    options: WebSocketOptions,
) where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    if options.send_close_frame
        && let Some(messages) = farewell_messages(
            close_codes::PROTOCOL_ERROR,
            Some(STALLED_QUEUE_REASON),
            options,
        )
    {
        let _ = write_chunks(sink, messages).await;
    }
    let frame = CloseFrame {
        code: CloseCode::from(close_codes::PROTOCOL_ERROR),
        reason: clamp_close_reason(STALLED_QUEUE_REASON).into(),
    };
    let _ = sink.send(Message::Close(Some(frame))).await;
}

/// Takes the bytes of everything still queued back out of the counter.
///
/// Both ways out of the writer's loop leave commands behind it: a write that
/// failed, and a close that ends the port with frames still waiting. The
/// counter says what is queued and not yet written, and abandoning those bytes
/// in it makes the one number this transport's backpressure rule reads say
/// something untrue for the rest of the port's life.
///
/// Nothing observes it by then — a sender past this point finds the port
/// closed and never reaches the counter — so this keeps an invariant rather
/// than fixing a behaviour.
fn release_unwritten(commands: &mut mpsc::UnboundedReceiver<WriteCommand>, queued: &AtomicUsize) {
    commands.close();
    while let Ok(command) = commands.try_recv() {
        if let WriteCommand::Chunks { bytes, .. } = command {
            queued.fetch_sub(bytes, Ordering::AcqRel);
        }
    }
}

/// Writes one frame's chunks contiguously. False once the socket refused one,
/// which is the connection being gone rather than a frame to retry.
async fn write_chunks<S>(
    sink: &mut SplitSink<WebSocketStream<S>, Message>,
    messages: Vec<Vec<u8>>,
) -> bool
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    for message in messages {
        if sink.send(Message::Binary(message.into())).await.is_err() {
            return false;
        }
    }
    sink.flush().await.is_ok()
}

/// Cuts a close reason down to the 123 UTF-8 bytes RFC 6455 allows, on a
/// character boundary, so a long decoder message cannot make the close itself
/// fail.
fn clamp_close_reason(reason: &str) -> String {
    if reason.len() <= MAX_CLOSE_REASON_BYTES {
        return reason.to_owned();
    }
    let mut end = MAX_CLOSE_REASON_BYTES;
    while end > 0 && !reason.is_char_boundary(end) {
        end -= 1;
    }
    reason[..end].to_owned()
}

#[cfg(test)]
mod tests {
    use super::{
        CHUNK_HEADER_BYTES, WebSocketOptions, clamp_close_reason, farewell_messages, peer_closure,
    };
    use crate::close::close_codes;
    use crate::port::PortClosure;
    use crate::validate::MAX_REASON_CHARS;
    use tokio_tungstenite::tungstenite::protocol::CloseFrame;
    use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

    /// The line a farewell's chunk messages reassemble to.
    fn farewell_line(messages: &[Vec<u8>]) -> String {
        let payload: Vec<u8> = messages
            .iter()
            .flat_map(|message| message[CHUNK_HEADER_BYTES..].to_vec())
            .collect();
        String::from_utf8(payload).expect("the farewell is UTF-8")
    }

    #[test]
    fn a_farewell_reason_past_the_schema_limit_is_cut_rather_than_dropped() {
        // The reason a refusal carries is a decoder message, and a caller may
        // pass one of its own; either can run past the schema's ceiling. An
        // unclamped one makes the whole record unencodable, and the peer then
        // reads no `close` frame at all — which is what the NDJSON port's own
        // clamp exists to prevent.
        let long = "x".repeat(MAX_REASON_CHARS + 10);
        let messages = farewell_messages(
            close_codes::RELEASED,
            Some(&long),
            WebSocketOptions::default(),
        )
        .expect("a clamped reason encodes");

        let line = farewell_line(&messages);
        assert!(
            line.contains(&"x".repeat(MAX_REASON_CHARS)),
            "the reason survives, cut to what the schema allows: {line:?}"
        );
        assert!(
            !line.contains(&"x".repeat(MAX_REASON_CHARS + 1)),
            "and no further: {line:?}"
        );
    }

    #[test]
    fn a_farewell_keeps_its_code_when_the_reason_will_not_fit_the_frame_limit() {
        // A reason is clamped by characters, but JSON escapes one NUL into six
        // bytes, so a schema-valid reason can still outgrow a lowered limit.
        // The code is the part the peer needs.
        let options = WebSocketOptions::default().with_max_frame_bytes(4096);
        let long = "\0".repeat(MAX_REASON_CHARS);
        let messages = farewell_messages(close_codes::PROTOCOL_ERROR, Some(&long), options)
            .expect("the code still encodes");

        assert_eq!(
            farewell_line(&messages),
            "{\"type\":\"close\",\"code\":4400}",
            "the farewell keeps its code and loses only the reason"
        );
    }

    #[test]
    fn a_reason_code_close_frame_becomes_the_sessions_closure() {
        let frame = CloseFrame {
            code: CloseCode::from(4409_u16),
            reason: "superseded".into(),
        };
        assert_eq!(
            peer_closure(Some(&frame)),
            PortClosure::Closed {
                code: Some(4409),
                reason: Some("superseded".into()),
            }
        );
    }

    #[test]
    fn an_rfc_close_code_says_nothing_about_the_session() {
        // 1000 and 1006 are the socket ending, not a reason code from the
        // 4000-4999 table the session reads.
        for code in [1000_u16, 1006, 1011] {
            let frame = CloseFrame {
                code: CloseCode::from(code),
                reason: "".into(),
            };
            assert_eq!(
                peer_closure(Some(&frame)),
                PortClosure::Closed {
                    code: None,
                    reason: None,
                },
                "{code}"
            );
        }
        assert_eq!(
            peer_closure(None),
            PortClosure::Closed {
                code: None,
                reason: None,
            }
        );
    }

    #[test]
    fn a_long_reason_is_cut_to_what_rfc_6455_allows() {
        let long = "é".repeat(200);
        let clamped = clamp_close_reason(&long);
        assert!(clamped.len() <= 123, "{}", clamped.len());
        assert!(long.starts_with(&clamped));
        assert_eq!(clamp_close_reason("short"), "short");
    }

    #[test]
    fn the_receive_ceiling_is_what_a_peer_may_send_not_what_this_side_sends() {
        // The message ceiling is the *sender's* local setting, so a peer that
        // puts a whole frame in one message is conforming. Capping arrivals at
        // this side's own ceiling would cut off such a peer on its first bulk
        // result, and the spec lists no ceiling among a receiver's duties.
        let options = WebSocketOptions::default().with_max_message_bytes(2048);
        let config = options.socket_config();
        let whole_frame = Some(options.max_frame_bytes + CHUNK_HEADER_BYTES);
        assert_eq!(config.max_message_size, whole_frame);
        assert_eq!(config.max_frame_size, whole_frame);
    }

    /// One expected panic message and the builder call that must produce it.
    type PanicCase = (&'static str, Box<dyn FnOnce()>);

    #[test]
    fn a_ceiling_below_its_floor_panics_naming_both() {
        let cases: [PanicCase; 2] = [
            (
                "max_frame_bytes is 512; expected at least 4096",
                Box::new(|| {
                    let _ = WebSocketOptions::default().with_max_frame_bytes(512);
                }),
            ),
            (
                "max_message_bytes is 1024; expected at least 2048",
                Box::new(|| {
                    let _ = WebSocketOptions::default().with_max_message_bytes(1024);
                }),
            ),
        ];
        for (expected, body) in cases {
            assert_eq!(crate::codec::limits::panic_message(body), expected);
        }
    }
}
