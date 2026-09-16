//! The eight frame types of wire 1 and their members (§4 to §10).
//!
//! Envelopes are tolerant: unknown members are ignored at every level, so no
//! type here uses `deny_unknown_fields`. Optional members are **absent**, never
//! `null`; a private helper enforces that on deserialisation.

use serde::de::{Error as DeError, Unexpected};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};

use crate::version::ProtocolVersion;

/// Deserialisers for optional members that must be absent rather than `null`.
///
/// `#[serde(default, deserialize_with = "present::option")]` reads a missing
/// member as `None` and refuses an explicit `null`, which the specification
/// does not accept for an optional member.
pub(crate) mod present {
    use serde::{Deserialize, Deserializer};

    /// Deserialises a present member into `Some`, refusing `null`.
    pub(crate) fn option<'de, T, D>(deserializer: D) -> Result<Option<T>, D::Error>
    where
        T: Deserialize<'de>,
        D: Deserializer<'de>,
    {
        T::deserialize(deserializer).map(Some)
    }
}

/// The `end` marker of an `evt`: the only JSON value it accepts is `true`.
///
/// A unit-like type rather than a `bool` so `end: false` is a decoder refusal
/// instead of a silently accepted no-op.
///
/// # Example
///
/// ```
/// use mango_protocol::frame::End;
///
/// assert_eq!(serde_json::to_string(&End).unwrap(), "true");
/// assert!(serde_json::from_str::<End>("false").is_err());
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct End;

impl Serialize for End {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bool(true)
    }
}

impl<'de> Deserialize<'de> for End {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match bool::deserialize(deserializer)? {
            true => Ok(Self),
            false => Err(D::Error::invalid_value(
                Unexpected::Bool(false),
                &"the literal true",
            )),
        }
    }
}

#[cfg(feature = "schema")]
impl schemars::JsonSchema for End {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> std::borrow::Cow<'static, str> {
        "end".into()
    }

    fn schema_id() -> std::borrow::Cow<'static, str> {
        concat!(module_path!(), "::End").into()
    }

    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
        crate::schema::constraints::end(generator)
    }
}

/// Who the peer is (`hello.peer`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "schema", schemars(rename = "peer"))]
pub struct PeerInfo {
    /// Implementation name: a product or binary name, 1 to 128 characters.
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::schema::constraints::peer_label")
    )]
    pub name: String,
    /// The implementation's release string, opaque to the protocol, 1 to 128 characters.
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::schema::constraints::peer_label")
    )]
    pub version: String,
    /// Lowercase label matching `^[a-z][a-z0-9-]*$`, at most 64 characters.
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::schema::constraints::role")
    )]
    pub role: String,
}

/// The ceilings a peer announces in `hello.limits`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "schema", schemars(rename = "limits"))]
pub struct Limits {
    /// Lowers the frame size ceiling this peer will accept; at least `4096` bytes.
    #[serde(
        rename = "maxFrameBytes",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present::option"
    )]
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::schema::constraints::max_frame_bytes")
    )]
    pub max_frame_bytes: Option<u64>,
    /// How many requests this peer will hold open for the other side at once;
    /// at least `1`. Absent means the default of 256 (§11.2). Wire minor 1.
    #[serde(
        rename = "maxInFlight",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present::option"
    )]
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::schema::constraints::max_in_flight")
    )]
    pub max_in_flight: Option<u64>,
}

/// Handshake frame; both peers send exactly one as soon as the transport opens.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "schema", schemars(rename = "hello"))]
pub struct Hello {
    /// The highest wire version of its major that the sender implements.
    pub protocol: ProtocolVersion,
    /// Who the sender is.
    pub peer: PeerInfo,
    /// Owned by the application contract; `{}` is valid but the member is required.
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::schema::constraints::open_object")
    )]
    pub capabilities: Map<String, Value>,
    /// Optional lower ceilings for this connection.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present::option"
    )]
    pub limits: Option<Limits>,
}

/// A request. Exactly one [`Response`] or [`ErrorResponse`] answers it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "schema", schemars(rename = "req"))]
pub struct Request {
    /// 1 to 256 characters, unique among the requester's in-flight requests.
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::schema::constraints::id")
    )]
    pub id: String,
    /// Dot-separated lowercase name; see [`crate::validate::is_valid_method_name`].
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::schema::constraints::method_name")
    )]
    pub method: String,
    /// Any JSON value, including `null`. Contracts should require an object.
    pub params: Value,
}

/// A successful response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "schema", schemars(rename = "res"))]
pub struct Response {
    /// The `id` of the request being answered.
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::schema::constraints::id")
    )]
    pub id: String,
    /// Any JSON value, including `null`.
    pub result: Value,
}

/// The `error` member of an [`ErrorResponse`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "schema", schemars(rename = "errorPayload"))]
pub struct ErrorPayload {
    /// Matches `^[A-Z][A-Z0-9_]*$`, 1 to 64 characters. Unknown codes are preserved.
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::schema::constraints::error_code")
    )]
    pub code: String,
    /// A non-empty sentence naming the received value and the expected shape.
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::schema::constraints::error_message")
    )]
    pub message: String,
    /// Optional open object for typed detail.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present::option"
    )]
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::schema::constraints::open_object")
    )]
    pub details: Option<Map<String, Value>>,
}

/// A failed response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "schema", schemars(rename = "err"))]
pub struct ErrorResponse {
    /// The `id` of the request being answered.
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::schema::constraints::id")
    )]
    pub id: String,
    /// Why the request failed.
    pub error: ErrorPayload,
}

/// An event, optionally part of a stream.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "schema", schemars(rename = "evt"))]
pub struct Event {
    /// Same grammar as a method name; `rpc.` is reserved.
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::schema::constraints::method_name")
    )]
    pub topic: String,
    /// Non-negative counter, `0` for the first event on a stream key, `+1` per event.
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::schema::constraints::non_negative")
    )]
    pub seq: u64,
    /// The stream key when present; the topic is the key otherwise.
    #[serde(
        rename = "streamId",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present::option"
    )]
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::schema::constraints::id")
    )]
    pub stream_id: Option<String>,
    /// Any JSON value, including `null`.
    pub payload: Value,
    /// Present and `true` on the last event of a stream key.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present::option"
    )]
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::schema::constraints::end")
    )]
    pub end: Option<End>,
}

/// An advisory request to stop work; the original response still follows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "schema", schemars(rename = "cancel"))]
pub struct Cancel {
    /// The `id` of the request to stop.
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::schema::constraints::id")
    )]
    pub id: String,
}

/// A farewell sent once, immediately before the sender shuts the transport.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "schema", schemars(rename = "close"))]
pub struct Close {
    /// An integer in `4000..=4999`; see [`crate::close::close_codes`].
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::schema::constraints::close_code")
    )]
    pub code: u16,
    /// At most 1024 characters.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present::option"
    )]
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::schema::constraints::close_reason")
    )]
    pub reason: Option<String>,
}

/// One frame: a JSON object whose `type` member names the variant.
///
/// # Example
///
/// ```
/// use mango_protocol::Frame;
///
/// let frame: Frame = serde_json::from_str(r#"{"type":"ping"}"#).unwrap();
/// assert_eq!(frame, Frame::Ping);
/// ```
// No `JsonSchema` derive here on purpose: `emit_schema` builds the spec-keyed
// document, and a derived `schema_for!(Frame)` would describe a different shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Frame {
    /// Handshake.
    Hello(Hello),
    /// Request.
    Req(Request),
    /// Successful response.
    Res(Response),
    /// Failed response.
    Err(ErrorResponse),
    /// Event, optionally part of a stream.
    Evt(Event),
    /// Ask the responder to stop a request.
    Cancel(Cancel),
    /// Liveness probe.
    Ping,
    /// Liveness answer.
    Pong,
    /// Farewell with a reason.
    Close(Close),
}

impl Frame {
    /// The value of the frame's `type` member.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::Frame;
    ///
    /// assert_eq!(Frame::Pong.type_name(), "pong");
    /// ```
    #[must_use]
    pub const fn type_name(&self) -> &'static str {
        match self {
            Self::Hello(_) => "hello",
            Self::Req(_) => "req",
            Self::Res(_) => "res",
            Self::Err(_) => "err",
            Self::Evt(_) => "evt",
            Self::Cancel(_) => "cancel",
            Self::Ping => "ping",
            Self::Pong => "pong",
            Self::Close(_) => "close",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Close, End, Event, Frame, Hello, Limits, PeerInfo};
    use crate::version::ProtocolVersion;
    use serde_json::{Map, Value, json};

    fn hello() -> Frame {
        Frame::Hello(Hello {
            protocol: ProtocolVersion::new(1, 0),
            peer: PeerInfo {
                name: "fixture".into(),
                version: "0.0.0".into(),
                role: "tool".into(),
            },
            capabilities: Map::new(),
            limits: None,
        })
    }

    #[test]
    fn the_tag_leads_the_encoded_object() {
        let text = serde_json::to_string(&hello()).expect("serialises");
        assert!(text.starts_with(r#"{"type":"hello","protocol":"#), "{text}");
    }

    #[test]
    fn absent_optionals_are_not_serialised() {
        let text = serde_json::to_string(&hello()).expect("serialises");
        assert!(!text.contains("limits"), "{text}");
    }

    #[test]
    fn an_explicit_null_optional_is_refused() {
        let line = r#"{"type":"hello","protocol":{"major":1,"minor":0},"peer":{"name":"f","version":"0","role":"tool"},"capabilities":{},"limits":null}"#;
        let error = serde_json::from_str::<Frame>(line).expect_err("null limits is refused");
        assert!(error.to_string().contains("null"), "{error}");
    }

    #[test]
    fn unknown_members_are_ignored_at_every_level() {
        let line = r#"{"type":"ping","x-at":123}"#;
        assert_eq!(
            serde_json::from_str::<Frame>(line).expect("decodes"),
            Frame::Ping
        );
    }

    #[test]
    fn end_serialises_as_the_literal_true() {
        assert_eq!(serde_json::to_string(&End).expect("serialises"), "true");
    }

    #[test]
    fn end_refuses_false_and_every_other_value() {
        assert!(serde_json::from_str::<End>("false").is_err());
        assert!(serde_json::from_str::<End>("1").is_err());
        assert!(serde_json::from_str::<End>("null").is_err());
        assert_eq!(serde_json::from_str::<End>("true").expect("decodes"), End);
    }

    #[test]
    fn an_event_keeps_its_wire_member_names() {
        let frame = Frame::Evt(Event {
            topic: "terminal.output".into(),
            seq: 3,
            stream_id: Some("t-7".into()),
            payload: json!({ "data": "bye" }),
            end: Some(End),
        });
        let value: Value = serde_json::to_value(&frame).expect("serialises");
        assert_eq!(value["streamId"], json!("t-7"));
        assert_eq!(value["end"], json!(true));
    }

    #[test]
    fn max_frame_bytes_uses_its_camel_case_name() {
        let limits = Limits {
            max_frame_bytes: Some(4096),
            max_in_flight: None,
        };
        let text = serde_json::to_string(&limits).expect("serialises");
        assert_eq!(text, r#"{"maxFrameBytes":4096}"#);
    }

    #[test]
    fn every_type_name_matches_the_wire_tag() {
        let frames = [
            (hello(), "hello"),
            (Frame::Ping, "ping"),
            (Frame::Pong, "pong"),
            (
                Frame::Close(Close {
                    code: 4000,
                    reason: None,
                }),
                "close",
            ),
        ];
        for (frame, name) in frames {
            assert_eq!(frame.type_name(), name);
            let value: Value = serde_json::to_value(&frame).expect("serialises");
            assert_eq!(value["type"], json!(name));
        }
    }

    #[test]
    fn an_unknown_type_is_refused() {
        assert!(serde_json::from_str::<Frame>(r#"{"type":"nope"}"#).is_err());
    }
}
