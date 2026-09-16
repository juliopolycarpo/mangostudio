//! Typed event emission and subscription over one session.

use std::marker::PhantomData;

use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::error::{RemoteError, codes};
use crate::frame::Event;
use crate::session::{EventInput, EventStream, Session};

/// Tunes one [`ContractEvents::emit`] call: which stream it belongs to, and
/// whether it is the stream's last event.
///
/// # Example
///
/// ```
/// use mango_protocol::contract::EventOptions;
///
/// let options = EventOptions { stream_id: Some("s1".into()), end: true };
/// assert!(options.end);
/// ```
#[derive(Default)]
pub struct EventOptions {
    /// Correlates one multi-frame stream; sequence numbers are per stream.
    pub stream_id: Option<String>,
    /// Marks the last event of the stream and releases its counter.
    pub end: bool,
}

/// One typed event a [`TypedEventStream`] yielded: the decoded payload plus
/// the raw frame it decoded from, for `seq`/`stream_id`/`end`.
#[derive(Debug, Clone)]
pub struct TypedEvent<T> {
    /// The event's payload, decoded as `T`.
    pub payload: T,
    /// The wire frame the payload was decoded from.
    pub frame: Event,
}

/// A live, topic-filtered, typed subscription from [`ContractEvents::subscribe`].
pub struct TypedEventStream<T> {
    topic: String,
    stream: EventStream,
    _payload: PhantomData<fn() -> T>,
}

impl<T: DeserializeOwned> TypedEventStream<T> {
    /// The next event on this subscription's topic, or `None` once the
    /// session has closed. `Some(Err(_))` when a wire payload does not
    /// decode as `T` — surfaced, not silently skipped, since that is exactly
    /// the schema/type drift [`super::Contract::parse_params`] is designed
    /// to catch on the request side.
    pub async fn recv(&mut self) -> Option<Result<TypedEvent<T>, RemoteError>> {
        loop {
            let frame = self.stream.recv().await?;
            if frame.topic != self.topic {
                continue;
            }
            let topic = &self.topic;
            let decoded = serde_json::from_value(frame.payload.clone())
                .map(|payload| TypedEvent {
                    payload,
                    frame: frame.clone(),
                })
                .map_err(|error| {
                    RemoteError::new(
                        codes::INTERNAL,
                        format!(
                            "Event \"{topic}\" payload does not decode into the expected type: \
                             {error}."
                        ),
                    )
                    .with_detail("topic", topic.clone())
                });
            return Some(decoded);
        }
    }
}

/// Typed event emission and subscription over one [`Session`], from
/// [`super::Contract::events`].
pub struct ContractEvents<'a> {
    session: &'a Session,
}

impl<'a> ContractEvents<'a> {
    pub(super) fn new(session: &'a Session) -> Self {
        Self { session }
    }

    /// Publishes `payload` on `topic`, serialised to the wire. Returns
    /// `Ok(false)`, and sends nothing, before the handshake completes or
    /// after the session closed — the topic is not checked against the
    /// contract, matching the TypeScript SDK's own `events().emit`.
    ///
    /// # Errors
    /// `INTERNAL` if `payload` fails to serialise; otherwise whatever
    /// [`Session::emit`] returns.
    pub fn emit<T: Serialize>(
        &self,
        topic: &str,
        payload: T,
        options: EventOptions,
    ) -> Result<bool, RemoteError> {
        let payload = serde_json::to_value(payload).map_err(|error| {
            RemoteError::new(
                codes::INTERNAL,
                format!("Event \"{topic}\" payload failed to serialise: {error}."),
            )
            .with_detail("topic", topic.to_string())
        })?;
        self.session.emit(EventInput {
            topic: topic.to_string(),
            payload,
            stream_id: options.stream_id,
            end: options.end,
        })
    }

    /// Subscribes to every event on `topic` from the moment of the call
    /// onward, decoding each payload as `T`.
    #[must_use]
    pub fn subscribe<T: DeserializeOwned>(&self, topic: &str) -> TypedEventStream<T> {
        TypedEventStream {
            topic: topic.to_string(),
            stream: self.session.events(),
            _payload: PhantomData,
        }
    }
}
