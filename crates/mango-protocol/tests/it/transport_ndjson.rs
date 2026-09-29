//! Runs the conformance suite over the NDJSON port, cross-wired through a
//! pair of in-memory pipes — the shape a parent and a spawned child have, and
//! the same port `transports::stdio` puts over the process's own standard
//! streams.
//!
//! This is the first fixture in the crate that supports
//! `Fixture::connect_raw`: a byte transport is one a test can hand a
//! hand-written line to, which is what the last two conformance cases need.
#![cfg(feature = "testing")]

use mango_protocol::close::close_codes;
use mango_protocol::port::Port;
use mango_protocol::session::{Session, SessionClosure, SessionOptions};
use mango_protocol::testing::{ConformancePair, Fixture, RawConnection, run_conformance_suite};
use mango_protocol::transports::ndjson::NdjsonPort;
use tokio::io::{AsyncWriteExt, DuplexStream};
use tokio::task::JoinHandle;

/// Big enough for the suite's 512 KiB bulk results to move without either
/// side having to drain in lockstep, small enough that those results still
/// arrive as many reads rather than one.
const PIPE_CAPACITY: usize = 64 * 1024;

/// Builds one NDJSON port over one half of a connected pipe pair.
fn port(stream: DuplexStream) -> impl Port {
    let (reader, writer) = tokio::io::split(stream);
    NdjsonPort::new(reader, writer)
}

struct PipePair {
    a: Session,
    b: Session,
    driver_a: Option<JoinHandle<SessionClosure>>,
    driver_b: Option<JoinHandle<SessionClosure>>,
}

impl ConformancePair for PipePair {
    fn a(&self) -> &Session {
        &self.a
    }

    fn b(&self) -> &Session {
        &self.b
    }

    async fn sever(&mut self) {
        // Aborting b's driver drops its half of the pipe without a farewell:
        // a reaches end of file, which is exactly what a crashed peer leaves
        // behind.
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

/// Side `a` alone, its peer a pipe half this test writes by hand.
struct RawPipe {
    a: Session,
    driver: Option<JoinHandle<SessionClosure>>,
    peer: Option<DuplexStream>,
}

impl RawConnection for RawPipe {
    fn a(&self) -> &Session {
        &self.a
    }

    async fn write(&mut self, line: &str) {
        let peer = self.peer.as_mut().expect("the raw half is still open");
        peer.write_all(line.as_bytes())
            .await
            .expect("the raw half takes the line");
        peer.write_all(b"\n")
            .await
            .expect("the raw half takes the terminator");
    }

    async fn close(&mut self) {
        self.a.close_now(close_codes::RELEASED, None);
        // Dropping the far half is the peer hanging up, which is what lets
        // a's driver finish rather than block on a read nobody will answer.
        self.peer.take();
        if let Some(driver) = self.driver.take() {
            let _ = driver.await;
        }
    }
}

struct NdjsonFixture;

impl Fixture for NdjsonFixture {
    type Pair = PipePair;
    type Raw = RawPipe;

    async fn connect(&self, a: SessionOptions, b: SessionOptions) -> PipePair {
        let (to_b, to_a) = tokio::io::duplex(PIPE_CAPACITY);
        let (session_a, driver_a) = Session::spawn(port(to_b), a);
        let (session_b, driver_b) = Session::spawn(port(to_a), b);
        PipePair {
            a: session_a,
            b: session_b,
            driver_a: Some(driver_a),
            driver_b: Some(driver_b),
        }
    }

    /// Frames are split across reads on a byte stream, so two concurrent
    /// oversized results are a reassembly test this suite knows how to run.
    fn chunked(&self) -> bool {
        true
    }

    fn supports_raw(&self) -> bool {
        true
    }

    async fn connect_raw(&self, a: SessionOptions) -> RawPipe {
        let (ours, theirs) = tokio::io::duplex(PIPE_CAPACITY);
        let (session, driver) = Session::spawn(port(ours), a);
        RawPipe {
            a: session,
            driver: Some(driver),
            peer: Some(theirs),
        }
    }
}

#[tokio::test]
async fn the_ndjson_port_behaves_like_a_mango_transport() {
    run_conformance_suite(&NdjsonFixture).await;
}
