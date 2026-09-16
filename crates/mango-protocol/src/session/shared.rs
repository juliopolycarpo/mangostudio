//! State a `Session` handle and its `SessionDriver` share.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde_json::{Map, Value};
use tokio::sync::{mpsc, watch};

use crate::codec::ndjson::{DEFAULT_MAX_FRAME_BYTES, encode_frame_bytes};
use crate::error::{CodecErrorKind, RemoteError, codes};
use crate::frame::{Event, Frame, PeerInfo};
use crate::version::ProtocolVersion;

use super::command::Command;
use super::handle::{RemotePeer, SessionState};
use super::handler::Handler;
use super::teardown::SessionClosure;

/// Locks a mutex, recovering the guard even if a prior holder panicked.
///
/// Every critical section behind this crate's `std::sync::Mutex`es is a
/// short, panic-free field update, so poisoning never reflects a corrupted
/// invariant here; treating it as recoverable avoids a second panic on top of
/// whatever caused the first one.
pub(super) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Driver-mutated fields a handle needs to read synchronously, behind one
/// lock so a reader never observes a half-updated combination.
pub(super) struct Inner {
    pub(super) state: SessionState,
    /// `Arc`-wrapped so a hot-path reader (`dispatch::on_request`, once per
    /// inbound request) clones a refcount, not the peer's announced
    /// capability object.
    pub(super) remote: Option<Arc<RemotePeer>>,
}

/// A method's handler, and the generation it was registered under (so a
/// `HandlerGuard` can tell whether it is still the one in force before
/// unregistering it on drop).
type HandlerRegistry = HashMap<String, (u64, Arc<dyn Handler>)>;

/// The state a [`super::handle::Session`] handle and its `SessionDriver` share.
pub(super) struct Shared {
    pub(super) local_peer: PeerInfo,
    pub(super) local_protocol: ProtocolVersion,
    pub(super) local_capabilities: Map<String, Value>,
    pub(super) local_max_frame_bytes: usize,
    /// How many inbound requests this side will answer at once (§11.2).
    pub(super) max_in_flight: usize,
    /// How many stream keys this side will emit on at once (§11.2).
    pub(super) max_stream_keys: usize,
    pub(super) inner: Mutex<Inner>,
    pub(super) ready: watch::Sender<Option<Result<RemotePeer, RemoteError>>>,
    pub(super) closure: watch::Sender<Option<SessionClosure>>,
    pub(super) commands: mpsc::UnboundedSender<Command>,
    pub(super) request_id_prefix: String,
    pub(super) request_sequence: AtomicU64,
    /// How many inbound requests this session is answering right now.
    pub(super) in_flight: AtomicUsize,
    pub(super) handlers: Mutex<HandlerRegistry>,
    pub(super) next_generation: AtomicU64,
    /// How long teardown waits for in-flight handlers to settle.
    pub(super) handler_grace: Duration,
    /// Per-stream-key sequence counters (`streamId`, else `topic`), read and
    /// advanced by `emit` under the same lock, so lock-acquisition order is
    /// exactly wire order.
    pub(super) event_sequences: Mutex<HashMap<String, u64>>,
    pub(super) event_subscribers: Mutex<Vec<mpsc::UnboundedSender<Event>>>,
    pub(super) pong_subscribers: Mutex<Vec<mpsc::UnboundedSender<()>>>,
}

impl Shared {
    /// The frame ceiling this side may send: the lower of both announced
    /// limits.
    pub(super) fn send_limit_bytes(&self) -> usize {
        let remote_limit = lock(&self.inner)
            .remote
            .as_ref()
            .and_then(|remote| remote.limits.as_ref())
            .and_then(|limits| limits.max_frame_bytes)
            .map_or(DEFAULT_MAX_FRAME_BYTES, |bytes| {
                usize::try_from(bytes).unwrap_or(usize::MAX)
            });
        self.local_max_frame_bytes.min(remote_limit)
    }

    /// How many requests the peer announced it will answer at once, or the
    /// default when it announced nothing.
    pub(super) fn remote_max_in_flight(&self) -> usize {
        lock(&self.inner)
            .remote
            .as_ref()
            .and_then(|remote| remote.limits.as_ref())
            .and_then(|limits| limits.max_in_flight)
            .map_or(super::options::DEFAULT_MAX_IN_FLIGHT, |count| {
                usize::try_from(count).unwrap_or(usize::MAX)
            })
    }

    /// Validates `frame` and measures its encoded size against the session's
    /// negotiated limit, mirroring what a port's own `send` would discover,
    /// but synchronously and before the frame ever reaches the port.
    ///
    /// [`crate::port::PortTx::send`] promises its implementors exactly this:
    /// that a session has already run both checks, so a port may trust the
    /// frame it is handed. Every outbound frame this session builds — the
    /// handshake `hello` included — goes through here first.
    pub(super) fn assert_fits(&self, frame: &Frame, what: &str) -> Result<(), RemoteError> {
        let limit = self.send_limit_bytes();
        match encode_frame_bytes(frame, limit) {
            Ok(_) => Ok(()),
            Err(error) if error.kind == CodecErrorKind::TooLarge => {
                let bytes = serde_json::to_vec(frame).map_or(limit + 1, |encoded| encoded.len());
                Err(RemoteError::new(
                    codes::FRAME_TOO_LARGE,
                    format!("{what} encodes to {bytes} bytes; the session limit is {limit} bytes."),
                )
                .with_detail("bytes", u64::try_from(bytes).unwrap_or(u64::MAX))
                .with_detail("limit", u64::try_from(limit).unwrap_or(u64::MAX)))
            }
            Err(error) => Err(RemoteError::new(
                codes::INTERNAL,
                format!("{what} failed to encode: {error}"),
            )),
        }
    }

    /// Settles the ready watch with `outcome`, unless something already
    /// settled it (never overwrites an earlier outcome). A specific failure
    /// (a version mismatch, a handshake timeout) calls this directly;
    /// teardown's own generic failure is a no-op whenever a specific one
    /// already ran.
    pub(super) fn settle_ready(&self, outcome: Result<RemotePeer, RemoteError>) {
        let _ = self.ready.send_if_modified(|current| {
            if current.is_some() {
                return false;
            }
            *current = Some(outcome);
            true
        });
    }

    /// The next outbound request id: `"{prefix}-{sequence}"`, 1-based.
    pub(super) fn next_request_id(&self) -> String {
        let sequence = self.request_sequence.fetch_add(1, Ordering::Relaxed) + 1;
        format!("{}-{sequence}", self.request_id_prefix)
    }

    /// Registers `handler` under `method`, replacing whatever was there.
    pub(super) fn register_handler(
        &self,
        method: String,
        handler: Arc<dyn Handler>,
    ) -> (String, u64) {
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        lock(&self.handlers).insert(method.clone(), (generation, handler));
        (method, generation)
    }

    /// Registers a new event subscriber, returning its receiving half.
    pub(super) fn subscribe_events(&self) -> mpsc::UnboundedReceiver<Event> {
        let (sender, receiver) = mpsc::unbounded_channel();
        lock(&self.event_subscribers).push(sender);
        receiver
    }

    /// Registers a new pong subscriber, returning its receiving half.
    pub(super) fn subscribe_pongs(&self) -> mpsc::UnboundedReceiver<()> {
        let (sender, receiver) = mpsc::unbounded_channel();
        lock(&self.pong_subscribers).push(sender);
        receiver
    }

    /// Delivers `event` to every live subscriber, but only once the session
    /// is ready — mirrors the TS receive-side gate exactly (a session drops
    /// an `evt` frame that arrives before its own handshake finished).
    pub(super) fn fan_out_event(&self, event: Event) {
        if lock(&self.inner).state != SessionState::Ready {
            return;
        }
        lock(&self.event_subscribers).retain(|sender| sender.send(event.clone()).is_ok());
    }

    /// Delivers one liveness pong to every live subscriber.
    pub(super) fn fan_out_pong(&self) {
        lock(&self.pong_subscribers).retain(|sender| sender.send(()).is_ok());
    }
}
