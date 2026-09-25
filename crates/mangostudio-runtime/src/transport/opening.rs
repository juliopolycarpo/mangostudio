//! Reading a hub's `hello` before this side's session exists.
//!
//! `serve` decides whether a new connection may take the runtime from an
//! incumbent by the binding key in the hub's `hello.capabilities` (see
//! [`mangostudio_runtime_contract::strings::binding`]). That decision has to
//! come before the incumbent is superseded and before this side announces
//! itself, so the frames that arrive first are read here, kept, and handed
//! back to the session in order through [`ReplayPort`] — the session sees
//! exactly the stream it would have read itself.
//!
//! Reading the dialler's `hello` before sending the acceptor's is the order
//! the protocol already uses for a credential check (spec §5.1): the dialler
//! may send `hello` immediately, and a refused one is closed without ever
//! learning who was listening.

use std::collections::VecDeque;
use std::time::Duration;

use mango_protocol::frame::Frame;
use mango_protocol::port::{Inbound, Port, PortRx};
use mangostudio_runtime_contract::strings::binding;

/// How long to wait for the hub's `hello` before deciding without it. Every
/// MangoStudio hub sends `hello` the moment its socket opens, so this only
/// ever runs out for a peer that waits for this side's `hello` first; that
/// peer is treated as announcing no binding key, exactly like an older hub.
pub(crate) const HUB_HELLO_WAIT: Duration = Duration::from_secs(5);

/// How many non-`hello` frames (a `ping` is allowed before `hello`) are kept
/// while waiting. A peer past this is decided without a key rather than
/// buffered without bound.
const MAX_FRAMES_BEFORE_HELLO: usize = 16;

/// What arrived before the session existed, and the binding key it carried.
pub(crate) struct Opening {
    pub(crate) buffered: VecDeque<Inbound>,
    pub(crate) binding: Option<String>,
}

/// Reads from `rx` until the hub's `hello`, the port closing, [`HUB_HELLO_WAIT`]
/// passing, or [`MAX_FRAMES_BEFORE_HELLO`] other frames — whichever is first.
/// Nothing read is discarded; it is all returned for replay.
///
/// # Example
///
/// ```ignore
/// let (tx, mut rx) = port.split();
/// let opening = read_opening(&mut rx, HUB_HELLO_WAIT).await;
/// let port = ReplayPort::new(tx, rx, opening.buffered, max_frame_bytes);
/// ```
pub(crate) async fn read_opening<R: PortRx>(rx: &mut R, wait: Duration) -> Opening {
    let mut buffered = VecDeque::new();
    let mut binding = None;
    let _ = tokio::time::timeout(wait, async {
        while buffered.len() < MAX_FRAMES_BEFORE_HELLO {
            let Some(inbound) = rx.recv().await else {
                return;
            };
            let settled = match &inbound {
                Inbound::Frame(Frame::Hello(hello)) => {
                    binding = binding_key_of(&hello.capabilities);
                    true
                }
                Inbound::Frame(_) => false,
                _ => true,
            };
            buffered.push_back(inbound);
            if settled {
                return;
            }
        }
    })
    .await;
    Opening { buffered, binding }
}

/// The hub's binding key, or `None` when it sent none or one that is not a
/// non-empty string of at most [`binding::MAX_LENGTH`] characters — the same
/// bounds the hub's own `HubBindingKeySchema` declares.
pub(crate) fn binding_key_of(
    capabilities: &serde_json::Map<String, serde_json::Value>,
) -> Option<String> {
    let key = capabilities.get(binding::CAPABILITY)?.as_str()?;
    let length = key.chars().count();
    (1..=binding::MAX_LENGTH)
        .contains(&length)
        .then(|| key.to_owned())
}

/// A port whose receiver yields `buffered` before reading on.
pub(crate) struct ReplayPort<Tx, Rx> {
    tx: Tx,
    rx: ReplayRx<Rx>,
    max_frame_bytes: Option<usize>,
}

impl<Tx, Rx> ReplayPort<Tx, Rx> {
    pub(crate) fn new(
        tx: Tx,
        rx: Rx,
        buffered: VecDeque<Inbound>,
        max_frame_bytes: Option<usize>,
    ) -> Self {
        Self {
            tx,
            rx: ReplayRx {
                buffered,
                inner: rx,
            },
            max_frame_bytes,
        }
    }
}

impl<Tx, Rx> Port for ReplayPort<Tx, Rx>
where
    Tx: mango_protocol::port::PortTx,
    Rx: PortRx,
{
    type Tx = Tx;
    type Rx = ReplayRx<Rx>;

    fn max_frame_bytes(&self) -> Option<usize> {
        self.max_frame_bytes
    }

    fn split(self) -> (Self::Tx, Self::Rx) {
        (self.tx, self.rx)
    }
}

/// [`ReplayPort`]'s receiver.
pub(crate) struct ReplayRx<Rx> {
    buffered: VecDeque<Inbound>,
    inner: Rx,
}

impl<Rx: PortRx> PortRx for ReplayRx<Rx> {
    async fn recv(&mut self) -> Option<Inbound> {
        if let Some(inbound) = self.buffered.pop_front() {
            return Some(inbound);
        }
        self.inner.recv().await
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use mango_protocol::frame::{Frame, Hello, PeerInfo};
    use mango_protocol::port::{Inbound, Port, PortRx, PortTx, port_pair};
    use mango_protocol::session::{Session, SessionOptions};
    use serde_json::json;

    use super::{ReplayPort, binding_key_of, read_opening};

    fn peer(role: &str) -> PeerInfo {
        PeerInfo {
            name: "test".into(),
            version: "0.0.0".into(),
            role: role.into(),
        }
    }

    fn capabilities(value: serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
        let serde_json::Value::Object(map) = value else {
            unreachable!("a JSON object literal");
        };
        map
    }

    #[test]
    fn a_binding_key_is_read_only_when_it_is_a_bounded_non_empty_string() {
        assert_eq!(
            binding_key_of(&capabilities(json!({ "bindingKey": "record-a" }))),
            Some("record-a".to_owned())
        );
        for (value, why) in [
            (json!({}), "absent"),
            (json!({ "bindingKey": "" }), "empty"),
            (json!({ "bindingKey": 7 }), "not a string"),
            (json!({ "bindingKey": "k".repeat(129) }), "longer than 128"),
        ] {
            assert_eq!(
                binding_key_of(&capabilities(value.clone())),
                None,
                "expected no binding key for a {why} value | received one from {value}"
            );
        }
    }

    /// The frames read before the session exist reach it in order: a `ping`
    /// the hub sent ahead of its `hello` is still answered, and the handshake
    /// still completes over the replayed `hello`.
    #[tokio::test]
    async fn a_replayed_opening_still_handshakes_and_keeps_the_frame_order() {
        let (hub_port, runtime_port) = port_pair();
        let (mut hub_tx, mut hub_rx) = hub_port.split();
        hub_tx.send(Frame::Ping).await;
        let hub_options = SessionOptions::new(peer("hub"))
            .with_capabilities(capabilities(json!({ "bindingKey": "record-a" })));
        let hub_hello = Frame::Hello(Hello {
            protocol: hub_options.protocol,
            peer: peer("hub"),
            capabilities: hub_options.capabilities.clone(),
            limits: None,
        });
        hub_tx.send(hub_hello).await;

        let max_frame_bytes = runtime_port.max_frame_bytes();
        let (runtime_tx, mut runtime_rx) = runtime_port.split();
        let opening = read_opening(&mut runtime_rx, Duration::from_secs(5)).await;
        assert_eq!(opening.binding.as_deref(), Some("record-a"));
        assert_eq!(
            opening.buffered.len(),
            2,
            "expected the ping and the hello to be kept"
        );

        let replay = ReplayPort::new(runtime_tx, runtime_rx, opening.buffered, max_frame_bytes);
        let (runtime, _driver) = Session::spawn(replay, SessionOptions::new(peer("runtime")));
        let remote = runtime
            .ready()
            .await
            .expect("the replayed hello completes the handshake");
        assert_eq!(remote.peer.role, "hub");

        let mut seen = Vec::new();
        while seen.len() < 2 {
            match hub_rx.recv().await {
                Some(Inbound::Frame(Frame::Hello(_))) => seen.push("hello"),
                Some(Inbound::Frame(Frame::Pong)) => seen.push("pong"),
                Some(_) => {}
                None => break,
            }
        }
        seen.sort_unstable();
        assert_eq!(
            seen,
            ["hello", "pong"],
            "expected the runtime to answer both"
        );
        hub_tx.close(4000, None).await;
    }

    #[tokio::test]
    async fn a_peer_that_never_says_hello_is_decided_without_a_key() {
        let (_hub_port, runtime_port) = port_pair();
        let (_tx, mut rx) = runtime_port.split();
        let opening = read_opening(&mut rx, Duration::from_millis(20)).await;
        assert_eq!(opening.binding, None);
        assert!(opening.buffered.is_empty());
    }
}
