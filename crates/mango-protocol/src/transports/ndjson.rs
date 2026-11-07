//! The NDJSON [`Port`] every byte-oriented transport reuses.
//!
//! stdio, the local socket and the spawn launcher differ only in where their
//! bytes come from and go to, so the framing, the refusal handling and the
//! close sequence live here once. The port owns no operating-system object:
//! it takes any [`AsyncRead`] and any [`AsyncWrite`], which is what lets the
//! same code carry a pair of pipes, an accepted socket and a child's stdio,
//! and lets the tests drive it over [`tokio::io::duplex`].
//!
//! # Example
//!
//! ```
//! # #[tokio::main(flavor = "current_thread")]
//! # async fn main() {
//! use mango_protocol::Frame;
//! use mango_protocol::port::{Inbound, Port, PortRx, PortTx};
//! use mango_protocol::transports::ndjson::NdjsonPort;
//!
//! let (one, two) = tokio::io::duplex(4096);
//! let (one_read, one_write) = tokio::io::split(one);
//! let (two_read, two_write) = tokio::io::split(two);
//!
//! let (mut tx, _rx) = NdjsonPort::new(one_read, one_write).split();
//! let (_peer_tx, mut peer_rx) = NdjsonPort::new(two_read, two_write).split();
//!
//! tx.send(Frame::Ping).await;
//! assert_eq!(peer_rx.recv().await, Some(Inbound::Frame(Frame::Ping)));
//! # }
//! ```

use std::collections::VecDeque;
use std::sync::{Arc, OnceLock, Weak};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{Mutex, watch};

use crate::close::close_code_for_codec_error;
use crate::codec::ndjson::{DEFAULT_MAX_FRAME_BYTES, LineDecoder, encode_line};
use crate::error::CodecError;
use crate::frame::{Close, Frame};
use crate::port::{Inbound, Port, PortClosure, PortRx, PortTx, SendOutcome};
use crate::validate::MAX_REASON_CHARS;

use super::CLOSE_FLUSH_GRACE;

/// How much of the byte stream one read may take. The operating-system pipe
/// buffer is this transport's only flow control (stdio.md, Backpressure), so
/// the number only trades syscalls against per-port memory. The buffer lives
/// on the receive half rather than on the stack of `recv`, whose future the
/// session driver holds inside its `select!` for the life of the session.
const READ_CHUNK_BYTES: usize = 64 * 1024;

/// One NDJSON port over a pair of byte streams.
///
/// Built from anything that reads and anything that writes; [`Port::split`]
/// hands the two halves to a session.
///
/// # Example
///
/// ```
/// use mango_protocol::port::Port;
/// use mango_protocol::transports::ndjson::NdjsonPort;
///
/// let (one, two) = tokio::io::duplex(64);
/// let (read, _unused) = tokio::io::split(one);
/// let (_unused, write) = tokio::io::split(two);
/// let port = NdjsonPort::new(read, write).with_max_frame_bytes(4096);
/// assert_eq!(port.max_frame_bytes(), Some(4096));
/// ```
#[derive(Debug)]
pub struct NdjsonPort<R, W> {
    reader: R,
    writer: SharedWriter<W>,
    max_frame_bytes: usize,
    first_hello_deadline: Option<FirstHelloDeadline>,
}

impl<R, W> NdjsonPort<R, W>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    /// Builds a port that reads frames from `reader` and writes them to
    /// `writer`, at the 16 MiB frame limit of §11.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::codec::ndjson::DEFAULT_MAX_FRAME_BYTES;
    /// use mango_protocol::port::Port;
    /// use mango_protocol::transports::ndjson::NdjsonPort;
    ///
    /// let (one, two) = tokio::io::duplex(64);
    /// let (read, _unused) = tokio::io::split(one);
    /// let (_unused, write) = tokio::io::split(two);
    /// assert_eq!(
    ///     NdjsonPort::new(read, write).max_frame_bytes(),
    ///     Some(DEFAULT_MAX_FRAME_BYTES)
    /// );
    /// ```
    #[must_use]
    pub fn new(reader: R, writer: W) -> Self {
        Self {
            reader,
            writer: SharedWriter::new(writer),
            max_frame_bytes: DEFAULT_MAX_FRAME_BYTES,
            first_hello_deadline: None,
        }
    }

    /// Sets the largest line this port's decoder accepts and its encoder
    /// produces. The session announces it in `hello.limits`, so one number
    /// governs what is refused on arrival and what the peer is told to send.
    ///
    /// # Panics
    ///
    /// Panics when `max_frame_bytes` is below
    /// [`crate::codec::ndjson::MIN_MAX_FRAME_BYTES`] or above
    /// [`crate::validate::MAX_ANNOUNCED_FRAME_BYTES`], naming the violated bound.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::port::Port;
    /// use mango_protocol::transports::ndjson::NdjsonPort;
    ///
    /// let (one, two) = tokio::io::duplex(64);
    /// let (read, _unused) = tokio::io::split(one);
    /// let (_unused, write) = tokio::io::split(two);
    /// let port = NdjsonPort::new(read, write).with_max_frame_bytes(8192);
    /// assert_eq!(port.max_frame_bytes(), Some(8192));
    /// ```
    #[must_use]
    pub fn with_max_frame_bytes(mut self, max_frame_bytes: usize) -> Self {
        self.max_frame_bytes = crate::codec::limits::check_max_frame_bytes(max_frame_bytes);
        self
    }
}

impl<R, W> NdjsonPort<R, W>
where
    W: AsyncWrite + Unpin + Send + 'static,
{
    /// Sets a transport-owned first-hello deadline for accepted local connections.
    pub(crate) fn with_first_hello_timeout(mut self, timeout: std::time::Duration) -> Self {
        self.writer
            .0
            .ipc_close
            .get_or_init(|| watch::channel(None).0);
        self.first_hello_deadline = Some(FirstHelloDeadline {
            at: tokio::time::Instant::now() + timeout,
            armed: watch::channel(true).0,
        });
        self
    }

    /// A handle that can end this port from somewhere that does not own it.
    ///
    /// A listener needs one: `spec/transports/local-socket.md` has it send
    /// `close` `4000` to every session before it stops, and by then the ports
    /// themselves have moved to whoever accepted them. The handle holds a weak
    /// reference, so keeping one never keeps a connection alive.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::transports::ndjson::NdjsonPort;
    ///
    /// let (one, two) = tokio::io::duplex(64);
    /// let (read, _unused) = tokio::io::split(one);
    /// let (_unused, write) = tokio::io::split(two);
    /// let port = NdjsonPort::new(read, write);
    /// assert!(port.closer().is_open());
    /// ```
    #[must_use]
    pub fn closer(&self) -> PortCloser<W> {
        PortCloser {
            writer: Arc::downgrade(&self.writer.0),
            max_frame_bytes: self.max_frame_bytes,
        }
    }
}

/// Ends a port from outside, for an owner that handed it on.
///
/// # Example
///
/// ```
/// # #[tokio::main(flavor = "current_thread")]
/// # async fn main() {
/// use mango_protocol::close::close_codes;
/// use mango_protocol::transports::ndjson::NdjsonPort;
///
/// let (one, two) = tokio::io::duplex(1024);
/// let (read, _unused) = tokio::io::split(one);
/// let (_unused, write) = tokio::io::split(two);
/// let port = NdjsonPort::new(read, write);
/// let closer = port.closer();
///
/// closer.close(close_codes::RELEASED, Some("listener closing")).await;
/// # }
/// ```
#[derive(Debug)]
pub struct PortCloser<W> {
    writer: Weak<WriterShared<W>>,
    max_frame_bytes: usize,
}

impl<W: AsyncWrite + Unpin + Send + 'static> PortCloser<W> {
    /// False once the port it refers to has been dropped, so a caller holding
    /// a list of these can forget the ones nobody is using any more.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::transports::ndjson::NdjsonPort;
    ///
    /// let (one, two) = tokio::io::duplex(64);
    /// let (read, _unused) = tokio::io::split(one);
    /// let (_unused, write) = tokio::io::split(two);
    /// let port = NdjsonPort::new(read, write);
    /// let closer = port.closer();
    ///
    /// assert!(closer.is_open());
    /// drop(port);
    /// assert!(!closer.is_open(), "the port this refers to is gone");
    /// ```
    #[must_use]
    pub fn is_open(&self) -> bool {
        self.writer.strong_count() > 0
    }

    /// Writes the farewell of §10 on that port and ends its writable half.
    /// For an accepted IPC port it also ends the receive half.
    ///
    /// A port that is already gone is a no-op: the session it belonged to has
    /// ended, and there is nobody left to tell.
    ///
    /// # Example
    ///
    /// ```
    /// # #[tokio::main(flavor = "current_thread")]
    /// # async fn main() {
    /// use mango_protocol::close::close_codes;
    /// use mango_protocol::transports::ndjson::NdjsonPort;
    ///
    /// let (one, two) = tokio::io::duplex(1024);
    /// let (read, _unused) = tokio::io::split(one);
    /// let (_unused, write) = tokio::io::split(two);
    /// let port = NdjsonPort::new(read, write);
    /// let closer = port.closer();
    ///
    /// closer.close(close_codes::RELEASED, Some("listener closing")).await;
    ///
    /// // A listener ending twice, or ending a port whose session already
    /// // left, is a no-op rather than an error.
    /// drop(port);
    /// closer.close(close_codes::RELEASED, None).await;
    /// # }
    /// ```
    pub async fn close(&self, code: u16, reason: Option<&str>) {
        let Some(writer) = self.writer.upgrade() else {
            return;
        };
        SharedWriter(writer)
            .close_local(code, reason.map(ToOwned::to_owned), self.max_frame_bytes)
            .await;
    }
}

impl<R, W> Port for NdjsonPort<R, W>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    type Tx = NdjsonTx<W>;
    type Rx = NdjsonRx<R, W>;

    fn max_frame_bytes(&self) -> Option<usize> {
        Some(self.max_frame_bytes)
    }

    fn split(self) -> (Self::Tx, Self::Rx) {
        let tx = NdjsonTx {
            writer: self.writer.clone(),
            max_frame_bytes: self.max_frame_bytes,
            first_hello_deadline: self.first_hello_deadline.clone(),
        };
        let rx = NdjsonRx {
            reader: Some(self.reader),
            decoder: LineDecoder::new(self.max_frame_bytes),
            chunk: vec![0; READ_CHUNK_BYTES].into_boxed_slice(),
            pending: VecDeque::new(),
            closure: None,
            writer: self.writer,
            max_frame_bytes: self.max_frame_bytes,
            terminal: false,
            first_hello_deadline: self.first_hello_deadline,
        };
        (tx, rx)
    }
}

/// The send half of an [`NdjsonPort`].
#[derive(Debug)]
pub struct NdjsonTx<W> {
    writer: SharedWriter<W>,
    max_frame_bytes: usize,
    first_hello_deadline: Option<FirstHelloDeadline>,
}

impl<W> PortTx for NdjsonTx<W>
where
    W: AsyncWrite + Unpin + Send + 'static,
{
    async fn send(&mut self, frame: Frame) -> SendOutcome {
        if self
            .first_hello_deadline
            .as_ref()
            .is_some_and(|deadline| !*deadline.armed.borrow())
        {
            self.first_hello_deadline = None;
        }
        let write = self.writer.write_frame(&frame, self.max_frame_bytes);
        let Some(deadline) = &self.first_hello_deadline else {
            return write.await;
        };
        // The session sends its own hello before it polls Rx. The send must
        // honor the same deadline if the peer leaves its receive buffer full.
        tokio::select! {
            biased;
            () = deadline.expired() => {
                if self.writer.elect_close(IpcClose::Local(FirstHelloDeadline::timeout_close())) {
                    // A partially written NDJSON frame cannot be followed by a farewell.
                    self.writer.clone().finish_close(None, self.max_frame_bytes).await;
                }
                SendOutcome::Closed
            }
            outcome = write => outcome,
        }
    }

    async fn close(self, code: u16, reason: Option<String>) {
        self.writer
            .close_local(code, reason, self.max_frame_bytes)
            .await;
    }
}

/// The receive half of an [`NdjsonPort`].
#[derive(Debug)]
pub struct NdjsonRx<R, W> {
    reader: Option<R>,
    decoder: LineDecoder,
    /// Where one read lands before the decoder sees it.
    chunk: Box<[u8]>,
    /// Frames decoded but not yet handed out, in arrival order.
    pending: VecDeque<Frame>,
    /// Why the stream ended, held back until `pending` has drained so a
    /// caller that stops at the first `Closed` never misses a frame that
    /// arrived just before it.
    closure: Option<PortClosure>,
    writer: SharedWriter<W>,
    max_frame_bytes: usize,
    terminal: bool,
    first_hello_deadline: Option<FirstHelloDeadline>,
}

impl<R, W> PortRx for NdjsonRx<R, W>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    async fn recv(&mut self) -> Option<Inbound> {
        let mut ipc_close = self.writer.0.ipc_close.get().map(watch::Sender::subscribe);
        loop {
            if self.terminal {
                return None;
            }
            if self.closure.is_none()
                && let Some(IpcClose::Local(close)) = ipc_close
                    .as_mut()
                    .and_then(|release| release.borrow_and_update().clone())
            {
                self.pending.clear();
                self.record_closure(PortClosure::Closed {
                    code: Some(close.code),
                    reason: close.reason,
                });
            }
            if self
                .first_hello_deadline
                .as_ref()
                .is_some_and(|deadline| tokio::time::Instant::now() >= deadline.at)
            {
                self.expire_first_hello().await;
                continue;
            }
            if let Some(frame) = self.pending.pop_front() {
                if matches!(frame, Frame::Hello(_)) {
                    self.disarm_first_hello();
                }
                return Some(Inbound::Frame(frame));
            }
            if let Some(closure) = self.closure.take() {
                if ipc_close.is_some() {
                    // A split named pipe lives until both halves have released it.
                    drop(self.reader.take());
                }
                self.terminal = true;
                return Some(Inbound::Closed(closure));
            }

            // `AsyncReadExt::read` is cancel-safe: a call dropped because
            // another `select!` branch won the race read nothing, so no byte
            // this decoder has not already seen is lost.
            let reader = self.reader.as_mut().expect("a live port has a reader");
            let read = async {
                if let Some(deadline) = &self.first_hello_deadline {
                    tokio::time::timeout_at(deadline.at, reader.read(&mut self.chunk)).await
                } else {
                    Ok(reader.read(&mut self.chunk).await)
                }
            };
            let read = if let Some(release) = &mut ipc_close {
                tokio::select! {
                    biased;
                    _ = release.changed() => continue,
                    result = read => result,
                }
            } else {
                read.await
            };
            let Ok(read) = read else {
                self.expire_first_hello().await;
                continue;
            };
            match read {
                Ok(0) => self.on_eof().await,
                Ok(count) => self.decode_chunk(count).await,
                Err(error) => self.on_failure(&error).await,
            }
        }
    }
}

impl<R, W> NdjsonRx<R, W>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    fn disarm_first_hello(&mut self) {
        if let Some(deadline) = self.first_hello_deadline.take() {
            deadline.armed.send_replace(false);
        }
    }

    fn record_closure(&mut self, closure: PortClosure) {
        // The first closure wins even if teardown or a cancelled recv crosses the deadline.
        self.disarm_first_hello();
        self.closure = Some(closure);
    }

    async fn expire_first_hello(&mut self) {
        if !self.writer.elect_close(IpcClose::Inbound) {
            return;
        }
        self.pending.clear();
        let close = FirstHelloDeadline::timeout_close();
        // Persist before yielding so cancellation cannot lose the closure notification.
        self.record_closure(PortClosure::Closed {
            code: Some(close.code),
            reason: close.reason.clone(),
        });
        self.writer
            .clone()
            .finish_close(Some(close), self.max_frame_bytes)
            .await;
    }

    /// Decodes the first `count` bytes of the read buffer. A refused record
    /// ends the stream: the peer is told with the code the refusal maps to,
    /// because a line nobody could read cannot be resynchronised (stdio.md,
    /// Framing).
    async fn decode_chunk(&mut self, count: usize) {
        let outcome = self.decoder.push(&self.chunk[..count]);
        self.pending.extend(outcome.frames);
        if let Some(error) = outcome.error {
            self.refuse(error).await;
        }
    }

    /// End of file, which is a transport closure and never a protocol error —
    /// a record without its terminator is an incomplete frame, not a refusal
    /// (stdio.md, Streams).
    async fn on_eof(&mut self) {
        if !self.writer.elect_close(IpcClose::Inbound) {
            return;
        }
        // Recorded before the await, never after: `recv` is cancel-safe, and a
        // closure written on the far side of an await is one a caller that
        // lost a `select!` race would never be told about.
        self.record_closure(PortClosure::Closed {
            code: None,
            reason: None,
        });
        self.writer
            .clone()
            .finish_close(None, self.max_frame_bytes)
            .await;
    }

    /// The transport itself broke. The message is the only thing that tells an
    /// operator a broken pipe apart from a peer that left politely; both are a
    /// `4000` release to the session.
    async fn on_failure(&mut self, error: &std::io::Error) {
        if !self.writer.elect_close(IpcClose::Inbound) {
            return;
        }
        self.record_closure(PortClosure::Closed {
            code: None,
            reason: Some(error.to_string()),
        });
        self.writer
            .clone()
            .finish_close(None, self.max_frame_bytes)
            .await;
    }

    async fn refuse(&mut self, error: CodecError) {
        if !self.writer.elect_close(IpcClose::Inbound) {
            return;
        }
        let code = close_code_for_codec_error(&error);
        let reason = error.to_string();
        self.record_closure(PortClosure::ProtocolError { error, code });
        self.writer
            .clone()
            .finish_close(
                Some(Close {
                    code,
                    reason: Some(reason),
                }),
                self.max_frame_bytes,
            )
            .await;
    }
}

#[derive(Clone, Debug)]
struct FirstHelloDeadline {
    at: tokio::time::Instant,
    armed: watch::Sender<bool>,
}

impl FirstHelloDeadline {
    fn timeout_close() -> Close {
        Close {
            code: crate::close::close_codes::PROTOCOL_ERROR,
            reason: Some("local socket hello deadline exceeded".into()),
        }
    }

    async fn expired(&self) {
        let mut armed = self.armed.subscribe();
        let disarmed = async {
            let _ = armed.wait_for(|armed| !*armed).await;
        };
        tokio::select! {
            biased;
            () = disarmed => std::future::pending().await,
            () = tokio::time::sleep_until(self.at) => (),
        }
    }
}

/// The writable half, shared by the two port halves.
///
/// The send half writes frames through it; the receive half needs it for one
/// thing only — the `close` frame a refused record calls for, which the
/// TypeScript port writes from `#refuse` on the same object. Splitting the
/// port hands the halves to different tasks, so the sharing is a mutex rather
/// than a borrow.
#[derive(Debug)]
struct SharedWriter<W>(Arc<WriterShared<W>>);

/// What the two halves and any [`PortCloser`] share: the writable handle
/// behind a mutex, and the signal that takes it away from them.
///
/// The signal is why it is not the mutex alone. A pipe write is not bounded:
/// a peer that stopped reading holds `write_all` for as long as it likes, and
/// the mutex is fair, so every other user of this writer — the farewell of a
/// refusal, a listener's `close`, the shutdown that drops the handle — would
/// queue behind a write that never completes. Ending the port flips this
/// first, which makes the stuck write give up and release the guard.
#[derive(Debug)]
struct WriterShared<W> {
    state: Mutex<WriterState<W>>,
    ending: watch::Sender<bool>,
    /// The elected close for an accepted IPC port.
    ipc_close: OnceLock<watch::Sender<Option<IpcClose>>>,
}

#[derive(Clone, Debug)]
enum IpcClose {
    Local(Close),
    Inbound,
}

#[derive(Debug)]
struct WriterState<W> {
    /// Taken and dropped when the port ends. Dropping is what actually closes
    /// the underlying handle: `poll_shutdown` is a no-op on a child's stdin
    /// and a flush on a Windows named pipe, so a peer waiting for end of file
    /// would wait for ever on a handle that was only "shut down".
    writer: Option<W>,
    /// False once the stream ended or refused a write; every later write is
    /// reported as the transport being gone rather than retried.
    writable: bool,
}

impl<W> Clone for SharedWriter<W> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

impl<W: AsyncWrite + Unpin + Send> SharedWriter<W> {
    fn new(writer: W) -> Self {
        Self(Arc::new(WriterShared {
            state: Mutex::new(WriterState {
                writer: Some(writer),
                writable: true,
            }),
            ending: watch::Sender::new(false),
            ipc_close: OnceLock::new(),
        }))
    }

    fn elect_close(&self, candidate: IpcClose) -> bool {
        self.0.ipc_close.get().is_none_or(|elected| {
            elected.send_if_modified(|close| {
                if close.is_some() {
                    return false;
                }
                // Stop normal writes before notifying Rx. The farewell can still use the writer.
                self.0.ending.send_replace(true);
                *close = Some(candidate);
                true
            })
        })
    }

    async fn close_local(self, code: u16, reason: Option<String>, max_frame_bytes: usize)
    where
        W: 'static,
    {
        let close = Close { code, reason };
        if self.0.ipc_close.get().is_none() || self.elect_close(IpcClose::Local(close.clone())) {
            self.finish_close(Some(close), max_frame_bytes).await;
        }
    }

    async fn finish_close(self, farewell: Option<Close>, max_frame_bytes: usize)
    where
        W: 'static,
    {
        let ipc = self.0.ipc_close.get().is_some();
        let cleanup = async move {
            if let Some(Close { code, reason }) = farewell {
                self.end(code, reason, max_frame_bytes).await;
            } else {
                self.shut_down().await;
            }
        };
        if ipc {
            // Dropping the caller detaches the bounded farewell and shutdown.
            let _ = tokio::spawn(cleanup).await;
        } else {
            cleanup.await;
        }
    }

    /// Encodes and writes one record. A frame the codec refuses is
    /// [`SendOutcome::Refused`]; a stream that will not take it is
    /// [`SendOutcome::Closed`], which is what a broken pipe reaches the
    /// session as.
    async fn write_frame(&self, frame: &Frame, max_frame_bytes: usize) -> SendOutcome {
        let line = match encode_line(frame, max_frame_bytes) {
            Ok(line) => line,
            Err(error) => return SendOutcome::Refused(error),
        };
        let mut ending = self.0.ending.subscribe();
        if *ending.borrow_and_update() {
            return SendOutcome::Closed;
        }
        let mut state = self.0.state.lock().await;
        if *ending.borrow_and_update() || !state.writable {
            return SendOutcome::Closed;
        }
        let Some(writer) = state.writer.as_mut() else {
            return SendOutcome::Closed;
        };
        // A peer that stopped reading would hold this write, and the guard
        // with it, for the life of the process. Whoever ends the port evicts
        // it instead; the half-written line does not matter, because the
        // handle is about to be dropped.
        let written = tokio::select! {
            biased;
            () = ended(&mut ending) => {
                state.writable = false;
                return SendOutcome::Closed;
            }
            written = write_record(writer, &line) => written,
        };
        match written {
            Ok(()) => SendOutcome::Sent,
            Err(_) => {
                state.writable = false;
                SendOutcome::Closed
            }
        }
    }

    /// The farewell of §10 and then the end of the writable half: the one
    /// sequence a closing port runs, whether the close came from this side,
    /// from a record the decoder refused, or from a listener shutting down.
    ///
    /// The farewell is bounded by [`CLOSE_FLUSH_GRACE`]; the end of the half
    /// is not bounded at all, because it evicts whatever is in the way.
    async fn end(&self, code: u16, reason: Option<String>, max_frame_bytes: usize) {
        let _ = tokio::time::timeout(
            CLOSE_FLUSH_GRACE,
            self.write_close(code, reason, max_frame_bytes),
        )
        .await;
        self.shut_down().await;
    }

    /// Writes the farewell of §10, best effort: the pipe may already be gone,
    /// and ending the stream is what matters either way.
    async fn write_close(&self, code: u16, reason: Option<String>, max_frame_bytes: usize) {
        let frame = Frame::Close(Close {
            code,
            reason: reason.map(|reason| clamp_reason(&reason)),
        });
        // The reason is the part that may not fit: it is clamped by
        // characters, and JSON escapes one NUL into six bytes, so a schema-
        // valid reason can still outgrow a lowered frame limit. The code is
        // what the peer needs — dropping the whole record for the sake of its
        // reason would leave a refused peer reading a plain release.
        let Ok(line) = encode_line(&frame, max_frame_bytes)
            .or_else(|_| encode_line(&Frame::Close(Close { code, reason: None }), max_frame_bytes))
        else {
            // The code itself is not one a `close` frame may carry. That does
            // not change what the port does next, and the stream still has to
            // be ended.
            return;
        };
        let mut state = self.0.state.lock().await;
        if !state.writable {
            return;
        }
        let Some(writer) = state.writer.as_mut() else {
            return;
        };
        if write_record(writer, &line).await.is_err() {
            state.writable = false;
        }
    }

    /// Ends the writable half once, whatever ended the port.
    ///
    /// The handle is dropped, not merely shut down. `poll_shutdown` is a no-op
    /// on a child's stdin and a flush on a Windows named pipe, so a peer that
    /// treats end of file as the session ending — which spawn.md says a
    /// conforming child does — only ever sees it because the handle went.
    async fn shut_down(&self) {
        // Flipped before the lock is asked for, never after: a write blocked
        // on a peer that stopped reading holds the guard, and the whole point
        // of ending a port is that it does not wait for that peer.
        self.0.ending.send_replace(true);
        let mut state = self.0.state.lock().await;
        state.writable = false;
        let taken = state.writer.take();
        // The guard goes before the await, not with it. Nothing left in the
        // state is needed: the writer is out of it and no later write can be
        // reported as sent. Anyone else ending this port — a listener's
        // farewell, the other half's close — would otherwise queue behind a
        // shutdown that is itself waiting on the peer.
        drop(state);
        let Some(mut writer) = taken else {
            return;
        };
        // Bounded for the same reason the farewell is. Evicting the stuck
        // write releases the guard but not the peer: on a handle whose
        // `poll_shutdown` is a flush — `tokio::io::Stdout`, a Windows pipe
        // write half, where `FlushFileBuffers` does not return until the
        // client reads — this waits on the very pipe that would not take the
        // bytes. Dropping is what actually closes the handle anyway, so a
        // shutdown that will not land is one to stop waiting for.
        let _ = tokio::time::timeout(CLOSE_FLUSH_GRACE, writer.shutdown()).await;
        drop(writer);
    }
}

/// Resolves the first time the port is marked as ending.
///
/// A sender that is gone means the shared writer is gone, which is the same
/// answer: nothing is left to write through.
async fn ended(ending: &mut watch::Receiver<bool>) {
    let _ = ending.changed().await;
}

async fn write_record<W: AsyncWrite + Unpin>(writer: &mut W, line: &[u8]) -> std::io::Result<()> {
    writer.write_all(line).await?;
    writer.flush().await
}

/// Cuts a close reason down to the [`MAX_REASON_CHARS`] the schema allows, on
/// a character boundary, so a long decoder message cannot make the farewell
/// itself unencodable. Shared with the WebSocket port, whose farewell is the
/// same `close` frame under a different framing.
pub(crate) fn clamp_reason(reason: &str) -> String {
    if reason.chars().count() <= MAX_REASON_CHARS {
        return reason.to_owned();
    }
    reason.chars().take(MAX_REASON_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::{NdjsonPort, clamp_reason};
    use crate::close::close_codes;
    use crate::error::CodecErrorKind;
    use crate::frame::{Frame, Request};
    use crate::port::{Inbound, Port, PortClosure, PortRx, PortTx, SendOutcome};
    use crate::validate::MAX_REASON_CHARS;
    use serde_json::Value;
    use std::io;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use std::time::Duration;
    use tokio::io::{
        AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream, ReadHalf, WriteHalf,
        duplex,
    };
    use tokio::sync::watch;

    type DuplexRead = ReadHalf<DuplexStream>;
    type DuplexWrite = WriteHalf<DuplexStream>;
    type DuplexPort = NdjsonPort<DuplexRead, DuplexWrite>;
    type DuplexHalves = (
        super::NdjsonTx<DuplexWrite>,
        super::NdjsonRx<DuplexRead, DuplexWrite>,
    );

    /// A port whose peer is raw bytes a test writes and reads by hand.
    struct RawPeer {
        port: Option<DuplexPort>,
        peer: DuplexStream,
    }

    fn raw_peer() -> RawPeer {
        let (ours, theirs) = duplex(64 * 1024);
        let (read, write) = tokio::io::split(ours);
        RawPeer {
            port: Some(NdjsonPort::new(read, write)),
            peer: theirs,
        }
    }

    impl RawPeer {
        fn split(&mut self) -> DuplexHalves {
            self.port.take().expect("the port is split once").split()
        }

        async fn write(&mut self, text: &str) {
            self.peer
                .write_all(text.as_bytes())
                .await
                .expect("the peer half takes the bytes");
        }

        /// Everything the port wrote, once it stopped writing.
        async fn read_all(&mut self) -> String {
            let mut text = String::new();
            self.peer
                .read_to_string(&mut text)
                .await
                .expect("the port's bytes are UTF-8");
            text
        }
    }

    #[tokio::test]
    async fn a_frame_survives_the_round_trip_through_the_byte_codec() {
        let mut raw = raw_peer();
        let (mut tx, rx) = raw.split();

        let frame = Frame::Req(Request {
            id: "r-1".into(),
            method: "a.b".into(),
            params: Value::String("hello".into()),
        });
        assert_eq!(tx.send(frame).await, SendOutcome::Sent);
        // Both halves share the writable side, so the stream only reaches end
        // of file once neither is left to write through it.
        drop((tx, rx));

        assert_eq!(
            raw.read_all().await,
            "{\"type\":\"req\",\"id\":\"r-1\",\"method\":\"a.b\",\"params\":\"hello\"}\n"
        );
    }

    #[tokio::test]
    async fn a_frame_split_across_two_reads_still_decodes() {
        let mut raw = raw_peer();
        let (_tx, mut rx) = raw.split();

        raw.write("{\"type\":\"pi").await;
        raw.write("ng\"}\n").await;

        assert_eq!(rx.recv().await, Some(Inbound::Frame(Frame::Ping)));
    }

    #[tokio::test]
    async fn two_frames_in_one_read_arrive_in_order() {
        let mut raw = raw_peer();
        let (_tx, mut rx) = raw.split();

        raw.write("{\"type\":\"ping\"}\n{\"type\":\"pong\"}\n")
            .await;

        assert_eq!(rx.recv().await, Some(Inbound::Frame(Frame::Ping)));
        assert_eq!(rx.recv().await, Some(Inbound::Frame(Frame::Pong)));
    }

    #[tokio::test]
    async fn end_of_file_is_a_closure_without_a_code() {
        let mut raw = raw_peer();
        let (_tx, mut rx) = raw.split();
        drop(raw.peer);

        assert_eq!(
            rx.recv().await,
            Some(Inbound::Closed(PortClosure::Closed {
                code: None,
                reason: None,
            }))
        );
        assert_eq!(rx.recv().await, None);
    }

    #[tokio::test(start_paused = true)]
    async fn first_hello_deadline_stays_disarmed_after_eof() {
        let (peer, stream) = duplex(1024);
        let (reader, writer) = tokio::io::split(stream);
        let deadline = Duration::from_millis(10);
        let (_tx, mut rx) = NdjsonPort::new(reader, writer)
            .with_first_hello_timeout(deadline)
            .split();
        drop(peer);

        assert_eq!(
            rx.recv().await,
            Some(Inbound::Closed(PortClosure::Closed {
                code: None,
                reason: None,
            }))
        );
        assert_eq!(rx.recv().await, None);
        tokio::time::advance(deadline).await;
        assert_eq!(rx.recv().await, None, "EOF is the sole closure");
    }

    #[tokio::test]
    async fn a_partial_line_at_end_of_file_is_a_closure_not_a_refusal() {
        let mut raw = raw_peer();
        let (_tx, mut rx) = raw.split();

        raw.write("{\"type\":\"ping\"").await;
        drop(raw.peer);

        assert_eq!(
            rx.recv().await,
            Some(Inbound::Closed(PortClosure::Closed {
                code: None,
                reason: None,
            }))
        );
    }

    #[tokio::test]
    async fn frames_before_a_refused_line_arrive_before_the_refusal() {
        let mut raw = raw_peer();
        let (_tx, mut rx) = raw.split();

        raw.write("{\"type\":\"ping\"}\n{\"type\":\"nope\"}\n")
            .await;

        assert_eq!(rx.recv().await, Some(Inbound::Frame(Frame::Ping)));
        match rx.recv().await {
            Some(Inbound::Closed(PortClosure::ProtocolError { error, code })) => {
                assert_eq!(code, close_codes::PROTOCOL_ERROR);
                assert_eq!(error.kind, CodecErrorKind::Schema);
            }
            other => panic!("expected a protocol error, got {other:?}"),
        }
        assert_eq!(rx.recv().await, None);
    }

    #[tokio::test(start_paused = true)]
    async fn first_hello_deadline_preserves_frames_and_refusal_after_cancelled_farewell() {
        let (mut peer, reader) = duplex(1024);
        let (writer, _watch) = StalledSink::new();
        let (_tx, mut rx) = NdjsonPort::new(reader, writer)
            .with_first_hello_timeout(Duration::from_millis(10))
            .split();
        peer.write_all(b"{\"type\":\"ping\"}\n{\"type\":\"nope\"}\n")
            .await
            .unwrap();

        assert!(
            tokio::time::timeout(Duration::from_millis(20), rx.recv())
                .await
                .is_err(),
            "the farewell is cancelled after the hello deadline"
        );
        assert_eq!(rx.recv().await, Some(Inbound::Frame(Frame::Ping)));
        match rx.recv().await {
            Some(Inbound::Closed(PortClosure::ProtocolError { error, code })) => {
                assert_eq!(code, close_codes::PROTOCOL_ERROR);
                assert_eq!(error.kind, CodecErrorKind::Schema);
            }
            other => panic!("expected the original decoder refusal, got {other:?}"),
        }
        assert_eq!(rx.recv().await, None);
    }

    #[tokio::test]
    async fn a_refused_line_tells_the_peer_why_before_the_stream_ends() {
        let mut raw = raw_peer();
        let (_tx, mut rx) = raw.split();

        raw.write("{\"type\":\"nope\"}\n").await;
        rx.recv().await.expect("the refusal is reported");

        let farewell = raw.read_all().await;
        assert!(
            farewell.starts_with("{\"type\":\"close\",\"code\":4400,"),
            "expected a 4400 close frame, got {farewell:?}"
        );
    }

    #[tokio::test]
    async fn a_hello_nobody_can_read_is_refused_with_4426() {
        let mut raw = raw_peer();
        let (_tx, mut rx) = raw.split();

        raw.write("{\"type\":\"hello\",\"protocolVersion\":\"1.0.1\"}\n")
            .await;

        match rx.recv().await {
            Some(Inbound::Closed(PortClosure::ProtocolError { code, .. })) => {
                assert_eq!(code, close_codes::PROTOCOL_MISMATCH);
            }
            other => panic!("expected a 4426 protocol error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn closing_the_send_half_writes_the_farewell_then_ends_the_stream() {
        let mut raw = raw_peer();
        let (tx, _rx) = raw.split();

        tx.close(close_codes::RELEASED, Some("bye".into())).await;

        assert_eq!(
            raw.read_all().await,
            "{\"type\":\"close\",\"code\":4000,\"reason\":\"bye\"}\n"
        );
    }

    #[tokio::test]
    async fn sending_after_the_peer_is_gone_reports_the_transport_as_closed() {
        let mut raw = raw_peer();
        let (mut tx, _rx) = raw.split();
        drop(raw.peer);

        // The first write is the one that discovers the broken pipe; a duplex
        // whose far half is dropped refuses it immediately.
        let first = tx.send(Frame::Ping).await;
        let second = tx.send(Frame::Pong).await;
        assert_eq!(first, SendOutcome::Closed, "the broken pipe is reported");
        assert_eq!(second, SendOutcome::Closed, "and stays reported");
    }

    #[tokio::test]
    async fn a_frame_past_the_ceiling_is_refused_without_reaching_the_stream() {
        let (ours, theirs) = duplex(64 * 1024);
        let (read, write) = tokio::io::split(ours);
        let port = NdjsonPort::new(read, write).with_max_frame_bytes(4096);
        let (mut tx, _rx) = port.split();

        let frame = Frame::Req(Request {
            id: "r-1".into(),
            method: "a.b".into(),
            params: Value::String("x".repeat(8192)),
        });
        match tx.send(frame).await {
            SendOutcome::Refused(error) => assert_eq!(error.kind, CodecErrorKind::TooLarge),
            other => panic!("expected Refused, got {other:?}"),
        }
        drop(theirs);
    }

    #[test]
    #[should_panic(expected = "max_frame_bytes is 512; expected at least 4096")]
    fn building_a_port_below_the_floor_panics_naming_both() {
        let (one, two) = duplex(64);
        let (read, _unused) = tokio::io::split(one);
        let (_unused, write) = tokio::io::split(two);
        let _ = NdjsonPort::new(read, write).with_max_frame_bytes(512);
    }

    #[tokio::test]
    async fn a_refusal_survives_a_recv_the_caller_cancelled_mid_farewell() {
        // The session driver polls `recv` inside a `select!`, so a call can be
        // dropped at any await. Here the farewell stalls on a peer that is not
        // reading, which is the await most likely to be interrupted; the
        // refusal must still be the next thing the port hands out.
        let (mut peer_writer, port_reader) = duplex(1024);
        // Nobody reads this half, and it holds less than one close frame.
        let (port_writer, _unread) = duplex(8);
        let (_tx, mut rx) = NdjsonPort::new(port_reader, port_writer).split();

        peer_writer
            .write_all(b"{\"type\":\"nope\"}\n")
            .await
            .expect("the peer half takes the line");

        let cancelled = tokio::time::timeout(Duration::from_millis(200), rx.recv()).await;
        assert!(
            cancelled.is_err(),
            "expected the farewell to stall, so this call is dropped part-way"
        );

        let reported = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("the refusal is not lost with the cancelled call");
        match reported {
            Some(Inbound::Closed(PortClosure::ProtocolError { code, .. })) => {
                assert_eq!(code, close_codes::PROTOCOL_ERROR);
            }
            other => panic!("expected the refusal, got {other:?}"),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn first_hello_deadline_releases_session_with_blocked_local_hello() {
        use crate::frame::PeerInfo;
        use crate::session::{Session, SessionOptions};

        // Eight bytes cannot hold even the smallest valid hello.
        let (mut peer, stream) = duplex(8);
        let (reader, writer) = tokio::io::split(stream);
        let port =
            NdjsonPort::new(reader, writer).with_first_hello_timeout(Duration::from_millis(10));
        let closer = port.closer();
        let options = SessionOptions::new(PeerInfo {
            name: "blocked-hello".into(),
            version: "0".into(),
            role: "hub".into(),
        });
        let (session, mut driver) = Session::spawn(port, options);
        let settled = tokio::time::timeout(Duration::from_secs(5), &mut driver).await;
        if settled.is_err() {
            driver.abort();
            let _ = driver.await;
        }
        settled
            .expect("the first-hello deadline must release a session blocked writing hello")
            .expect("the session driver must finish without panicking");
        assert!(session.ready().await.is_err());
        assert!(
            !closer.is_open(),
            "the closed session must release its IPC slot"
        );

        let mut bytes = Vec::new();
        peer.read_to_end(&mut bytes).await.unwrap();
        assert_eq!(
            bytes, b"{\"type\":",
            "only the partial hello reached the peer"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_valid_hello_disarms_the_deadline_for_a_pending_send() {
        let (mut peer, reader) = duplex(1024);
        let (writer, mut watch) = StalledSink::new();
        let (mut tx, mut rx) = NdjsonPort::new(reader, writer)
            .with_first_hello_timeout(Duration::from_millis(10))
            .split();
        let mut send = tokio::spawn(async move { tx.send(Frame::Ping).await });
        reached(&mut watch.writing).await;
        peer.write_all(b"{\"type\":\"hello\",\"protocol\":{\"major\":1,\"minor\":0},\"peer\":{\"name\":\"raw\",\"version\":\"0\",\"role\":\"tool\"},\"capabilities\":{}}\n")
            .await
            .unwrap();
        assert!(matches!(
            rx.recv().await,
            Some(Inbound::Frame(Frame::Hello(_)))
        ));

        let sent = tokio::time::timeout(Duration::from_millis(20), &mut send).await;
        if sent.is_err() {
            send.abort();
            let _ = send.await;
        }
        assert!(
            sent.is_err(),
            "the disarmed deadline must leave the send pending"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_first_hello_timeout_survives_cancellation_during_farewell() {
        let (_peer_writer, port_reader) = duplex(1024);
        let (port_writer, mut peer_reader) = duplex(8);
        let (mut tx, mut rx) = NdjsonPort::new(port_reader, port_writer)
            .with_first_hello_timeout(Duration::from_millis(10))
            .split();
        let cancelled = tokio::time::timeout(Duration::from_millis(20), rx.recv()).await;
        assert!(
            cancelled.is_err(),
            "the farewell must be in flight when recv is cancelled"
        );
        let reported = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .unwrap();
        assert!(matches!(
            reported,
            Some(Inbound::Closed(PortClosure::Closed {
                code: Some(4400),
                ..
            }))
        ));
        assert_eq!(rx.recv().await, None);
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), tx.send(Frame::Ping)).await,
            Ok(SendOutcome::Closed),
            "timeout cleanup must disable sends even while the caller retains Tx"
        );
        let mut farewell = Vec::new();
        tokio::time::timeout(
            Duration::from_secs(5),
            peer_reader.read_to_end(&mut farewell),
        )
        .await
        .expect("cleanup must close the writer despite receive cancellation and retained Tx")
        .unwrap();
    }

    #[test]
    fn a_reason_past_the_schema_limit_is_cut_on_a_character_boundary() {
        let long = "é".repeat(MAX_REASON_CHARS + 10);
        let clamped = clamp_reason(&long);
        assert_eq!(clamped.chars().count(), MAX_REASON_CHARS);
        assert_eq!(clamp_reason("short"), "short");
    }

    /// A sink that accepts the write and then never completes it, which is
    /// what a pipe whose peer stopped reading does. `touched` reports the
    /// first poll, so a test can know the write is in flight — and holding
    /// the shared writer — before it does anything else.
    ///
    /// Its shutdown stalls too, because that is the same pipe: `poll_shutdown`
    /// is a flush on `tokio::io::Stdout` and on a Windows pipe write half, so
    /// a peer that will not read blocks it exactly as it blocks a write.
    struct StalledSink {
        touched: watch::Sender<bool>,
        shutting: watch::Sender<bool>,
    }

    /// What a [`StalledSink`] reports about itself.
    struct SinkWatch {
        writing: watch::Receiver<bool>,
        shutting: watch::Receiver<bool>,
    }

    impl StalledSink {
        fn new() -> (Self, SinkWatch) {
            let (touched, writing) = watch::channel(false);
            let (shutting, shutting_rx) = watch::channel(false);
            (
                Self { touched, shutting },
                SinkWatch {
                    writing,
                    shutting: shutting_rx,
                },
            )
        }
    }

    impl AsyncWrite for StalledSink {
        fn poll_write(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            _buf: &[u8],
        ) -> Poll<io::Result<usize>> {
            self.touched.send_replace(true);
            Poll::Pending
        }

        fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Pending
        }

        fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            self.shutting.send_replace(true);
            Poll::Pending
        }
    }

    /// A reader that never produces a byte and never ends, so a port built on
    /// it only ever closes for a reason the test arranged.
    struct SilentSource;

    impl AsyncRead for SilentSource {
        fn poll_read(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            _buf: &mut tokio::io::ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            Poll::Pending
        }
    }

    /// Waits for one of a stalled sink's signals to fire.
    async fn reached(watcher: &mut watch::Receiver<bool>) {
        while !*watcher.borrow_and_update() {
            watcher.changed().await.expect("the sink outlives the wait");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_refusal_is_reported_though_a_send_is_stuck_on_a_peer_that_stopped_reading() {
        // The shared writer is a mutex, and a pipe write is not bounded. A
        // send blocked on a peer that stopped reading used to hold that mutex
        // for the life of the process, so the farewell a refused record owes
        // the peer — and with it the `Inbound::Closed` the session driver is
        // waiting on — never came.
        let (mut peer_writer, port_reader) = duplex(1024);
        let (sink, mut watch) = StalledSink::new();
        let (mut tx, mut rx) = NdjsonPort::new(port_reader, sink).split();

        let stuck = tokio::spawn(async move { tx.send(Frame::Ping).await });
        reached(&mut watch.writing).await;

        peer_writer
            .write_all(b"{\"type\":\"nope\"}\n")
            .await
            .expect("the peer half takes the line");

        let reported = tokio::time::timeout(Duration::from_secs(60), rx.recv())
            .await
            .expect("the refusal is reported without waiting out the stuck send");
        match reported {
            Some(Inbound::Closed(PortClosure::ProtocolError { code, .. })) => {
                assert_eq!(code, close_codes::PROTOCOL_ERROR);
            }
            other => panic!(
                "expected Inbound::Closed(ProtocolError {{ code: {} }}), got {other:?}",
                close_codes::PROTOCOL_ERROR
            ),
        }
        assert_eq!(
            stuck.await.expect("the stuck send is evicted, not leaked"),
            SendOutcome::Closed,
            "a send the port ended under is the transport being gone"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn listener_release_ends_a_pending_ipc_read_while_peer_stays_open() {
        let (mut peer, stream) = duplex(1024);
        let (reader, writer) = tokio::io::split(stream);
        let port =
            NdjsonPort::new(reader, writer).with_first_hello_timeout(Duration::from_secs(15));
        let closer = port.closer();
        let (tx, mut rx) = port.split();
        peer.write_all(b"{\"type\":\"hello\",\"protocol\":{\"major\":1,\"minor\":0},\"peer\":{\"name\":\"raw\",\"version\":\"0\",\"role\":\"tool\"},\"capabilities\":{}}\n")
            .await
            .unwrap();
        assert!(matches!(
            rx.recv().await,
            Some(Inbound::Frame(Frame::Hello(_)))
        ));

        {
            let mut receive = std::pin::pin!(rx.recv());
            tokio::select! {
                biased;
                result = &mut receive => panic!("expected an idle read, got {result:?}"),
                () = tokio::task::yield_now() => (),
            }
            closer
                .close(close_codes::RELEASED, Some("listener closing"))
                .await;
            let release = tokio::time::timeout(Duration::from_secs(1), receive)
                .await
                .expect("listener release must wake the idle read while the peer stays open");
            assert_eq!(
                release,
                Some(Inbound::Closed(PortClosure::Closed {
                    code: Some(close_codes::RELEASED),
                    reason: Some("listener closing".into()),
                }))
            );
        }
        assert!(
            peer.write_all(b"{\"type\":\"ping\"}\n").await.is_err(),
            "retaining terminal Rx must leave the peer's write side closed"
        );
        assert_eq!(rx.recv().await, None);
        drop((tx, rx));
        let mut farewell = String::new();
        peer.read_to_string(&mut farewell).await.unwrap();
        assert_eq!(
            farewell,
            "{\"type\":\"close\",\"code\":4000,\"reason\":\"listener closing\"}\n"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn ipc_sender_cannot_replace_an_elected_listener_farewell() {
        let (mut peer, stream) = duplex(1024);
        let (reader, writer) = tokio::io::split(stream);
        let port =
            NdjsonPort::new(reader, writer).with_first_hello_timeout(Duration::from_secs(15));
        let closer = port.closer();
        let (tx, mut rx) = port.split();
        tokio::select! {
            biased;
            () = closer.close(close_codes::RELEASED, Some("listener close")) => {
                panic!("the spawned listener farewell must still need polling");
            }
            () = std::future::ready(()) => (),
        }

        tx.close(close_codes::PROTOCOL_ERROR, Some("sender close".into()))
            .await;
        assert_eq!(
            rx.recv().await,
            Some(Inbound::Closed(PortClosure::Closed {
                code: Some(close_codes::RELEASED),
                reason: Some("listener close".into()),
            }))
        );
        let mut farewell = String::new();
        tokio::time::timeout(Duration::from_secs(5), peer.read_to_string(&mut farewell))
            .await
            .expect("the elected farewell must close the writer")
            .unwrap();
        assert_eq!(
            farewell,
            "{\"type\":\"close\",\"code\":4000,\"reason\":\"listener close\"}\n"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn ipc_send_timeout_cannot_replace_an_elected_listener_farewell() {
        let (mut peer, stream) = duplex(1024);
        let (reader, writer) = tokio::io::split(stream);
        let deadline = Duration::from_millis(10);
        let port = NdjsonPort::new(reader, writer).with_first_hello_timeout(deadline);
        let closer = port.closer();
        let (mut tx, mut rx) = port.split();
        tokio::time::advance(deadline).await;
        tokio::select! {
            biased;
            () = closer.close(close_codes::RELEASED, Some("listener close")) => {
                panic!("the spawned listener farewell must still need polling");
            }
            () = std::future::ready(()) => (),
        }

        assert_eq!(tx.send(Frame::Ping).await, SendOutcome::Closed);
        assert_eq!(
            rx.recv().await,
            Some(Inbound::Closed(PortClosure::Closed {
                code: Some(close_codes::RELEASED),
                reason: Some("listener close".into()),
            }))
        );
        let mut farewell = String::new();
        tokio::time::timeout(Duration::from_secs(5), peer.read_to_string(&mut farewell))
            .await
            .expect("the elected farewell must close the writer")
            .unwrap();
        assert_eq!(
            farewell,
            "{\"type\":\"close\",\"code\":4000,\"reason\":\"listener close\"}\n"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn cancelled_ipc_release_disables_sends_and_keeps_the_winning_farewell() {
        let (mut peer, stream) = duplex(8);
        let (reader, writer) = tokio::io::split(stream);
        let port =
            NdjsonPort::new(reader, writer).with_first_hello_timeout(Duration::from_secs(15));
        let closer = port.closer();
        let (mut tx, mut rx) = port.split();

        let cancelled = tokio::time::timeout(
            Duration::from_millis(20),
            closer.close(close_codes::RELEASED, Some("first close")),
        )
        .await;
        assert!(
            cancelled.is_err(),
            "the tiny buffer must stall the farewell"
        );
        assert_eq!(
            tokio::time::timeout(Duration::from_millis(20), tx.send(Frame::Ping)).await,
            Ok(SendOutcome::Closed),
            "a cancelled release must leave retained Tx closed"
        );
        tokio::time::timeout(
            Duration::from_millis(20),
            closer.close(close_codes::PROTOCOL_ERROR, Some("second close")),
        )
        .await
        .expect("the second caller must leave the farewell to the first");
        assert_eq!(
            rx.recv().await,
            Some(Inbound::Closed(PortClosure::Closed {
                code: Some(close_codes::RELEASED),
                reason: Some("first close".into()),
            }))
        );
        let mut farewell = String::new();
        tokio::time::timeout(Duration::from_secs(5), peer.read_to_string(&mut farewell))
            .await
            .expect("the detached farewell must finish and close the writer")
            .unwrap();
        assert_eq!(
            farewell,
            "{\"type\":\"close\",\"code\":4000,\"reason\":\"first close\"}\n"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_listener_closing_a_port_is_not_held_by_a_stuck_send() {
        // `IpcListener::close` writes the farewell through one of these. A
        // listener that cannot leave until every accepted peer drains is a
        // listener one idle client can pin open.
        let (sink, mut watch) = StalledSink::new();
        let port = NdjsonPort::new(SilentSource, sink);
        let closer = port.closer();
        let (mut tx, _rx) = port.split();

        let stuck = tokio::spawn(async move { tx.send(Frame::Ping).await });
        reached(&mut watch.writing).await;

        tokio::time::timeout(
            Duration::from_secs(60),
            closer.close(close_codes::RELEASED, Some("listener closing")),
        )
        .await
        .expect("the listener leaves without waiting out the stuck send");
        assert_eq!(
            stuck.await.expect("the stuck send is evicted, not leaked"),
            SendOutcome::Closed
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_second_caller_ending_a_port_does_not_wait_out_the_first() {
        // `shut_down` used to hold the writer's mutex across its own
        // `shutdown` await, which on a peer that stopped reading is one more
        // wait on that same peer — `FlushFileBuffers` on a Windows named pipe
        // does not return until the client reads. A second caller ending the
        // port (a listener's farewell while the session's own close is in
        // flight) paid for that wait before it could start.
        let (sink, mut watch) = StalledSink::new();
        let port = NdjsonPort::new(SilentSource, sink);
        let (first, second) = (port.closer(), port.closer());
        let (mut tx, _rx) = port.split();

        let stuck = tokio::spawn(async move { tx.send(Frame::Ping).await });
        reached(&mut watch.writing).await;
        let ending = tokio::spawn(async move {
            first
                .close(close_codes::RELEASED, Some("the session closing"))
                .await;
        });

        // The first caller is now parked in the `shutdown` the peer will never
        // complete, which is exactly when the mutex used to be unavailable.
        reached(&mut watch.shutting).await;
        let started = tokio::time::Instant::now();
        second
            .close(close_codes::RELEASED, Some("listener closing"))
            .await;
        let waited = started.elapsed();

        assert!(
            waited < super::CLOSE_FLUSH_GRACE,
            "the second caller waited {waited:?} for a port already being ended, \
             which is the first caller's shutdown grace, not its own work"
        );
        ending.await.expect("the first caller finishes");
        assert_eq!(
            stuck.await.expect("the stuck send is evicted, not leaked"),
            SendOutcome::Closed
        );
    }

    #[tokio::test]
    async fn a_close_keeps_its_code_when_the_reason_will_not_fit_the_frame_limit() {
        // A reason is clamped by characters, but JSON escapes one NUL into six
        // bytes, so a schema-valid reason can still outgrow a lowered limit.
        // The code is the part the peer needs.
        let mut raw = raw_peer();
        let (tx, rx) = raw
            .port
            .take()
            .expect("the port is split once")
            .with_max_frame_bytes(4096)
            .split();
        drop(rx);

        tx.close(
            close_codes::PROTOCOL_ERROR,
            Some("\0".repeat(MAX_REASON_CHARS)),
        )
        .await;

        assert_eq!(
            raw.read_all().await,
            "{\"type\":\"close\",\"code\":4400}\n",
            "the farewell keeps its code and loses only the reason"
        );
    }
}

#[cfg(test)]
mod local_hello_tests {
    use super::NdjsonPort;
    use crate::port::{Inbound, Port, PortClosure, PortRx};
    use std::time::Duration;
    use tokio::io::AsyncWriteExt;

    #[tokio::test(start_paused = true)]
    async fn idle_or_nonhello_activity_cannot_renew_the_first_hello_bound() {
        let (mut peer, stream) = tokio::io::duplex(1024);
        let (reader, writer) = tokio::io::split(stream);
        let port =
            NdjsonPort::new(reader, writer).with_first_hello_timeout(Duration::from_secs(15));
        let (_tx, mut rx) = port.split();
        peer.write_all(b"{\"type\":\"ping\"}\n").await.unwrap();
        assert!(matches!(
            rx.recv().await,
            Some(Inbound::Frame(crate::Frame::Ping))
        ));
        let start = tokio::time::Instant::now();
        assert!(matches!(
            rx.recv().await,
            Some(Inbound::Closed(PortClosure::Closed {
                code: Some(4400),
                ..
            }))
        ));
        assert_eq!(start.elapsed(), Duration::from_secs(15));
        assert_eq!(rx.recv().await, None);
    }

    #[tokio::test(start_paused = true)]
    async fn a_decoded_hello_disarms_the_transport_deadline_but_is_not_authentication() {
        let (mut peer, stream) = tokio::io::duplex(1024);
        let (reader, writer) = tokio::io::split(stream);
        let port =
            NdjsonPort::new(reader, writer).with_first_hello_timeout(Duration::from_secs(15));
        let (_tx, mut rx) = port.split();
        peer.write_all(b"{\"type\":\"hello\",\"protocol\":{\"major\":1,\"minor\":0},\"peer\":{\"name\":\"raw\",\"version\":\"0\",\"role\":\"tool\"},\"capabilities\":{}}\n").await.unwrap();
        assert!(matches!(
            rx.recv().await,
            Some(Inbound::Frame(crate::Frame::Hello(_)))
        ));
        tokio::time::advance(Duration::from_secs(16)).await;
        peer.write_all(b"{\"type\":\"ping\"}\n").await.unwrap();
        assert!(matches!(
            rx.recv().await,
            Some(Inbound::Frame(crate::Frame::Ping))
        ));
    }
}
