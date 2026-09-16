//! A tokio session over any [`crate::port::Port`]: the request/response
//! multiplexing, cancel, event streams, liveness and close semantics of
//! `packages/protocol/src/session.ts`, without a transport of its own.
//!
//! Build one with [`Session::open`] (you drive the returned [`SessionDriver`])
//! or [`Session::spawn`] (the driver is spawned for you). Either way, the
//! handshake and everything after it only happens while that driver future is
//! being polled — a [`Session`] handle alone is inert.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use crate::codec::limits::{check_at_least, check_max_frame_bytes};
use crate::codec::ndjson::{DEFAULT_MAX_FRAME_BYTES, MIN_MAX_FRAME_BYTES};
use crate::port::Port;

mod command;
mod dispatch;
mod driver;
mod handle;
mod handler;
mod options;
mod shared;
mod teardown;

pub use driver::SessionDriver;
pub use handle::{
    EventInput, EventStream, PongStream, RemotePeer, RequestOptions, Session, SessionState,
};
pub use handler::{CallContext, Handler, HandlerFuture, HandlerGuard};
pub use options::{
    DEFAULT_HANDLER_GRACE, DEFAULT_HANDSHAKE_TIMEOUT, DEFAULT_LIVENESS_INTERVAL,
    DEFAULT_MAX_IN_FLIGHT, DEFAULT_MAX_STREAM_KEYS, DEFAULT_REQUEST_ID_PREFIX,
    HANDSHAKE_TIMEOUT_REASON, IN_FLIGHT_LIMIT_KIND, STREAM_KEY_LIMIT_KIND, SessionOptions,
};
pub use teardown::SessionClosure;

use options::{MIN_ANNOUNCED_IN_FLIGHT, MIN_OPEN_STREAM_KEYS};

use shared::{Inner, Shared};

impl Session {
    /// Opens a session over `port`, returning the handle and its not-yet-run
    /// driver. Nothing progresses — not even the handshake — until the driver
    /// is polled; [`Session::spawn`] is the default that avoids that footgun.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::frame::PeerInfo;
    /// use mango_protocol::port::port_pair;
    /// use mango_protocol::session::{Session, SessionOptions, SessionState};
    ///
    /// let (a, _b) = port_pair();
    /// let peer = PeerInfo { name: "example".into(), version: "0.1.0".into(), role: "runtime".into() };
    /// let (session, _driver) = Session::open(a, SessionOptions::new(peer));
    /// assert_eq!(session.state(), SessionState::Handshaking);
    /// ```
    ///
    /// # Panics
    ///
    /// Panics when `options.max_frame_bytes` is `Some` value below
    /// [`crate::codec::ndjson::MIN_MAX_FRAME_BYTES`], naming both — and the
    /// same for `port`'s own ceiling, an application-defined [`Port`] being
    /// as free to report a sub-floor value as a caller is to set the option
    /// directly. Likewise for `options.max_in_flight` or
    /// `options.max_stream_keys` at `0`. `SessionOptions`'s builders already
    /// refuse these on the builder path, but every field involved is `pub`,
    /// so this is the check for a caller that assigned one directly.
    #[must_use]
    pub fn open<P: Port>(
        port: P,
        options: SessionOptions,
    ) -> (Session, SessionDriver<P::Tx, P::Rx>) {
        let port_max_frame_bytes = port.max_frame_bytes();
        let (tx, rx) = port.split();
        // A session option *narrows* the port's ceiling, it never replaces
        // it: the port is what actually decodes and encodes, so announcing
        // more than it accepts would make the peer send frames this side
        // then refuses. Unset defers to the port, then to the default —
        // unchanged, and never clamped down to the default on its own.
        let session_ceiling = options.max_frame_bytes.map(check_max_frame_bytes);
        let port_ceiling = port_max_frame_bytes
            .map(|ceiling| check_at_least("port max_frame_bytes", ceiling, MIN_MAX_FRAME_BYTES));
        let local_max_frame_bytes = match (session_ceiling, port_ceiling) {
            (Some(session), Some(port)) => session.min(port),
            (Some(only), None) | (None, Some(only)) => only,
            (None, None) => DEFAULT_MAX_FRAME_BYTES,
        };
        let max_in_flight = check_at_least(
            "max_in_flight",
            options.max_in_flight,
            MIN_ANNOUNCED_IN_FLIGHT,
        );
        let max_stream_keys = check_at_least(
            "max_stream_keys",
            options.max_stream_keys,
            MIN_OPEN_STREAM_KEYS,
        );
        let (ready, _) = watch::channel(None);
        let (closure, _) = watch::channel(None);
        let (commands_tx, commands_rx) = mpsc::unbounded_channel();
        let shared = Arc::new(Shared {
            local_peer: options.peer,
            local_protocol: options.protocol,
            local_capabilities: options.capabilities,
            local_max_frame_bytes,
            max_in_flight,
            max_stream_keys,
            inner: Mutex::new(Inner {
                state: SessionState::Handshaking,
                remote: None,
            }),
            ready,
            closure,
            commands: commands_tx,
            request_id_prefix: options.request_id_prefix,
            request_sequence: std::sync::atomic::AtomicU64::new(0),
            in_flight: std::sync::atomic::AtomicUsize::new(0),
            handlers: Mutex::new(HashMap::new()),
            next_generation: std::sync::atomic::AtomicU64::new(0),
            handler_grace: options.handler_grace,
            event_sequences: Mutex::new(HashMap::new()),
            event_subscribers: Mutex::new(Vec::new()),
            pong_subscribers: Mutex::new(Vec::new()),
        });
        for (method, handler) in options.handlers {
            shared.register_handler(method, handler);
        }
        let session = Session {
            shared: Arc::clone(&shared),
        };
        let driver = SessionDriver {
            shared,
            tx,
            rx,
            commands: commands_rx,
            handshake_timeout: options.handshake_timeout,
            pending: HashMap::new(),
            tracking: dispatch::RequestTracking::default(),
            // A zero period is no cadence at all, and `interval_at` panics on
            // one. Normalised here rather than in the setter because
            // `SessionOptions` exposes the field publicly, so a caller can
            // assign it without going through `with_liveness_interval`.
            liveness_interval: options.liveness_interval.filter(|period| !period.is_zero()),
            liveness: None,
            awaiting_pong: false,
        };
        (session, driver)
    }

    /// [`Session::open`] plus `tokio::spawn(driver.run())`.
    ///
    /// # Example
    ///
    /// ```
    /// # #[tokio::main(flavor = "current_thread")]
    /// # async fn main() {
    /// use mango_protocol::frame::PeerInfo;
    /// use mango_protocol::port::port_pair;
    /// use mango_protocol::session::{Session, SessionOptions};
    ///
    /// let (a, b) = port_pair();
    /// let peer = |role: &str| PeerInfo {
    ///     name: "example".into(),
    ///     version: "0.1.0".into(),
    ///     role: role.into(),
    /// };
    /// let (session_a, _driver_a) = Session::spawn(a, SessionOptions::new(peer("a")));
    /// let (session_b, _driver_b) = Session::spawn(b, SessionOptions::new(peer("b")));
    /// let remote = session_a.ready().await.expect("handshake succeeds");
    /// assert_eq!(remote.peer.role, "b");
    /// # }
    /// ```
    #[must_use]
    pub fn spawn<P: Port>(
        port: P,
        options: SessionOptions,
    ) -> (Session, JoinHandle<SessionClosure>) {
        let (session, driver) = Self::open(port, options);
        let handle = tokio::spawn(driver.run());
        (session, handle)
    }
}

#[cfg(test)]
mod tests {
    use crate::codec::limits::panic_message;
    use crate::frame::PeerInfo;
    use crate::port::{Port, port_pair};
    use crate::session::{Session, SessionOptions};

    fn peer() -> PeerInfo {
        PeerInfo {
            name: "hub".into(),
            version: "1.0.0".into(),
            role: "hub".into(),
        }
    }

    /// A port that reports whatever ceiling the test asks for, regardless of
    /// whether that ceiling would itself pass [`crate::codec::limits::check_at_least`] —
    /// standing in for an application-defined [`Port`] this crate does not
    /// control, as opposed to [`crate::port::MemoryPort`], which already
    /// refuses a sub-floor ceiling before `Session::open` is ever reached.
    struct FixedCeilingPort<P: Port> {
        inner: P,
        max_frame_bytes: Option<usize>,
    }

    impl<P: Port> Port for FixedCeilingPort<P> {
        type Tx = P::Tx;
        type Rx = P::Rx;

        fn max_frame_bytes(&self) -> Option<usize> {
            self.max_frame_bytes
        }

        fn split(self) -> (Self::Tx, Self::Rx) {
            self.inner.split()
        }
    }

    #[test]
    fn a_ports_own_sub_floor_ceiling_panics_naming_both() {
        let message = panic_message(|| {
            let (port, _peer_port) = port_pair();
            let port = FixedCeilingPort {
                inner: port,
                max_frame_bytes: Some(1024),
            };
            let _ = Session::open(port, SessionOptions::new(peer()));
        });
        assert_eq!(
            message,
            "port max_frame_bytes is 1024; expected at least 4096"
        );
    }
}
