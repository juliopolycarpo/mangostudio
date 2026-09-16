//! A [`Port`] whose write side breaks while its read side stays open.

use mango_protocol::Frame;
use mango_protocol::port::{Inbound, Port, PortRx, PortTx, SendOutcome};

/// The shape a real transport takes when its write half breaks but nothing
/// has yet reported the connection closed: the handshake `hello` goes out,
/// every frame after it is refused, and the receive half simply never
/// produces another item.
///
/// No `port_pair` can produce this on its own — an in-process pair closes
/// both directions together — and it is exactly the case where a discarded
/// [`SendOutcome`] would strand a pending request for ever.
pub struct RefusingPort {
    hello: Frame,
}

impl RefusingPort {
    /// Builds a port whose receive half hands over `hello` and then goes
    /// quiet, and whose send half refuses everything after the first frame.
    pub fn new(hello: Frame) -> Self {
        Self { hello }
    }
}

/// The send half of a [`RefusingPort`]: the first frame is sent, the rest are
/// reported [`SendOutcome::Closed`].
pub struct RefusingPortTx {
    sent: usize,
}

/// The receive half of a [`RefusingPort`]: one scripted frame, then silence.
pub struct RefusingPortRx {
    hello: Option<Frame>,
}

impl Port for RefusingPort {
    type Tx = RefusingPortTx;
    type Rx = RefusingPortRx;

    fn max_frame_bytes(&self) -> Option<usize> {
        None
    }

    fn split(self) -> (Self::Tx, Self::Rx) {
        (
            RefusingPortTx { sent: 0 },
            RefusingPortRx {
                hello: Some(self.hello),
            },
        )
    }
}

impl PortTx for RefusingPortTx {
    async fn send(&mut self, _frame: Frame) -> SendOutcome {
        self.sent += 1;
        if self.sent == 1 {
            return SendOutcome::Sent;
        }
        SendOutcome::Closed
    }

    async fn close(self, _code: u16, _reason: Option<String>) {}
}

impl PortRx for RefusingPortRx {
    async fn recv(&mut self) -> Option<Inbound> {
        match self.hello.take() {
            Some(frame) => Some(Inbound::Frame(frame)),
            // Never terminal: the read side of a half-broken link stays open,
            // so nothing but the refused send can end this session.
            None => std::future::pending().await,
        }
    }
}
