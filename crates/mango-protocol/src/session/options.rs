//! [`SessionOptions`] and its builder methods.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value};

use crate::frame::PeerInfo;
use crate::version::{PROTOCOL_VERSION, ProtocolVersion};

use super::handler::Handler;

/// 15 seconds: the default [`SessionOptions::handshake_timeout`].
pub const DEFAULT_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
/// 20 seconds: the default [`SessionOptions::liveness_interval`].
pub const DEFAULT_LIVENESS_INTERVAL: Duration = Duration::from_secs(20);
/// 5 seconds: the default [`SessionOptions::handler_grace`].
pub const DEFAULT_HANDLER_GRACE: Duration = Duration::from_secs(5);
/// 256: the default [`SessionOptions::max_in_flight`] (§11.2).
pub const DEFAULT_MAX_IN_FLIGHT: usize = 256;
/// 1024: the default [`SessionOptions::max_stream_keys`] (§11.2).
pub const DEFAULT_MAX_STREAM_KEYS: usize = 1024;
/// Fewest requests a session can be configured to answer at once: `0` would
/// build a `hello.limits.maxInFlight` the schema refuses (§11.2). The same
/// floor as [`crate::validate::MIN_ANNOUNCED_IN_FLIGHT`] and carrying its
/// name, which is the one `session.ts` uses for it too.
pub(crate) const MIN_ANNOUNCED_IN_FLIGHT: usize = crate::validate::MIN_ANNOUNCED_IN_FLIGHT as usize;
/// Fewest stream keys a session can be configured for. Local rather than
/// announced, so §11.2 does not bound it, but a session that may hold no key
/// open at all refuses its own first `emit`.
pub(crate) const MIN_OPEN_STREAM_KEYS: usize = 1;
/// `error.details.kind` on the refusal that says the responder is full (§11.2).
pub const IN_FLIGHT_LIMIT_KIND: &str = "in_flight_limit";
/// `error.details.kind` on the local refusal of one stream key too many (§11.2).
pub const STREAM_KEY_LIMIT_KIND: &str = "stream_key_limit";
/// `"r"`: the default [`SessionOptions::request_id_prefix`].
pub const DEFAULT_REQUEST_ID_PREFIX: &str = "r";
/// The close reason the specification's §5.2 puts on a handshake that ran
/// out of time, spelled exactly as the peer's log will show it.
pub const HANDSHAKE_TIMEOUT_REASON: &str = "handshake timeout";

/// How to open a [`crate::session::Session`]: who this side is, and every
/// tunable the handshake and the driver need.
///
/// # Example
///
/// ```
/// use mango_protocol::frame::PeerInfo;
/// use mango_protocol::session::SessionOptions;
///
/// let peer = PeerInfo {
///     name: "example-runtime".into(),
///     version: "0.1.0".into(),
///     role: "runtime".into(),
/// };
/// let options = SessionOptions::new(peer).with_request_id_prefix("call");
/// assert_eq!(options.request_id_prefix, "call");
/// ```
#[non_exhaustive]
#[derive(Clone)]
pub struct SessionOptions {
    /// Who this side is: name, release string, role label.
    pub peer: PeerInfo,
    /// The application's capability object; empty when unset.
    pub capabilities: Map<String, Value>,
    /// Highest wire version this side speaks.
    pub protocol: ProtocolVersion,
    /// Largest frame this side accepts. `None` defers to the port's own
    /// ceiling, then to [`crate::codec::ndjson::DEFAULT_MAX_FRAME_BYTES`].
    /// Set, the session announces the *lower* of this and the port's own
    /// ceiling: a session option narrows what the port decodes, it never
    /// widens it, so the peer is never told to send more than the port
    /// actually accepts.
    pub max_frame_bytes: Option<usize>,
    /// How many requests this side will answer at once. Past it a `req` is
    /// refused with `UNAVAILABLE` and `details.kind` of `in_flight_limit`,
    /// which the requester may retry. Announced in `hello.limits.maxInFlight`
    /// so the peer can pace itself.
    pub max_in_flight: usize,
    /// How many stream keys this side will emit on at once. A new key past it
    /// is refused locally and nothing is sent. Local, never announced:
    /// reaching it means this side leaked stream ids.
    pub max_stream_keys: usize,
    /// How long to wait for the peer's `hello`.
    pub handshake_timeout: Duration,
    /// Ping cadence after the handshake; `None` disables liveness checking
    /// (mirrors the TypeScript SDK's `livenessIntervalMs: false`).
    /// `Some(Duration::ZERO)` is no cadence either, and reads as `None`.
    pub liveness_interval: Option<Duration>,
    /// Prefix of generated request ids.
    pub request_id_prefix: String,
    /// How long `close()` waits for in-flight handlers to settle before
    /// abandoning them. The TypeScript SDK spells the same thing
    /// `handlerGraceMs`.
    pub handler_grace: Duration,
    pub(super) handlers: Vec<(String, Arc<dyn Handler>)>,
}

impl std::fmt::Debug for SessionOptions {
    /// `Arc<dyn Handler>` cannot derive `Debug` (the trait has no such bound,
    /// and adding one would burden every implementor for a diagnostics-only
    /// need), so this counts pre-registered handlers rather than naming them.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SessionOptions")
            .field("peer", &self.peer)
            .field("capabilities", &self.capabilities)
            .field("protocol", &self.protocol)
            .field("max_frame_bytes", &self.max_frame_bytes)
            .field("max_in_flight", &self.max_in_flight)
            .field("max_stream_keys", &self.max_stream_keys)
            .field("handshake_timeout", &self.handshake_timeout)
            .field("liveness_interval", &self.liveness_interval)
            .field("request_id_prefix", &self.request_id_prefix)
            .field("handler_grace", &self.handler_grace)
            .field("handlers", &self.handlers.len())
            .finish()
    }
}

impl SessionOptions {
    /// Starts from the defaults, naming only who this side is.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::frame::PeerInfo;
    /// use mango_protocol::session::SessionOptions;
    ///
    /// let peer = PeerInfo { name: "hub".into(), version: "1.0.0".into(), role: "hub".into() };
    /// let options = SessionOptions::new(peer);
    /// assert_eq!(options.request_id_prefix, "r");
    /// ```
    #[must_use]
    pub fn new(peer: PeerInfo) -> Self {
        Self {
            peer,
            capabilities: Map::new(),
            protocol: PROTOCOL_VERSION,
            max_frame_bytes: None,
            max_in_flight: DEFAULT_MAX_IN_FLIGHT,
            max_stream_keys: DEFAULT_MAX_STREAM_KEYS,
            handshake_timeout: DEFAULT_HANDSHAKE_TIMEOUT,
            liveness_interval: Some(DEFAULT_LIVENESS_INTERVAL),
            request_id_prefix: DEFAULT_REQUEST_ID_PREFIX.to_string(),
            handler_grace: DEFAULT_HANDLER_GRACE,
            handlers: Vec::new(),
        }
    }

    /// Replaces the capability object announced in `hello.capabilities`.
    #[must_use]
    pub fn with_capabilities(mut self, capabilities: Map<String, Value>) -> Self {
        self.capabilities = capabilities;
        self
    }

    /// Replaces the wire version this side announces.
    #[must_use]
    pub fn with_protocol(mut self, protocol: ProtocolVersion) -> Self {
        self.protocol = protocol;
        self
    }

    /// Sets the largest frame this side accepts.
    ///
    /// # Panics
    ///
    /// Panics when `max_frame_bytes` is below
    /// [`crate::codec::ndjson::MIN_MAX_FRAME_BYTES`], naming both.
    #[must_use]
    pub fn with_max_frame_bytes(mut self, max_frame_bytes: usize) -> Self {
        self.max_frame_bytes = Some(crate::codec::limits::check_max_frame_bytes(max_frame_bytes));
        self
    }

    /// Sets how many requests this side will answer at once (§11.2).
    ///
    /// # Panics
    ///
    /// Panics when `max_in_flight` is `0`, naming both.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::frame::PeerInfo;
    /// use mango_protocol::session::SessionOptions;
    ///
    /// let peer = PeerInfo { name: "hub".into(), version: "1.0.0".into(), role: "hub".into() };
    /// let options = SessionOptions::new(peer).with_max_in_flight(8);
    /// assert_eq!(options.max_in_flight, 8);
    /// ```
    #[must_use]
    pub fn with_max_in_flight(mut self, max_in_flight: usize) -> Self {
        self.max_in_flight = crate::codec::limits::check_at_least(
            "max_in_flight",
            max_in_flight,
            MIN_ANNOUNCED_IN_FLIGHT,
        );
        self
    }

    /// Sets how many stream keys this side will emit on at once (§11.2).
    ///
    /// # Panics
    ///
    /// Panics when `max_stream_keys` is `0`, naming both.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::frame::PeerInfo;
    /// use mango_protocol::session::SessionOptions;
    ///
    /// let peer = PeerInfo { name: "hub".into(), version: "1.0.0".into(), role: "hub".into() };
    /// let options = SessionOptions::new(peer).with_max_stream_keys(4);
    /// assert_eq!(options.max_stream_keys, 4);
    /// ```
    #[must_use]
    pub fn with_max_stream_keys(mut self, max_stream_keys: usize) -> Self {
        self.max_stream_keys = crate::codec::limits::check_at_least(
            "max_stream_keys",
            max_stream_keys,
            MIN_OPEN_STREAM_KEYS,
        );
        self
    }

    /// Sets how long to wait for the peer's `hello`.
    #[must_use]
    pub fn with_handshake_timeout(mut self, handshake_timeout: Duration) -> Self {
        self.handshake_timeout = handshake_timeout;
        self
    }

    /// Sets the ping cadence, or disables liveness checking with `None`.
    /// `Some(Duration::ZERO)` disables it too — a zero cadence is none.
    #[must_use]
    pub fn with_liveness_interval(mut self, liveness_interval: Option<Duration>) -> Self {
        self.liveness_interval = liveness_interval;
        self
    }

    /// Sets the prefix of generated request ids.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::frame::PeerInfo;
    /// use mango_protocol::session::SessionOptions;
    ///
    /// let peer = PeerInfo { name: "hub".into(), version: "1.0.0".into(), role: "hub".into() };
    /// let options = SessionOptions::new(peer).with_request_id_prefix("call");
    /// assert_eq!(options.request_id_prefix, "call");
    /// ```
    #[must_use]
    pub fn with_request_id_prefix(mut self, request_id_prefix: impl Into<String>) -> Self {
        self.request_id_prefix = request_id_prefix.into();
        self
    }

    /// Sets how long `close()` waits for in-flight handlers to settle.
    #[must_use]
    pub fn with_handler_grace(mut self, handler_grace: Duration) -> Self {
        self.handler_grace = handler_grace;
        self
    }

    /// Registers a handler before the session opens; equivalent to calling
    /// [`crate::session::Session::handle`] immediately after
    /// [`crate::session::Session::open`], except the handler is already in
    /// place for the very first frame the driver reads.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::frame::PeerInfo;
    /// use mango_protocol::session::SessionOptions;
    ///
    /// let peer = PeerInfo { name: "hub".into(), version: "1.0.0".into(), role: "hub".into() };
    /// let options =
    ///     SessionOptions::new(peer).handle("text.echo", |params, _context| async move { Ok(params) });
    /// ```
    #[must_use]
    pub fn handle(mut self, method: impl Into<String>, handler: impl Handler) -> Self {
        self.handlers.push((method.into(), Arc::new(handler)));
        self
    }
}

#[cfg(test)]
mod tests {
    use super::SessionOptions;
    use crate::codec::limits::panic_message;
    use crate::codec::ndjson::MIN_MAX_FRAME_BYTES;
    use crate::frame::PeerInfo;

    fn peer() -> PeerInfo {
        PeerInfo {
            name: "hub".into(),
            version: "1.0.0".into(),
            role: "hub".into(),
        }
    }

    /// One expected panic message and the builder call that must produce it.
    type PanicCase = (&'static str, Box<dyn FnOnce()>);

    /// Every builder here panics naming the value and the floor it broke,
    /// rather than building an option a peer's schema would refuse anyway.
    #[test]
    fn a_ceiling_below_its_floor_panics_naming_both() {
        let cases: [PanicCase; 3] = [
            (
                "max_frame_bytes is 512; expected at least 4096",
                Box::new(|| {
                    let _ = SessionOptions::new(peer()).with_max_frame_bytes(512);
                }),
            ),
            (
                "max_in_flight is 0; expected at least 1",
                Box::new(|| {
                    let _ = SessionOptions::new(peer()).with_max_in_flight(0);
                }),
            ),
            (
                "max_stream_keys is 0; expected at least 1",
                Box::new(|| {
                    let _ = SessionOptions::new(peer()).with_max_stream_keys(0);
                }),
            ),
        ];
        for (expected, body) in cases {
            assert_eq!(panic_message(body), expected);
        }
    }

    #[test]
    fn a_ceiling_at_its_floor_is_accepted() {
        let options = SessionOptions::new(peer()).with_max_frame_bytes(MIN_MAX_FRAME_BYTES);
        assert_eq!(options.max_frame_bytes, Some(MIN_MAX_FRAME_BYTES));

        let options = SessionOptions::new(peer())
            .with_max_in_flight(1)
            .with_max_stream_keys(1);
        assert_eq!(options.max_in_flight, 1);
        assert_eq!(options.max_stream_keys, 1);
    }
}
