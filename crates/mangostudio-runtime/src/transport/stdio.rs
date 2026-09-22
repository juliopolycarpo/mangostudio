//! The stdio transport: exactly one session, spoken over this process's own
//! standard input and output. Mirrors `cli.ts`'s `serveStdio`.
//!
//! **stdout carries protocol frames and nothing else** — guaranteed here by
//! never writing to it directly; every write goes through
//! [`mango_protocol::transports::stdio::stdio_port`], the sole owner of the
//! handle. Every diagnostic in this module goes to stderr instead, via
//! [`eprintln!`].

use std::time::Duration;

use mango_protocol::close::close_codes;
use mango_protocol::session::SessionOptions;
use mango_protocol::transports::stdio::stdio_port;
use tokio_util::sync::CancellationToken;

use crate::consent::invocation::stdio_consent;
use crate::runtime_home::resolve_runtime_slot_for_current_exe;
use crate::supervisor::{ShutdownSignals, join_owned};
use crate::transport::{build_host, hello_capabilities, runtime_peer, start_session};

/// Shorter than [`mango_protocol::session::DEFAULT_HANDSHAKE_TIMEOUT`]: a
/// launcher that reached this process over a pipe it just opened is either
/// about to say `hello` immediately, or it started this binary without
/// meaning to speak to it at all. Named separately from the SDK default —
/// this is a `stdio`-specific policy, not a value this crate reuses.
pub const STDIO_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

/// Runs one stdio session end to end: consent, handshake, serve, and a
/// clean shutdown on `SIGINT`/`SIGTERM` — returning the process exit code
/// `cli.rs` should use.
///
/// # Errors
/// [`std::io::Error`] only from registering the platform's own signal
/// handlers (`tokio::signal::ctrl_c`/`signal::unix::signal`) before the
/// session is built — see the module docs on why that registration happens
/// first.
pub async fn run(runtime_version: &str, mango_home: &std::path::Path) -> std::io::Result<i32> {
    run_with_signals(runtime_version, mango_home, ShutdownSignals::install()?).await
}

/// Runs one stdio session with signal handlers that the synchronous CLI
/// installed before entering the async runtime.
pub(crate) async fn run_with_signals(
    runtime_version: &str,
    mango_home: &std::path::Path,
    mut signals: ShutdownSignals,
) -> std::io::Result<i32> {
    let slot = resolve_runtime_slot_for_current_exe(mango_home);
    let consent = stdio_consent(slot, mango_home);
    if let Some(refusal) = consent.refusal {
        eprintln!("mangostudio-runtime: {refusal}");
        return Ok(1);
    }

    let host = build_host(slot, mango_home, runtime_version);
    // No request is in flight yet to cancel this against — a fresh token
    // that never fires, bounded only by `GIT_PROBE_TIMEOUT` internally. See
    // `hello_capabilities`'s own doc comment.
    let capabilities =
        hello_capabilities(slot, mango_home, &host.registry, &CancellationToken::new()).await;
    let options = SessionOptions::new(runtime_peer(runtime_version))
        .with_handshake_timeout(STDIO_HANDSHAKE_TIMEOUT)
        .with_capabilities(capabilities);
    let (session, mut driver_handle) = start_session(
        stdio_port(),
        options,
        host.registry,
        host.authorization,
        slot.as_str(),
    );

    // A signal races the driver to completion: a peer that closes on its
    // own first must not wait for a signal that may never come, and a
    // signal that arrives first releases the session cooperatively (a
    // command sent through the same channel every other close path uses)
    // rather than aborting the driver task outright.
    let closure = tokio::select! {
        biased;
        () = signals.wait() => {
            session.close_now(close_codes::RELEASED, Some("the host signalled this runtime"));
            join_owned(driver_handle).await
        }
        result = &mut driver_handle => {
            result.expect("the session driver must run to completion, never be aborted or panic")
        }
    };
    Ok(exit_code(&closure))
}

/// `stdioExitCode` without `cli.ts`'s update-committed branch — this crate
/// implements no update mechanism yet (out of scope), so exit `75` is never
/// produced here.
fn exit_code(closure: &mango_protocol::session::SessionClosure) -> i32 {
    if closure.error.is_some() || closure.code != close_codes::RELEASED {
        eprintln!(
            "mangostudio-runtime: session closed with {}{}",
            closure.code,
            closure
                .reason
                .as_deref()
                .map(|reason| format!(": {reason}"))
                .unwrap_or_default()
        );
        return 1;
    }
    0
}

#[cfg(test)]
mod tests {
    use mango_protocol::close::close_codes;
    use mango_protocol::frame::PeerInfo;
    use mango_protocol::port::port_pair;
    use mango_protocol::session::{Session, SessionOptions};
    use mango_protocol::transports::ndjson::NdjsonPort;

    use super::exit_code;

    fn peer() -> PeerInfo {
        PeerInfo {
            name: "test".into(),
            version: "0.0.0".into(),
            role: "runtime".into(),
        }
    }

    /// `SessionClosure` is `#[non_exhaustive]` by design (see its own doc
    /// comment) precisely so nothing outside `mango_protocol` fabricates
    /// one — these tests drive a real session to a real closure instead of
    /// hand-constructing the struct `cargo` would refuse to build anyway.
    #[tokio::test]
    async fn a_clean_released_closure_with_no_error_exits_zero() {
        let (a, _b) = port_pair();
        let (session, _driver) = Session::spawn(a, SessionOptions::new(peer()));
        let closure = session.close(close_codes::RELEASED, Some("done")).await;
        assert_eq!(exit_code(&closure), 0);
    }

    #[tokio::test]
    async fn a_non_released_code_exits_one() {
        let (a, _b) = port_pair();
        let (session, _driver) = Session::spawn(a, SessionOptions::new(peer()));
        let closure = session
            .close(close_codes::PROTOCOL_ERROR, Some("refused"))
            .await;
        assert_eq!(exit_code(&closure), 1);
    }

    /// The other half of `exit_code`'s check: a genuine decoder refusal
    /// (malformed bytes on the wire, not a hand-built error) also exits 1,
    /// driven through the real NDJSON codec over an in-memory duplex so the
    /// resulting `SessionClosure.error` is one the transport actually
    /// produced.
    #[tokio::test]
    async fn a_genuine_decoder_refusal_exits_one() {
        let (runtime_side, mut hub_write) = tokio::io::duplex(4096);
        let (runtime_read, runtime_write) = tokio::io::split(runtime_side);
        let port = NdjsonPort::new(runtime_read, runtime_write);
        let (session, driver_handle) = Session::spawn(port, SessionOptions::new(peer()));

        use tokio::io::AsyncWriteExt as _;
        hub_write.write_all(b"not json at all\n").await.unwrap();

        let closure = driver_handle.await.unwrap();
        assert!(
            closure.error.is_some(),
            "a malformed line must be recorded as a decoder error"
        );
        assert_eq!(exit_code(&closure), 1);
        drop(session);
    }
}
