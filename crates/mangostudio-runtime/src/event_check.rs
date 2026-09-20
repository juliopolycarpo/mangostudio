//! Checking an outbound event's payload against the contract's schema
//! before it reaches [`Session::emit`] — the systemic half of a bug this
//! crate shipped: `runtime.heartbeat`'s `at` went out as an ISO-8601
//! string, against a schema that declares it an `integer`, and nothing
//! caught it before a reviewer did.
//!
//! [`crate::result_check`] already refuses a handler's *result* that drifts
//! from the contract, applied inside [`crate::registry::Registry::implement`]
//! before the audit port ever records `ok`. Nothing did the same for an
//! event a publisher hands to [`Session::emit`] directly — [`checked_emit`]
//! is that missing check, applied at the one place every event this crate
//! sends already passes through: `crate::transport::heartbeat_loop`, today,
//! and whatever topic a later plan adds.
//!
//! Unlike [`crate::result_check::check_result`], a failed check here has no
//! caller waiting on a wire response to carry it: an event is this
//! runtime's own broadcast, not an answer to somebody's request. So there
//! is no `RemoteError` to construct — [`checked_emit`] returns a plain
//! message a transport's own `log` closure can print, and, critically,
//! never calls [`Session::emit`] at all when the payload fails: the point
//! is that a wrong-shaped event cannot ship, not that it ships with a
//! warning attached.

use mango_protocol::session::{EventInput, Session};
use mangostudio_runtime_contract::schemas::validate_event;

/// Validates `input`'s payload against `input.topic`'s declared schema
/// before calling [`Session::emit`]. A payload that fails validation is
/// never sent onto the wire — this returns before `emit` is ever called.
///
/// # Errors
/// A message naming the schema violation (topic and unknown-topic cases) or
/// carrying whatever [`Session::emit`] itself refused with — both flattened
/// to a `String`, since every caller in this crate only ever logs the
/// result, never routes it back to a wire-facing requester.
///
/// # Example
///
/// ```
/// use mango_protocol::frame::PeerInfo;
/// use mango_protocol::port::port_pair;
/// use mango_protocol::session::{EventInput, Session, SessionOptions};
/// use mangostudio_runtime::event_check::checked_emit;
/// use serde_json::json;
///
/// # #[tokio::main(flavor = "current_thread")]
/// # async fn main() {
/// let (a, _b) = port_pair();
/// let peer = PeerInfo { name: "runtime".into(), version: "0.0.0".into(), role: "runtime".into() };
/// let (session, _driver) = Session::spawn(a, SessionOptions::new(peer));
///
/// let wrong_shape = EventInput {
///     topic: "runtime.heartbeat".to_string(),
///     payload: json!({ "at": "2024-01-01T00:00:00.000Z" }),
///     stream_id: None,
///     end: false,
/// };
/// assert!(checked_emit(&session, wrong_shape).is_err());
/// # }
/// ```
pub fn checked_emit(session: &Session, input: EventInput) -> Result<bool, String> {
    if let Err(violation) = validate_event(&input.topic, &input.payload) {
        return Err(violation.to_string());
    }
    session.emit(input).map_err(|error| error.message)
}

#[cfg(test)]
mod tests {
    use mango_protocol::frame::PeerInfo;
    use mango_protocol::port::port_pair;
    use mango_protocol::session::{EventInput, Session, SessionOptions};
    use serde_json::json;

    use super::checked_emit;

    fn peer() -> PeerInfo {
        PeerInfo {
            name: "runtime".into(),
            version: "0.0.0".into(),
            role: "runtime".into(),
        }
    }

    #[tokio::test]
    async fn a_wrong_shaped_payload_is_never_sent() {
        let (a, b) = port_pair();
        let (publisher, _driver_a) = Session::spawn(a, SessionOptions::new(peer()));
        let (subscriber, _driver_b) = Session::spawn(b, SessionOptions::new(peer()));
        publisher
            .ready()
            .await
            .expect("the in-memory pair handshakes");
        let mut events = subscriber.events();

        let error = checked_emit(
            &publisher,
            EventInput {
                topic: "runtime.heartbeat".to_string(),
                // The real regression: a string where the schema declares
                // an integer.
                payload: json!({ "at": "2024-01-01T00:00:00.000Z" }),
                stream_id: None,
                end: false,
            },
        )
        .expect_err("a string \"at\" fails the integer schema");
        assert!(
            error.contains("runtime.heartbeat"),
            "the message must name the subject that failed: {error}"
        );

        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), events.recv())
                .await
                .is_err(),
            "the invalid payload must never have reached the wire at all"
        );
    }

    #[tokio::test]
    async fn a_correctly_shaped_payload_ships() {
        let (a, b) = port_pair();
        let (publisher, _driver_a) = Session::spawn(a, SessionOptions::new(peer()));
        let (subscriber, _driver_b) = Session::spawn(b, SessionOptions::new(peer()));
        publisher
            .ready()
            .await
            .expect("the in-memory pair handshakes");
        let mut events = subscriber.events();

        let sent = checked_emit(
            &publisher,
            EventInput {
                topic: "runtime.heartbeat".to_string(),
                payload: json!({ "at": 1_700_000_000_123_u64 }),
                stream_id: None,
                end: false,
            },
        )
        .expect("an integer \"at\" satisfies the schema");
        assert!(sent, "a ready session must actually deliver it");

        let event = events
            .recv()
            .await
            .expect("the valid payload must have reached the wire");
        assert_eq!(event.payload, json!({ "at": 1_700_000_000_123_u64 }));
    }

    #[tokio::test]
    async fn an_unknown_topic_is_rejected_by_name_before_emit_is_ever_called() {
        let (a, _b) = port_pair();
        let (session, _driver) = Session::spawn(a, SessionOptions::new(peer()));
        // Deliberately not `ready()`-awaited: if this ever reached
        // `Session::emit` it would answer `Ok(false)` (not ready yet), not
        // an error — so an `Err` here can only come from the topic check
        // running first, never from the session itself.
        let error = checked_emit(
            &session,
            EventInput {
                topic: "no.such.topic".to_string(),
                payload: json!({}),
                stream_id: None,
                end: false,
            },
        )
        .expect_err("the catalog has no such topic");
        assert!(error.contains("no.such.topic"), "{error}");
    }
}
