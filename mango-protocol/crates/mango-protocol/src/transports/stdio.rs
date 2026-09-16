//! The stdio transport of `spec/transports/stdio.md`: frames in on standard
//! input, frames out on standard output, diagnostics on standard error.
//!
//! This is the transport a spawned child speaks, and the one every launcher
//! (SSH, WSL, containers) reduces to.

use tokio::io::{Stdin, Stdout, stdin, stdout};

use super::ndjson::NdjsonPort;

/// A port over this process's standard input and standard output.
///
/// **stdout carries frames and nothing else.** Anything else written to it
/// corrupts the session, so a peer speaking this transport routes its own
/// logging to stderr for as long as the session lasts.
///
/// End of file and a broken pipe are transport closures, never protocol
/// errors. Note that [`tokio::io::stdin`] reads on a blocking thread the
/// runtime cannot interrupt: a process that closes its session while a read is
/// outstanding exits once the peer writes or closes its end, which is what
/// end of stdin already means here.
///
/// # Example
///
/// ```no_run
/// # #[tokio::main(flavor = "current_thread")]
/// # async fn main() {
/// use mango_protocol::frame::PeerInfo;
/// use mango_protocol::session::{Session, SessionOptions};
/// use mango_protocol::transports::stdio::stdio_port;
///
/// let peer = PeerInfo { name: "my-runtime".into(), version: "1.0.0".into(), role: "runtime".into() };
/// let (session, driver) = Session::spawn(stdio_port(), SessionOptions::new(peer));
/// let remote = session.ready().await.expect("the launcher completes the handshake");
/// // stdout is the frame stream; diagnostics go to stderr.
/// eprintln!("connected to {}", remote.peer.name);
/// let _ = driver.await;
/// # }
/// ```
#[must_use]
pub fn stdio_port() -> NdjsonPort<Stdin, Stdout> {
    NdjsonPort::new(stdin(), stdout())
}

#[cfg(test)]
mod tests {
    use super::stdio_port;
    use crate::codec::ndjson::DEFAULT_MAX_FRAME_BYTES;
    use crate::port::Port;

    #[test]
    fn the_standard_streams_carry_the_default_frame_limit() {
        assert_eq!(
            stdio_port().max_frame_bytes(),
            Some(DEFAULT_MAX_FRAME_BYTES)
        );
    }

    #[test]
    fn the_limit_can_be_lowered_for_a_peer_that_announces_less() {
        assert_eq!(
            stdio_port().with_max_frame_bytes(65_536).max_frame_bytes(),
            Some(65_536)
        );
    }
}
