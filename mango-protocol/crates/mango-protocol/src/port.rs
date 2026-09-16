//! The transport seam between a session and whatever carries its bytes.
//!
//! A [`Port`] is anything that can hand a session frames in and take frames
//! out: a WebSocket, a stdio pipe, or — this crate's own — an in-process pair.
//! `session::Session` only ever talks to this trait, never to a concrete
//! transport, so a peer can be driven over any of them without writing a new
//! frame loop.

use std::future::Future;

use crate::error::CodecError;
use crate::frame::Frame;

pub mod pair;

pub use pair::{MemoryPort, MemoryPortOptions, port_pair, port_pair_with};

/// A transport a session can be opened over.
///
/// # Example
///
/// ```
/// use mango_protocol::port::{Port, port_pair};
///
/// let (a, _b) = port_pair();
/// assert_eq!(a.max_frame_bytes(), None);
/// ```
pub trait Port: Send + 'static {
    /// The half that sends frames out.
    type Tx: PortTx;
    /// The half that receives frames and closure notices.
    type Rx: PortRx;

    /// The transport's own ceiling on one frame's encoded size, if it has one.
    ///
    /// `None` means the transport imposes no ceiling of its own; the session
    /// still enforces the protocol default and any locally configured one.
    #[must_use]
    fn max_frame_bytes(&self) -> Option<usize>;

    /// Splits the port into an owned send half and an owned receive half.
    fn split(self) -> (Self::Tx, Self::Rx);
}

/// The send half of a [`Port`].
pub trait PortTx: Send + 'static {
    /// Sends one frame.
    ///
    /// The frame is already known valid and within whatever size ceiling the
    /// caller negotiated: a session runs `validate` and measures the encoded
    /// size before ever reaching this method. [`SendOutcome::Refused`] is only
    /// for a transport-level encoding failure this port implementation
    /// discovers on its own.
    fn send(&mut self, frame: Frame) -> impl Future<Output = SendOutcome> + Send;

    /// Tells the peer why the connection is ending, then consumes this half so
    /// nothing can be sent through it again.
    fn close(self, code: u16, reason: Option<String>) -> impl Future<Output = ()> + Send;
}

/// The receive half of a [`Port`].
pub trait PortRx: Send + 'static {
    /// Waits for the next inbound item.
    ///
    /// `None` once the stream is terminal; [`Inbound::Closed`] is always the
    /// last item before that point, so a caller that stops at the first
    /// `Closed` never misses a frame that arrived just before it.
    ///
    /// Must be cancel-safe: a session driver polls this inside `tokio::select!`
    /// alongside its command channel and its timers, so a call dropped without
    /// completing (because another branch won the race) must not lose a frame
    /// that was already fully received.
    fn recv(&mut self) -> impl Future<Output = Option<Inbound>> + Send;
}

/// One item off a [`PortRx`].
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum Inbound {
    /// A decoded frame from the peer.
    Frame(Frame),
    /// The port will not produce anything else.
    Closed(PortClosure),
}

/// Why a [`PortRx`] became terminal.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum PortClosure {
    /// The peer said goodbye with a close frame or code, or the link simply
    /// vanished (`code: None`, `reason: None`).
    Closed {
        /// The close code the peer gave, if any.
        code: Option<u16>,
        /// The peer's reason text, if any.
        reason: Option<String>,
    },
    /// This port's own receive side could not make sense of the bytes it
    /// received.
    ProtocolError {
        /// What the port's codec refused.
        error: CodecError,
        /// The close code this refusal maps to.
        code: u16,
    },
}

/// What became of one [`PortTx::send`].
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum SendOutcome {
    /// The frame reached the transport.
    Sent,
    /// The transport is already gone; nothing was sent.
    Closed,
    /// This port's own codec refused to encode the frame.
    Refused(CodecError),
}
