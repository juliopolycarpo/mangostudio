//! Drives a [`Session`] with a fuzzed frame stream: must never panic, and the
//! driver must always end in a [`SessionClosure`].
//!
//! The port here is scripted, not real: its receive half replays a bounded,
//! fuzzer-chosen sequence of frames and then a vanished-link closure, and its
//! send half discards everything. That makes termination structural rather
//! than time-based — the driver's `select!` loop ends the moment the scripted
//! `recv` runs out, the same way it would for a real port whose peer hung up
//! — so a hang here is a genuine bug for libFuzzer's own `-timeout` to catch,
//! not an artifact of the harness waiting on a clock.
#![no_main]

use std::collections::VecDeque;
use std::time::Duration;

use libfuzzer_sys::fuzz_target;
use mango_protocol::error::{CodecError, CodecErrorKind};
use mango_protocol::port::{Inbound, Port, PortClosure, PortRx, PortTx, SendOutcome};
use mango_protocol::session::{Session, SessionOptions};
use mango_protocol::{Frame, PeerInfo, close_codes, validate};
use mango_protocol_fuzz::Script;

/// A [`Port`] whose inbound side is a fixed queue and whose outbound side
/// discards every frame.
struct ScriptedPort {
    inbound: VecDeque<Inbound>,
}

/// [`ScriptedPort`]'s send half: accepts and drops every frame.
struct ScriptedTx;

/// [`ScriptedPort`]'s receive half: pops the next scripted item.
struct ScriptedRx {
    inbound: VecDeque<Inbound>,
}

impl Port for ScriptedPort {
    type Tx = ScriptedTx;
    type Rx = ScriptedRx;

    fn max_frame_bytes(&self) -> Option<usize> {
        None
    }

    fn split(self) -> (Self::Tx, Self::Rx) {
        (
            ScriptedTx,
            ScriptedRx {
                inbound: self.inbound,
            },
        )
    }
}

impl PortTx for ScriptedTx {
    async fn send(&mut self, _frame: Frame) -> SendOutcome {
        SendOutcome::Sent
    }

    async fn close(self, _code: u16, _reason: Option<String>) {}
}

impl PortRx for ScriptedRx {
    async fn recv(&mut self) -> Option<Inbound> {
        self.inbound.pop_front()
    }
}

fn peer() -> PeerInfo {
    PeerInfo {
        name: "fuzz".into(),
        version: "0.0.0".into(),
        role: "tool".into(),
    }
}

/// Builds the fixed sequence [`ScriptedRx`] will replay: every scripted frame
/// up to a schema-invalid one, exactly as a real port would deliver — a real
/// `PortRx` only ever hands the driver a [`validate`]-passing [`Frame`], and
/// refuses the rest of the stream (fatal, per [`LineDecoder`]'s own contract:
/// "the stream cannot be resynchronised") the instant it meets one that does
/// not. Ends in [`PortClosure::ProtocolError`] when a script was refused, or
/// [`PortClosure::Closed`] with no code — a vanished link — otherwise.
///
/// [`LineDecoder`]: mango_protocol::codec::ndjson::LineDecoder
fn script_inbound(scripts: Vec<Script>) -> VecDeque<Inbound> {
    let mut inbound = VecDeque::new();
    // Capped so one input cannot balloon the number of frames a single
    // iteration drives; the property under test is termination, not
    // throughput.
    for script in scripts.into_iter().take(64) {
        let frame = script.into_frame();
        if let Err(error) = validate(&frame) {
            inbound.push_back(Inbound::Closed(PortClosure::ProtocolError {
                error: CodecError::new(CodecErrorKind::Schema, error.to_string()),
                code: close_codes::PROTOCOL_ERROR,
            }));
            return inbound;
        }
        inbound.push_back(Inbound::Frame(frame));
    }
    inbound.push_back(Inbound::Closed(PortClosure::Closed {
        code: None,
        reason: None,
    }));
    inbound
}

fuzz_target!(|scripts: Vec<Script>| {
    let port = ScriptedPort {
        inbound: script_inbound(scripts),
    };
    let mut options = SessionOptions::new(peer());
    // A fuzzed stream may never carry a valid `hello`; a short timeout keeps
    // that path bounded exactly like the "runs out of frames" path, rather
    // than relying on the scripted queue draining first.
    options.handshake_timeout = Duration::from_millis(1);
    options.liveness_interval = None;

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .expect("a current-thread runtime does not depend on fuzzer input");

    runtime.block_on(async {
        let (_session, driver) = Session::open(port, options);
        let _closure = driver.run().await;
    });
});
