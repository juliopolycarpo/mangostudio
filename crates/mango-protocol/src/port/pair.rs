//! An in-process [`Port`] pair: no bytes cross an actual wire.

use tokio::sync::mpsc;

use crate::codec::limits::check_max_frame_bytes;
use crate::codec::ndjson::{DEFAULT_MAX_FRAME_BYTES, decode_line, encode_frame_bytes};
use crate::frame::Frame;

use super::{Inbound, Port, PortClosure, PortRx, PortTx, SendOutcome};

/// Configures [`port_pair_with`]: the pair's frame ceiling and whether a sent
/// frame actually round-trips through the byte codec.
#[derive(Debug, Clone, Default)]
pub struct MemoryPortOptions {
    /// The ceiling [`Port::max_frame_bytes`] reports; `None` for no local
    /// ceiling of its own.
    pub max_frame_bytes: Option<usize>,
    /// When `true`, every sent frame is encoded to bytes and decoded back
    /// before the peer sees it, proving it survives the same byte codec a
    /// real transport would use. When `false` (the default), a sent frame is
    /// simply cloned across to the peer.
    pub validate_frames: bool,
}

/// One internal message travelling between the two halves of a pair.
#[derive(Debug, Clone)]
enum WireMessage {
    /// A frame the peer should receive as an [`Inbound::Frame`].
    Frame(Frame),
    /// The sender is done; the peer should receive an [`Inbound::Closed`].
    Close { code: u16, reason: Option<String> },
}

/// One half of an in-process port pair built by [`port_pair`] or [`port_pair_with`].
///
/// # Example
///
/// ```
/// use mango_protocol::port::{Port, port_pair};
///
/// let (a, b) = port_pair();
/// let (a_tx, a_rx) = a.split();
/// let (b_tx, b_rx) = b.split();
/// drop((a_tx, a_rx, b_tx, b_rx));
/// ```
#[derive(Debug)]
pub struct MemoryPort {
    max_frame_bytes: Option<usize>,
    validate_frames: bool,
    sender: mpsc::UnboundedSender<WireMessage>,
    receiver: mpsc::UnboundedReceiver<WireMessage>,
}

/// The send half of a [`MemoryPort`].
#[derive(Debug)]
pub struct MemoryPortTx {
    max_frame_bytes: Option<usize>,
    validate_frames: bool,
    sender: mpsc::UnboundedSender<WireMessage>,
}

/// The receive half of a [`MemoryPort`].
#[derive(Debug)]
pub struct MemoryPortRx {
    receiver: mpsc::UnboundedReceiver<WireMessage>,
    terminal: bool,
}

/// Builds an in-process pair in clone mode: a sent frame is cloned straight to
/// the peer, without passing through the byte codec. Equivalent to
/// `port_pair_with(MemoryPortOptions::default())`.
///
/// # Example
///
/// ```
/// # #[tokio::main(flavor = "current_thread")]
/// # async fn main() {
/// use mango_protocol::Frame;
/// use mango_protocol::port::{Inbound, Port, PortRx, PortTx, port_pair};
///
/// let (a, b) = port_pair();
/// let (mut a_tx, _a_rx) = a.split();
/// let (_b_tx, mut b_rx) = b.split();
///
/// a_tx.send(Frame::Ping).await;
/// assert_eq!(b_rx.recv().await, Some(Inbound::Frame(Frame::Ping)));
/// # }
/// ```
#[must_use]
pub fn port_pair() -> (MemoryPort, MemoryPort) {
    port_pair_with(MemoryPortOptions::default())
}

/// Builds an in-process pair configured by `options`.
///
/// # Example
///
/// ```
/// # #[tokio::main(flavor = "current_thread")]
/// # async fn main() {
/// use mango_protocol::Frame;
/// use mango_protocol::port::{Inbound, MemoryPortOptions, Port, PortRx, PortTx, port_pair_with};
///
/// let options = MemoryPortOptions {
///     max_frame_bytes: Some(4096),
///     validate_frames: true,
/// };
/// let (a, b) = port_pair_with(options);
/// assert_eq!(a.max_frame_bytes(), Some(4096));
///
/// let (mut a_tx, _a_rx) = a.split();
/// let (_b_tx, mut b_rx) = b.split();
/// a_tx.send(Frame::Pong).await;
/// assert_eq!(b_rx.recv().await, Some(Inbound::Frame(Frame::Pong)));
/// # }
/// ```
///
/// # Panics
///
/// Panics when `options.max_frame_bytes` is `Some` value below
/// [`crate::codec::ndjson::MIN_MAX_FRAME_BYTES`], naming both.
#[must_use]
pub fn port_pair_with(options: MemoryPortOptions) -> (MemoryPort, MemoryPort) {
    if let Some(max_frame_bytes) = options.max_frame_bytes {
        let _ = check_max_frame_bytes(max_frame_bytes);
    }
    let (a_to_b, b_from_a) = mpsc::unbounded_channel();
    let (b_to_a, a_from_b) = mpsc::unbounded_channel();
    let a = MemoryPort {
        max_frame_bytes: options.max_frame_bytes,
        validate_frames: options.validate_frames,
        sender: a_to_b,
        receiver: a_from_b,
    };
    let b = MemoryPort {
        max_frame_bytes: options.max_frame_bytes,
        validate_frames: options.validate_frames,
        sender: b_to_a,
        receiver: b_from_a,
    };
    (a, b)
}

impl Port for MemoryPort {
    type Tx = MemoryPortTx;
    type Rx = MemoryPortRx;

    fn max_frame_bytes(&self) -> Option<usize> {
        self.max_frame_bytes
    }

    fn split(self) -> (Self::Tx, Self::Rx) {
        let tx = MemoryPortTx {
            max_frame_bytes: self.max_frame_bytes,
            validate_frames: self.validate_frames,
            sender: self.sender,
        };
        let rx = MemoryPortRx {
            receiver: self.receiver,
            terminal: false,
        };
        (tx, rx)
    }
}

impl MemoryPortTx {
    fn forward(&self, message: WireMessage) -> SendOutcome {
        match self.sender.send(message) {
            Ok(()) => SendOutcome::Sent,
            Err(_) => SendOutcome::Closed,
        }
    }
}

impl PortTx for MemoryPortTx {
    async fn send(&mut self, frame: Frame) -> SendOutcome {
        if self.validate_frames {
            let max_frame_bytes = self.max_frame_bytes.unwrap_or(DEFAULT_MAX_FRAME_BYTES);
            match encode_frame_bytes(&frame, max_frame_bytes)
                .and_then(|bytes| decode_line(&bytes, max_frame_bytes))
            {
                Ok(roundtripped) => self.forward(WireMessage::Frame(roundtripped)),
                Err(error) => SendOutcome::Refused(error),
            }
        } else {
            self.forward(WireMessage::Frame(frame))
        }
    }

    async fn close(self, code: u16, reason: Option<String>) {
        let _ = self.sender.send(WireMessage::Close { code, reason });
    }
}

impl PortRx for MemoryPortRx {
    async fn recv(&mut self) -> Option<Inbound> {
        if self.terminal {
            return None;
        }
        let item = match self.receiver.recv().await {
            Some(WireMessage::Frame(frame)) => Inbound::Frame(frame),
            Some(WireMessage::Close { code, reason }) => {
                self.terminal = true;
                Inbound::Closed(PortClosure::Closed {
                    code: Some(code),
                    reason,
                })
            }
            None => {
                self.terminal = true;
                Inbound::Closed(PortClosure::Closed {
                    code: None,
                    reason: None,
                })
            }
        };
        Some(item)
    }
}

#[cfg(test)]
mod tests {
    use super::{MemoryPortOptions, port_pair, port_pair_with};
    use crate::codec::ndjson::MIN_MAX_FRAME_BYTES;
    use crate::error::CodecErrorKind;
    use crate::frame::{Close, Frame, Request};
    use crate::port::{Inbound, Port, PortClosure, PortRx, PortTx, SendOutcome};
    use serde_json::Value;

    #[tokio::test]
    async fn clone_mode_delivers_a_frame_unchanged() {
        let (a, b) = port_pair();
        let (mut a_tx, _a_rx) = a.split();
        let (_b_tx, mut b_rx) = b.split();

        let frame = Frame::Req(Request {
            id: "r-1".into(),
            method: "a.b".into(),
            params: Value::Null,
        });
        assert_eq!(a_tx.send(frame.clone()).await, SendOutcome::Sent);
        assert_eq!(b_rx.recv().await, Some(Inbound::Frame(frame)));
    }

    #[tokio::test]
    async fn validate_mode_round_trips_through_the_byte_codec() {
        let options = MemoryPortOptions {
            max_frame_bytes: None,
            validate_frames: true,
        };
        let (a, b) = port_pair_with(options);
        let (mut a_tx, _a_rx) = a.split();
        let (_b_tx, mut b_rx) = b.split();

        let frame = Frame::Close(Close {
            code: 4409,
            reason: Some("superseded".into()),
        });
        assert_eq!(a_tx.send(frame.clone()).await, SendOutcome::Sent);
        assert_eq!(b_rx.recv().await, Some(Inbound::Frame(frame)));
    }

    #[tokio::test]
    async fn validate_mode_refuses_a_frame_over_the_configured_ceiling() {
        // Below MIN_MAX_FRAME_BYTES is now its own refusal (see
        // `port_pair_with_refuses_a_ceiling_below_the_floor` below), so this
        // ceiling sits at the floor and the body is sized past it instead.
        let options = MemoryPortOptions {
            max_frame_bytes: Some(MIN_MAX_FRAME_BYTES),
            validate_frames: true,
        };
        let (a, _b) = port_pair_with(options);
        let (mut a_tx, _a_rx) = a.split();

        let frame = Frame::Req(Request {
            id: "r".into(),
            method: "a.b".into(),
            params: Value::String("x".repeat(5000)),
        });
        match a_tx.send(frame).await {
            SendOutcome::Refused(error) => assert_eq!(error.kind, CodecErrorKind::TooLarge),
            other => panic!("expected Refused, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn clone_mode_never_refuses_an_oversized_frame() {
        let options = MemoryPortOptions {
            max_frame_bytes: Some(MIN_MAX_FRAME_BYTES),
            validate_frames: false,
        };
        let (a, b) = port_pair_with(options);
        let (mut a_tx, _a_rx) = a.split();
        let (_b_tx, mut b_rx) = b.split();

        let frame = Frame::Req(Request {
            id: "r".into(),
            method: "a.b".into(),
            params: Value::String("x".repeat(200)),
        });
        assert_eq!(a_tx.send(frame.clone()).await, SendOutcome::Sent);
        assert_eq!(b_rx.recv().await, Some(Inbound::Frame(frame)));
    }

    #[tokio::test]
    async fn closing_a_tx_delivers_the_code_and_reason_then_is_terminal() {
        let (a, b) = port_pair();
        let (a_tx, _a_rx) = a.split();
        let (_b_tx, mut b_rx) = b.split();

        a_tx.close(4000, Some("bye".into())).await;
        assert_eq!(
            b_rx.recv().await,
            Some(Inbound::Closed(PortClosure::Closed {
                code: Some(4000),
                reason: Some("bye".into()),
            }))
        );
        assert_eq!(b_rx.recv().await, None);
    }

    #[tokio::test]
    async fn dropping_a_tx_without_closing_is_a_vanished_link() {
        let (a, b) = port_pair();
        let (a_tx, _a_rx) = a.split();
        let (_b_tx, mut b_rx) = b.split();

        drop(a_tx);
        assert_eq!(
            b_rx.recv().await,
            Some(Inbound::Closed(PortClosure::Closed {
                code: None,
                reason: None,
            }))
        );
        assert_eq!(b_rx.recv().await, None);
    }

    #[tokio::test]
    async fn sending_after_the_peer_rx_is_dropped_reports_closed() {
        let (a, b) = port_pair();
        let (mut a_tx, _a_rx) = a.split();
        let (b_tx, b_rx) = b.split();
        drop(b_rx);
        drop(b_tx);

        assert_eq!(a_tx.send(Frame::Ping).await, SendOutcome::Closed);
    }

    #[test]
    #[should_panic(expected = "max_frame_bytes is 4095; expected at least 4096")]
    fn port_pair_with_refuses_a_ceiling_below_the_floor() {
        let _ = port_pair_with(MemoryPortOptions {
            max_frame_bytes: Some(MIN_MAX_FRAME_BYTES - 1),
            validate_frames: false,
        });
    }
}
