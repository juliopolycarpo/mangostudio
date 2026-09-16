//! Implements `mango_protocol::testing::Fixture` for this crate's own
//! in-process `port_pair`, in both wire modes, and runs the full
//! conformance suite against each — this crate's own transport proving the
//! kit it ships for every other one.
#![cfg(feature = "testing")]

use mango_protocol::close::close_codes;
use mango_protocol::port::{MemoryPortOptions, port_pair_with};
use mango_protocol::session::{Session, SessionClosure, SessionOptions};
use mango_protocol::testing::{ConformancePair, Fixture, NoRawConnection, run_conformance_suite};
use tokio::task::JoinHandle;

struct InProcessPair {
    a: Session,
    b: Session,
    driver_a: Option<JoinHandle<SessionClosure>>,
    driver_b: Option<JoinHandle<SessionClosure>>,
}

impl ConformancePair for InProcessPair {
    fn a(&self) -> &Session {
        &self.a
    }

    fn b(&self) -> &Session {
        &self.b
    }

    async fn sever(&mut self) {
        // Aborting b's driver task drops its `Writer`, which drops b's send
        // half of the port; a's receive half then observes end-of-stream —
        // exactly the "vanished link" case, no different from a crash.
        if let Some(driver_b) = self.driver_b.take() {
            driver_b.abort();
        }
    }

    async fn close(&mut self) {
        self.a.close_now(close_codes::RELEASED, None);
        self.b.close_now(close_codes::RELEASED, None);
        if let Some(driver_a) = self.driver_a.take() {
            let _ = driver_a.await;
        }
        if let Some(driver_b) = self.driver_b.take() {
            let _ = driver_b.await;
        }
    }
}

struct InProcessFixture {
    validate_frames: bool,
}

impl Fixture for InProcessFixture {
    type Pair = InProcessPair;
    type Raw = NoRawConnection;

    async fn connect(&self, a: SessionOptions, b: SessionOptions) -> InProcessPair {
        let (port_a, port_b) = port_pair_with(MemoryPortOptions {
            max_frame_bytes: None,
            validate_frames: self.validate_frames,
        });
        let (session_a, driver_a) = Session::spawn(port_a, a);
        let (session_b, driver_b) = Session::spawn(port_b, b);
        InProcessPair {
            a: session_a,
            b: session_b,
            driver_a: Some(driver_a),
            driver_b: Some(driver_b),
        }
    }
}

#[tokio::test]
async fn in_process_transport_validate_mode() {
    run_conformance_suite(&InProcessFixture {
        validate_frames: true,
    })
    .await;
}

#[tokio::test]
async fn in_process_transport_clone_mode() {
    run_conformance_suite(&InProcessFixture {
        validate_frames: false,
    })
    .await;
}
