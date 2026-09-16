//! [`Session`] — the cheap `Clone` handle a caller holds.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::error::{RemoteError, codes};
use crate::frame::{End, Event, Frame, Limits, PeerInfo, Request};
use crate::validate::{
    RPC_DISCOVER_MINOR, is_defined_reserved_method, is_reserved_method_name, is_valid_method_name,
};
use crate::version::ProtocolVersion;

use super::command::Command;
use super::handler::{Handler, HandlerGuard};
use super::shared::{Shared, lock};
use super::teardown::SessionClosure;

/// Where a [`Session`] is in its lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
    /// Waiting for the peer's `hello`.
    Handshaking,
    /// Both hellos have crossed; requests and events flow.
    Ready,
    /// The transport is gone; every handle method now fails or reports it.
    Closed,
}

/// What the far peer announced in its `hello`, plus the negotiated minor.
///
/// # Example
///
/// ```
/// use mango_protocol::frame::PeerInfo;
/// use mango_protocol::session::RemotePeer;
///
/// let remote = RemotePeer {
///     peer: PeerInfo { name: "hub".into(), version: "1.0.0".into(), role: "hub".into() },
///     protocol: mango_protocol::PROTOCOL_VERSION,
///     capabilities: Default::default(),
///     limits: None,
///     effective_minor: 0,
/// };
/// assert_eq!(remote.peer.role, "hub");
/// ```
#[derive(Debug, Clone, PartialEq)]
pub struct RemotePeer {
    /// Who the peer is.
    pub peer: PeerInfo,
    /// The wire version the peer announced.
    pub protocol: ProtocolVersion,
    /// The peer's capability object.
    pub capabilities: Map<String, Value>,
    /// The peer's own frame ceiling, if it announced one.
    pub limits: Option<Limits>,
    /// The lower of both sides' announced minors.
    pub effective_minor: u32,
}

/// Tunes one [`Session::request_with`] call.
///
/// # Example
///
/// ```
/// use mango_protocol::session::RequestOptions;
/// use std::time::Duration;
///
/// let options = RequestOptions { timeout: Some(Duration::from_secs(5)), ..Default::default() };
/// assert!(options.cancel.is_none());
/// ```
#[derive(Default)]
pub struct RequestOptions {
    /// Cancelling this sends `cancel` to the peer, but the call still waits
    /// for the peer's real answer: cancel is advisory, never a promise.
    pub cancel: Option<CancellationToken>,
    /// A local deadline: sends `cancel`, then rejects with `TIMEOUT` without
    /// waiting for the peer's answer.
    pub timeout: Option<Duration>,
}

/// One event to publish via [`Session::emit`].
///
/// # Example
///
/// ```
/// use mango_protocol::session::EventInput;
/// use serde_json::json;
///
/// let event = EventInput {
///     topic: "fs.changed".into(),
///     payload: json!({ "path": "/tmp/a" }),
///     stream_id: None,
///     end: false,
/// };
/// assert!(!event.end);
/// ```
pub struct EventInput {
    /// Same grammar as a method name; `rpc.` is reserved.
    pub topic: String,
    /// Any JSON value, including `null`.
    pub payload: Value,
    /// Correlates one multi-frame stream; sequence numbers are per stream
    /// key (`stream_id`, else `topic`).
    pub stream_id: Option<String>,
    /// Marks the last event of the stream and releases its counter.
    pub end: bool,
}

/// A live subscription to a [`Session`]'s incoming events, from
/// [`Session::events`].
pub struct EventStream {
    receiver: mpsc::UnboundedReceiver<Event>,
}

impl EventStream {
    /// The next event, or `None` once the session has closed and every
    /// already-queued event has been delivered.
    pub async fn recv(&mut self) -> Option<Event> {
        self.receiver.recv().await
    }
}

/// A live subscription to a [`Session`]'s incoming `pong`s, from
/// [`Session::pongs`].
pub struct PongStream {
    receiver: mpsc::UnboundedReceiver<()>,
}

impl PongStream {
    /// Resolves on every `pong`, or `None` once the session has closed.
    pub async fn recv(&mut self) -> Option<()> {
        self.receiver.recv().await
    }
}

/// A symmetric Mango Protocol session over any [`crate::port::Port`].
///
/// Cloning a `Session` is cheap: every clone shares the same driver through an
/// `Arc`. The driver itself only progresses while its `SessionDriver` future
/// is polled — build one with [`Session::open`] or, for the common case,
/// spawn it directly with [`Session::spawn`].
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
/// let peer = |role: &str| PeerInfo { name: "example".into(), version: "0.1.0".into(), role: role.into() };
/// let (session_a, _driver_a) = Session::spawn(a, SessionOptions::new(peer("a")));
/// let (session_b, _driver_b) = Session::spawn(b, SessionOptions::new(peer("b")));
/// let remote = session_a.ready().await.expect("handshake succeeds");
/// assert_eq!(remote.peer.role, "b");
/// # }
/// ```
#[derive(Clone)]
pub struct Session {
    pub(super) shared: Arc<Shared>,
}

impl Session {
    /// Settles once both hellos have crossed; fails once the handshake cannot
    /// complete (a timeout, a duplicate hello, a version mismatch, or the
    /// port going away first).
    pub async fn ready(&self) -> Result<RemotePeer, RemoteError> {
        let mut receiver = self.shared.ready.subscribe();
        loop {
            let current = receiver.borrow().clone();
            if let Some(outcome) = current {
                return outcome;
            }
            if receiver.changed().await.is_err() {
                // As with `closed()`: the sender lives in `Shared`, reachable
                // through this very `self`, so it cannot have dropped already.
                std::future::pending::<()>().await;
            }
        }
    }

    /// Where the session is in its lifecycle.
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
    #[must_use]
    pub fn state(&self) -> SessionState {
        lock(&self.shared.inner).state
    }

    /// The peer's announcement. Fails with `UNAVAILABLE` before the handshake
    /// completes.
    pub fn remote(&self) -> Result<RemotePeer, RemoteError> {
        lock(&self.shared.inner)
            .remote
            .as_deref()
            .cloned()
            .ok_or_else(|| {
                RemoteError::new(
                    codes::UNAVAILABLE,
                    "The session handshake has not completed; expected a ready session, received \
                 one still handshaking.",
                )
            })
    }

    /// Why the session closed, once it has. `None` until teardown finishes.
    #[must_use]
    pub fn closure(&self) -> Option<SessionClosure> {
        self.shared.closure.borrow().clone()
    }

    /// Resolves once the session ends; resolves immediately if it already has.
    pub async fn closed(&self) -> SessionClosure {
        let mut receiver = self.shared.closure.subscribe();
        loop {
            let current = receiver.borrow().clone();
            if let Some(closure) = current {
                return closure;
            }
            if receiver.changed().await.is_err() {
                // Only reachable if every Session clone (and so every Arc that
                // could still hold the sender) were already gone, which can't
                // happen while this very call is running through one. Park
                // rather than fabricate a closure that never occurred.
                std::future::pending::<()>().await;
            }
        }
    }

    /// The frame ceiling this side may send: the lower of both announced
    /// limits.
    #[must_use]
    pub fn send_limit_bytes(&self) -> usize {
        self.shared.send_limit_bytes()
    }

    /// How many requests the peer said it will answer at once, so a requester
    /// can pace itself rather than discover the ceiling by being refused
    /// (§11.2). The default until the peer announces otherwise.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::frame::PeerInfo;
    /// use mango_protocol::port::port_pair;
    /// use mango_protocol::session::{DEFAULT_MAX_IN_FLIGHT, Session, SessionOptions};
    ///
    /// let (a, _b) = port_pair();
    /// let peer = PeerInfo { name: "hub".into(), version: "1".into(), role: "hub".into() };
    /// let (session, _driver) = Session::open(a, SessionOptions::new(peer));
    /// assert_eq!(session.remote_max_in_flight(), DEFAULT_MAX_IN_FLIGHT);
    /// ```
    #[must_use]
    pub fn remote_max_in_flight(&self) -> usize {
        self.shared.remote_max_in_flight()
    }

    /// Closes the transport with a reason code and settles everything in
    /// flight, resolving once every handler has settled (bounded by
    /// `handler_grace`) and the port is shut.
    ///
    /// Called from inside a handler, this waits out the grace rather than the
    /// handler's own return — use [`Session::close_now`] there instead.
    pub async fn close(&self, code: u16, reason: Option<&str>) -> SessionClosure {
        self.close_now(code, reason);
        self.closed().await
    }

    /// Closes the transport without waiting for the teardown to finish.
    pub fn close_now(&self, code: u16, reason: Option<&str>) {
        let _ = self.shared.commands.send(Command::Close {
            code,
            reason: reason.map(str::to_string),
        });
    }

    /// Registers a handler for `method`; dropping the returned guard
    /// unregisters it unless [`HandlerGuard::persist`] is called first.
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
    /// let (a, _b) = port_pair();
    /// let peer = PeerInfo { name: "e".into(), version: "0.1.0".into(), role: "runtime".into() };
    /// let (session, _driver) = Session::open(a, SessionOptions::new(peer));
    /// let guard = session.handle("text.echo", |params, _context| async move { Ok(params) });
    /// guard.persist();
    /// # }
    /// ```
    #[must_use = "dropping the guard unregisters the handler"]
    pub fn handle(&self, method: impl Into<String>, handler: impl Handler) -> HandlerGuard {
        let (method, generation) = self
            .shared
            .register_handler(method.into(), Arc::new(handler));
        HandlerGuard {
            method,
            generation,
            shared: Arc::clone(&self.shared),
            armed: true,
        }
    }

    /// Sends a request and resolves with its `result`, or rejects with a
    /// [`RemoteError`]. Equivalent to `request_with` with the defaults.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, RemoteError> {
        self.request_with(method, params, RequestOptions::default())
            .await
    }

    /// Sends a request, tuned by `options`.
    pub async fn request_with(
        &self,
        method: &str,
        params: Value,
        options: RequestOptions,
    ) -> Result<Value, RemoteError> {
        // A reserved name this wire defines is legal to send; whether this
        // *session* defines it depends on the effective minor, which is not
        // known until the handshake completes, so that half waits for it.
        let reserved = is_reserved_method_name(method);
        if !is_valid_method_name(method)
            || (reserved && !is_defined_reserved_method(method, u32::from(crate::PROTOCOL_MINOR)))
        {
            return Err(RemoteError::new(
                codes::INVALID_REQUEST,
                format!(
                    "Method \"{method}\" is not a valid, unreserved method name; expected two \
                     or more dot-separated lowercase segments outside rpc."
                ),
            ));
        }
        let remote = self.ready().await?;
        if reserved && !is_defined_reserved_method(method, remote.effective_minor) {
            let effective_minor = remote.effective_minor;
            return Err(RemoteError::new(
                codes::INVALID_REQUEST,
                format!(
                    "Method \"{method}\" is defined from wire minor {RPC_DISCOVER_MINOR}; this \
                     session negotiated minor {effective_minor}."
                ),
            )
            .with_detail("method", method.to_string())
            .with_detail("effectiveMinor", u64::from(effective_minor)));
        }
        if self.state() == SessionState::Closed {
            return Err(self.unavailable(method));
        }

        let id = self.shared.next_request_id();
        let frame = Frame::Req(Request {
            id: id.clone(),
            method: method.to_string(),
            params,
        });
        self.shared
            .assert_fits(&frame, &format!("Request \"{method}\""))?;

        let (reply_tx, mut reply_rx) = oneshot::channel();
        if self
            .shared
            .commands
            .send(Command::Request {
                frame,
                reply: reply_tx,
            })
            .is_err()
        {
            return Err(RemoteError::new(
                codes::UNAVAILABLE,
                format!("Request \"{method}\" could not be sent: the session driver is gone."),
            ));
        }

        let mut guard = CancelGuard {
            id: id.clone(),
            commands: self.shared.commands.clone(),
            armed: true,
        };
        let deadline = options
            .timeout
            .map(|timeout| tokio::time::Instant::now() + timeout);
        let mut cancel_sent = false;
        let result = loop {
            tokio::select! {
                biased;
                received = &mut reply_rx => {
                    break received.unwrap_or_else(|_| Err(self.unavailable(method)));
                }
                () = cancel_wait(options.cancel.as_ref()), if !cancel_sent => {
                    cancel_sent = true;
                    let _ = self.shared.commands.send(Command::Cancel { id: id.clone(), forget: true });
                }
                () = timeout_wait(deadline) => {
                    let _ = self.shared.commands.send(Command::Cancel { id: id.clone(), forget: false });
                    let timeout_ms = options.timeout.map(|value| value.as_millis()).unwrap_or_default();
                    break Err(RemoteError::new(
                        codes::TIMEOUT,
                        format!("Request \"{method}\" timed out after {timeout_ms}ms."),
                    )
                    .with_detail("method", method.to_string())
                    .with_detail("timeout_ms", u64::try_from(timeout_ms).unwrap_or(u64::MAX)));
                }
            }
        };
        guard.disarm();
        result
    }

    fn unavailable(&self, method: &str) -> RemoteError {
        let closure = self.closure();
        let why = closure
            .as_ref()
            .map(|closure| {
                let reason = closure
                    .reason
                    .as_deref()
                    .map(|reason| format!(": {reason}"))
                    .unwrap_or_default();
                format!(" (closed with {}{reason})", closure.code)
            })
            .unwrap_or_default();
        let error = RemoteError::new(
            codes::UNAVAILABLE,
            format!("Request \"{method}\" cannot complete: the session is closed{why}."),
        )
        .with_detail("method", method.to_string());
        match closure {
            Some(closure) => error.with_detail("close_code", closure.code),
            None => error,
        }
    }

    /// Publishes an event. Sequence numbers are per stream key (`stream_id`,
    /// else `topic`); `end` releases the counter. Returns `Ok(false)`, and
    /// sends nothing, before the handshake completes, after the session
    /// closed, or when the driver has stopped without the session's own
    /// state reflecting it yet — none of those spend the stream key, so a
    /// key `Ok(false)` was returned for is never counted against
    /// `max_stream_keys`. Fails with `FRAME_TOO_LARGE` rather than sending an
    /// oversized frame.
    ///
    /// # Example
    ///
    /// ```
    /// # #[tokio::main(flavor = "current_thread")]
    /// # async fn main() {
    /// use mango_protocol::frame::PeerInfo;
    /// use mango_protocol::port::port_pair;
    /// use mango_protocol::session::{EventInput, Session, SessionOptions};
    /// use serde_json::Value;
    ///
    /// let (a, _b) = port_pair();
    /// let peer = PeerInfo { name: "e".into(), version: "0.1.0".into(), role: "runtime".into() };
    /// let (session, _driver) = Session::open(a, SessionOptions::new(peer));
    /// let sent = session
    ///     .emit(EventInput { topic: "fs.changed".into(), payload: Value::Null, stream_id: None, end: false })
    ///     .expect("emit does not fail before the handshake");
    /// assert!(!sent, "the handshake has not completed yet");
    /// # }
    /// ```
    pub fn emit(&self, event: EventInput) -> Result<bool, RemoteError> {
        if self.state() != SessionState::Ready {
            return Ok(false);
        }
        let EventInput {
            topic,
            payload,
            stream_id,
            end,
        } = event;
        let key = stream_id.clone().unwrap_or_else(|| topic.clone());
        let mut sequences = lock(&self.shared.event_sequences);
        let limit = self.shared.max_stream_keys;
        if !sequences.contains_key(&key) && sequences.len() >= limit {
            return Err(RemoteError::new(
                codes::UNAVAILABLE,
                format!(
                    "Stream key \"{key}\" would be one past the {limit} this session emits on at \
                     once. End a stream before starting another."
                ),
            )
            .with_detail("kind", super::options::STREAM_KEY_LIMIT_KIND)
            .with_detail("key", key)
            .with_detail("limit", u64::try_from(limit).unwrap_or(u64::MAX)));
        }
        let seq = sequences.get(&key).copied().unwrap_or(0);
        let what = format!("Event \"{topic}\"");
        let frame = Frame::Evt(Event {
            topic,
            seq,
            stream_id,
            payload,
            end: end.then_some(End),
        });
        self.shared.assert_fits(&frame, &what)?;
        // `sequences` stays held across the send: two threads racing the same
        // stream key must not be able to interleave their sends in an order
        // that disagrees with the seq numbers they were just given. The send
        // runs *before* the commit, too: a driver that is gone means the
        // frame was never written, and a key nobody saw a frame for must not
        // be spent against `max_stream_keys`.
        if self.shared.commands.send(Command::Send(frame)).is_err() {
            return Ok(false);
        }
        if end {
            sequences.remove(&key);
        } else {
            sequences.insert(key, seq + 1);
        }
        Ok(true)
    }

    /// Subscribes to every event this session receives from its peer, from
    /// the moment of the call onward.
    #[must_use]
    pub fn events(&self) -> EventStream {
        EventStream {
            receiver: self.shared.subscribe_events(),
        }
    }

    /// Sends a protocol `ping`; the peer answers with `pong`.
    pub fn ping(&self) {
        let _ = self.shared.commands.send(Command::Send(Frame::Ping));
    }

    /// Subscribes to every `pong` this session receives, from the moment of
    /// the call onward.
    #[must_use]
    pub fn pongs(&self) -> PongStream {
        PongStream {
            receiver: self.shared.subscribe_pongs(),
        }
    }
}

/// Waits for `cancel` to fire, or never resolves if there is none.
async fn cancel_wait(cancel: Option<&CancellationToken>) {
    match cancel {
        Some(token) => token.cancelled().await,
        None => std::future::pending().await,
    }
}

/// Waits until `deadline`, or never resolves if there is none.
async fn timeout_wait(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(instant) => tokio::time::sleep_until(instant).await,
        None => std::future::pending().await,
    }
}

/// Sends `cancel` for `id` when dropped before being [`CancelGuard::disarm`]ed
/// — covers a request future dropped before it settled, not just an explicit
/// user cancel.
///
/// The drop path forgets the pending entry (`forget: false`): the future that
/// owned the reply receiver is gone, so the peer's eventual answer has nothing
/// to settle and keeping the entry would only grow the driver's map. An
/// explicit user cancel is the opposite case — that future is still awaiting
/// `reply_rx` for the `err CANCELLED` the peer owes it — and sends its own
/// `forget: true` from the `select!` loop rather than through this guard.
struct CancelGuard {
    id: String,
    commands: mpsc::UnboundedSender<Command>,
    armed: bool,
}

impl CancelGuard {
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.commands.send(Command::Cancel {
                id: std::mem::take(&mut self.id),
                forget: false,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::command::Command;
    use super::CancelGuard;
    use tokio::sync::mpsc;

    fn guard(commands: mpsc::UnboundedSender<Command>) -> CancelGuard {
        CancelGuard {
            id: "r-1".into(),
            commands,
            armed: true,
        }
    }

    /// A dropped request future takes its reply receiver with it, so there is
    /// nothing left for a late `res`/`err` to settle: the driver must release
    /// the pending entry rather than hold it for an answer nobody awaits.
    #[test]
    fn a_dropped_guard_cancels_and_releases_the_pending_entry() {
        let (commands, mut received) = mpsc::unbounded_channel();
        drop(guard(commands));

        match received.try_recv() {
            Ok(Command::Cancel { id, forget }) => {
                assert_eq!(id, "r-1");
                assert!(
                    !forget,
                    "expected the dropped guard to release the pending entry: forget = false | \
                     received: forget = true"
                );
            }
            Ok(_) => panic!("expected Command::Cancel | received: another command"),
            Err(error) => panic!("expected Command::Cancel | received: {error}"),
        }
    }

    /// A settled request disarms its guard, so dropping it must send nothing.
    #[test]
    fn a_disarmed_guard_sends_nothing() {
        let (commands, mut received) = mpsc::unbounded_channel();
        let mut guard = guard(commands);
        guard.disarm();
        drop(guard);

        assert!(
            received.try_recv().is_err(),
            "expected a disarmed guard to send no command | received: one"
        );
    }
}
