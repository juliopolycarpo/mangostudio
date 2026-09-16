//! Drives one raw half of an in-process port pair directly.

use mango_protocol::Frame;
use mango_protocol::port::{Inbound, MemoryPort, Port, PortRx, PortTx};

/// Stands in for a hand-scripted peer: sends and receives frames on one half
/// of a `port_pair` without a `Session` driving it, for tests that need to
/// see or produce exact frames (a duplicate hello, a bare `close`, a stream
/// of pings).
pub struct RawPeer {
    tx: <MemoryPort as Port>::Tx,
    rx: <MemoryPort as Port>::Rx,
}

impl RawPeer {
    /// Splits `port` into a raw send/receive pair.
    pub fn new(port: MemoryPort) -> Self {
        let (tx, rx) = port.split();
        Self { tx, rx }
    }

    /// Sends one frame.
    pub async fn send(&mut self, frame: Frame) {
        self.tx.send(frame).await;
    }

    /// Closes this half with a code and optional reason.
    pub async fn close(self, code: u16, reason: Option<&str>) {
        self.tx.close(code, reason.map(str::to_string)).await;
    }

    /// The next inbound item; panics if the port produced nothing more.
    pub async fn next(&mut self) -> Inbound {
        self.rx
            .recv()
            .await
            .expect("the port produced another item")
    }

    /// Waits for the next frame matching `predicate`, skipping any other
    /// frame first; panics if the port closes before one matches.
    pub async fn until(&mut self, mut predicate: impl FnMut(&Frame) -> bool) -> Frame {
        loop {
            match self.next().await {
                Inbound::Frame(frame) if predicate(&frame) => return frame,
                Inbound::Frame(_) => {}
                Inbound::Closed(closure) => {
                    panic!("port closed before a matching frame arrived: {closure:?}")
                }
                other => panic!("until() has no case for this Inbound variant: {other:?}"),
            }
        }
    }
}
