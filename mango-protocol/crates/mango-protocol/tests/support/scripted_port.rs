//! A [`Port`] whose receive half yields exactly the scripted items.

use std::collections::VecDeque;

use mango_protocol::Frame;
use mango_protocol::port::{Inbound, Port, PortClosure, PortRx, PortTx, SendOutcome};

/// A port for the closures no real `port_pair` can produce on its own: the
/// receive half yields exactly the `Inbound` items scripted in, in order,
/// then a vanished-link closure once the script is exhausted; the send half
/// always reports success (nothing in these tests inspects what it sent).
pub struct ScriptedPort {
    script: VecDeque<Inbound>,
}

impl ScriptedPort {
    /// Builds a port whose receive half plays back `script`, then vanishes.
    pub fn new(script: impl IntoIterator<Item = Inbound>) -> Self {
        Self {
            script: script.into_iter().collect(),
        }
    }
}

/// The send half of a [`ScriptedPort`]: always reports success.
pub struct ScriptedPortTx;

/// The receive half of a [`ScriptedPort`]: plays back the script, then ends.
pub struct ScriptedPortRx {
    script: VecDeque<Inbound>,
    terminal: bool,
}

impl Port for ScriptedPort {
    type Tx = ScriptedPortTx;
    type Rx = ScriptedPortRx;

    fn max_frame_bytes(&self) -> Option<usize> {
        None
    }

    fn split(self) -> (Self::Tx, Self::Rx) {
        (
            ScriptedPortTx,
            ScriptedPortRx {
                script: self.script,
                terminal: false,
            },
        )
    }
}

impl PortTx for ScriptedPortTx {
    async fn send(&mut self, _frame: Frame) -> SendOutcome {
        SendOutcome::Sent
    }

    async fn close(self, _code: u16, _reason: Option<String>) {}
}

impl PortRx for ScriptedPortRx {
    async fn recv(&mut self) -> Option<Inbound> {
        if self.terminal {
            return None;
        }
        match self.script.pop_front() {
            Some(item) => {
                if matches!(item, Inbound::Closed(_)) {
                    self.terminal = true;
                }
                Some(item)
            }
            None => {
                self.terminal = true;
                Some(Inbound::Closed(PortClosure::Closed {
                    code: None,
                    reason: None,
                }))
            }
        }
    }
}
