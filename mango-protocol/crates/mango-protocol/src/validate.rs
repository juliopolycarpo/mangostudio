//! The rules serde cannot express: lengths, grammars and ranges.
//!
//! Serde proves a frame's shape; this module proves its values. The decoders in
//! [`crate::codec`] run [`validate`] after parsing, so a frame handed to a
//! session has already passed both.

use std::fmt;

use crate::close::{MAX_CLOSE_CODE, MIN_CLOSE_CODE};
use crate::frame::{Close, ErrorPayload, Event, Frame, Hello, Limits, Request, Response};

/// Longest `id` and `streamId`, in characters.
pub const MAX_ID_CHARS: usize = 256;
/// Shortest `method` and `topic`: two one-character segments and their dot.
pub const MIN_NAME_CHARS: usize = 3;
/// Longest `method`, `topic`, `peer.name` and `peer.version`, in characters.
pub const MAX_NAME_CHARS: usize = 128;
/// The `method` and `topic` grammar of §6.1, as the schema spells it.
///
/// [`is_valid_method_name`] applies it by hand; this crate takes no regex
/// dependency, so the pattern exists to state the rule in an error message and
/// in the JSON Schema emission.
pub const METHOD_NAME_PATTERN: &str =
    r"^[a-z](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z](?:[a-z0-9-]*[a-z0-9])?)+$";
/// Longest `error.code` and `peer.role`, in characters.
pub const MAX_CODE_CHARS: usize = 64;
/// Method names and event topics under this segment belong to the specification (§6.1).
pub const RPC_RESERVED_PREFIX: &str = "rpc.";
/// Longest `close.reason`, in characters.
pub const MAX_REASON_CHARS: usize = 1024;
/// Lowest `limits.maxFrameBytes` the schema allows; the floor under any ceiling
/// a peer may announce, re-exported as [`crate::codec::ndjson::MIN_MAX_FRAME_BYTES`].
pub const MIN_ANNOUNCED_FRAME_BYTES: u64 = 4096;
/// Highest `limits.maxFrameBytes` the schema allows.
pub const MAX_ANNOUNCED_FRAME_BYTES: u64 = 2_147_483_647;
/// Lowest `limits.maxInFlight` the schema allows: a peer that answers nothing
/// closes instead of announcing zero (§11.2).
pub const MIN_ANNOUNCED_IN_FLIGHT: u64 = 1;
/// Highest `limits.maxInFlight` the schema allows.
pub const MAX_ANNOUNCED_IN_FLIGHT: u64 = 2_147_483_647;

/// A frame member that broke a rule the JSON Schema states and serde cannot.
///
/// # Example
///
/// ```
/// use mango_protocol::{Frame, Request, validate};
/// use serde_json::Value;
///
/// let frame = Frame::Req(Request { id: String::new(), method: "a.b".into(), params: Value::Null });
/// let error = validate(&frame).unwrap_err();
/// assert_eq!(error.field, "req.id");
/// assert!(error.to_string().contains("expected"));
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationError {
    /// Dotted path of the offending member, for example `hello.peer.role`.
    pub field: String,
    /// The value that arrived, rendered for a log line.
    pub received: String,
    /// The shape the specification requires.
    pub expected: String,
}

impl ValidationError {
    fn new(field: &str, received: String, expected: impl Into<String>) -> Self {
        Self {
            field: field.to_owned(),
            received,
            expected: expected.into(),
        }
    }
}

impl fmt::Display for ValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{}: received {}, expected {}",
            self.field, self.received, self.expected
        )
    }
}

impl std::error::Error for ValidationError {}

/// Renders a string for an error message, truncating a long one.
fn describe(value: &str) -> String {
    let count = value.chars().count();
    if count <= 48 {
        return format!("{value:?}");
    }
    let head: String = value.chars().take(48).collect();
    format!("{head:?}… ({count} characters)")
}

/// True when every character is a lowercase letter, a digit or a dash, the
/// first is a letter and the last is not a dash.
fn is_valid_segment(segment: &str) -> bool {
    let mut characters = segment.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    if !first.is_ascii_lowercase() {
        return false;
    }
    if segment.ends_with('-') {
        return false;
    }
    segment.chars().all(|character| {
        character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
    })
}

/// True when the name matches the method and topic grammar of §6.1.
///
/// At least two dot-separated segments, each starting with a lowercase letter,
/// made of lowercase letters, digits and dashes, never ending with a dash, and
/// at most [`MAX_NAME_CHARS`] characters overall.
///
/// # Example
///
/// ```
/// use mango_protocol::validate::is_valid_method_name;
///
/// assert!(is_valid_method_name("runtime.update.begin-transfer"));
/// assert!(!is_valid_method_name("fs"));
/// ```
#[must_use]
pub fn is_valid_method_name(name: &str) -> bool {
    if name.chars().count() > MAX_NAME_CHARS {
        return false;
    }
    let mut segments = name.split('.');
    let Some(first) = segments.next() else {
        return false;
    };
    let mut count = 1;
    if !is_valid_segment(first) {
        return false;
    }
    for segment in segments {
        if !is_valid_segment(segment) {
            return false;
        }
        count += 1;
    }
    count >= 2
}

/// True when `name` sits under the reserved `rpc.` segment.
///
/// Such a name belongs to the specification, never to an application. One the
/// effective minor defines is served (see [`is_defined_reserved_method`]);
/// every other is answered with `INVALID_REQUEST`.
///
/// # Example
///
/// ```
/// use mango_protocol::validate::is_reserved_method_name;
///
/// assert!(is_reserved_method_name("rpc.discover"));
/// assert!(!is_reserved_method_name("fs.read-file"));
/// ```
#[must_use]
pub fn is_reserved_method_name(name: &str) -> bool {
    name.starts_with(RPC_RESERVED_PREFIX)
}

/// The reserved method that answers with the responder's catalog (§6.4).
pub const RPC_DISCOVER: &str = "rpc.discover";

/// Effective minor from which [`RPC_DISCOVER`] is part of the wire.
pub const RPC_DISCOVER_MINOR: u32 = 1;

/// True when `name` is a reserved method this wire defines at
/// `effective_minor`.
///
/// Every other `rpc.` name is refused with `INVALID_REQUEST`, `rpc.discover`
/// against a 1.0 peer included: that peer cannot have meant this method.
///
/// # Example
///
/// ```
/// use mango_protocol::validate::is_defined_reserved_method;
///
/// assert!(is_defined_reserved_method("rpc.discover", 1));
/// assert!(!is_defined_reserved_method("rpc.discover", 0));
/// assert!(!is_defined_reserved_method("rpc.unknown", 1));
/// ```
#[must_use]
pub fn is_defined_reserved_method(name: &str, effective_minor: u32) -> bool {
    name == RPC_DISCOVER && effective_minor >= RPC_DISCOVER_MINOR
}

/// True when the role matches `^[a-z][a-z0-9-]*$` and fits [`MAX_CODE_CHARS`].
///
/// # Example
///
/// ```
/// use mango_protocol::validate::is_valid_role;
///
/// assert!(is_valid_role("runtime"));
/// assert!(!is_valid_role("Runtime"));
/// ```
#[must_use]
pub fn is_valid_role(role: &str) -> bool {
    let count = role.chars().count();
    (1..=MAX_CODE_CHARS).contains(&count) && is_valid_segment(role)
}

/// True when the code matches `^[A-Z][A-Z0-9_]*$` and fits [`MAX_CODE_CHARS`].
///
/// The code needs no reservation: an application code is as valid as a
/// reserved one, and [`crate::error::is_reserved_error_code`] tells them apart.
///
/// # Example
///
/// ```
/// use mango_protocol::validate::is_valid_error_code;
///
/// assert!(is_valid_error_code("APP_QUOTA_2"));
/// assert!(!is_valid_error_code("denied"));
/// ```
#[must_use]
pub fn is_valid_error_code(code: &str) -> bool {
    let count = code.chars().count();
    if !(1..=MAX_CODE_CHARS).contains(&count) {
        return false;
    }
    let mut characters = code.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    first.is_ascii_uppercase()
        && characters.all(|character| {
            character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
        })
}

/// Checks a string member's character count against an inclusive range.
fn check_length(field: &str, value: &str, min: usize, max: usize) -> Result<(), ValidationError> {
    let count = value.chars().count();
    if (min..=max).contains(&count) {
        return Ok(());
    }
    Err(ValidationError::new(
        field,
        describe(value),
        format!("a string of {min} to {max} characters"),
    ))
}

/// Checks an `id` or a `streamId`.
fn check_id(field: &str, value: &str) -> Result<(), ValidationError> {
    check_length(field, value, 1, MAX_ID_CHARS)
}

/// Checks a `method` or a `topic` against the grammar of §6.1.
fn check_method_name(field: &str, value: &str) -> Result<(), ValidationError> {
    if is_valid_method_name(value) {
        return Ok(());
    }
    Err(ValidationError::new(
        field,
        describe(value),
        format!(
            "at least two dot-separated lowercase segments matching \
             {METHOD_NAME_PATTERN}, at most {MAX_NAME_CHARS} characters"
        ),
    ))
}

fn validate_limits(limits: &Limits) -> Result<(), ValidationError> {
    check_range(
        "hello.limits.maxFrameBytes",
        limits.max_frame_bytes,
        MIN_ANNOUNCED_FRAME_BYTES,
        MAX_ANNOUNCED_FRAME_BYTES,
    )?;
    check_range(
        "hello.limits.maxInFlight",
        limits.max_in_flight,
        MIN_ANNOUNCED_IN_FLIGHT,
        MAX_ANNOUNCED_IN_FLIGHT,
    )
}

/// An optional announced ceiling, refused when it is present and outside its
/// range. Absent is always fine: an absent limit is the default, not a zero.
fn check_range(
    field: &str,
    value: Option<u64>,
    minimum: u64,
    maximum: u64,
) -> Result<(), ValidationError> {
    let Some(value) = value else {
        return Ok(());
    };
    if (minimum..=maximum).contains(&value) {
        return Ok(());
    }
    Err(ValidationError::new(
        field,
        value.to_string(),
        format!("an integer from {minimum} to {maximum}"),
    ))
}

fn validate_hello(hello: &Hello) -> Result<(), ValidationError> {
    if hello.protocol.major < 1 {
        return Err(ValidationError::new(
            "hello.protocol.major",
            hello.protocol.major.to_string(),
            "an integer of at least 1",
        ));
    }
    check_length("hello.peer.name", &hello.peer.name, 1, MAX_NAME_CHARS)?;
    check_length("hello.peer.version", &hello.peer.version, 1, MAX_NAME_CHARS)?;
    if !is_valid_role(&hello.peer.role) {
        return Err(ValidationError::new(
            "hello.peer.role",
            describe(&hello.peer.role),
            format!(
                "a lowercase label matching ^[a-z][a-z0-9-]*$, at most {MAX_CODE_CHARS} characters"
            ),
        ));
    }
    match &hello.limits {
        Some(limits) => validate_limits(limits),
        None => Ok(()),
    }
}

fn validate_error_payload(field: &str, payload: &ErrorPayload) -> Result<(), ValidationError> {
    if !is_valid_error_code(&payload.code) {
        return Err(ValidationError::new(
            &format!("{field}.code"),
            describe(&payload.code),
            format!("a code matching ^[A-Z][A-Z0-9_]*$, 1 to {MAX_CODE_CHARS} characters"),
        ));
    }
    check_length(&format!("{field}.message"), &payload.message, 1, usize::MAX)
}

fn validate_request(request: &Request) -> Result<(), ValidationError> {
    check_id("req.id", &request.id)?;
    check_method_name("req.method", &request.method)
}

fn validate_response(response: &Response) -> Result<(), ValidationError> {
    check_id("res.id", &response.id)
}

fn validate_event(event: &Event) -> Result<(), ValidationError> {
    check_method_name("evt.topic", &event.topic)?;
    match &event.stream_id {
        Some(stream_id) => check_id("evt.streamId", stream_id),
        None => Ok(()),
    }
}

fn validate_close(close: &Close) -> Result<(), ValidationError> {
    if !(MIN_CLOSE_CODE..=MAX_CLOSE_CODE).contains(&close.code) {
        return Err(ValidationError::new(
            "close.code",
            close.code.to_string(),
            format!("an integer from {MIN_CLOSE_CODE} to {MAX_CLOSE_CODE}"),
        ));
    }
    match &close.reason {
        Some(reason) => check_length("close.reason", reason, 0, MAX_REASON_CHARS),
        None => Ok(()),
    }
}

/// Applies every length, grammar and range rule of the specification to a frame.
///
/// Serde has already proved the frame's shape by the time this runs; what is
/// left is what a JSON Schema states with `pattern`, `minLength`, `maxLength`,
/// `minimum` and `maximum`.
///
/// # Example
///
/// ```
/// use mango_protocol::{Close, Frame, validate};
///
/// assert!(validate(&Frame::Close(Close { code: 4000, reason: None })).is_ok());
/// assert!(validate(&Frame::Close(Close { code: 3999, reason: None })).is_err());
/// ```
pub fn validate(frame: &Frame) -> Result<(), ValidationError> {
    match frame {
        Frame::Hello(hello) => validate_hello(hello),
        Frame::Req(request) => validate_request(request),
        Frame::Res(response) => validate_response(response),
        Frame::Err(error) => {
            check_id("err.id", &error.id)?;
            validate_error_payload("err.error", &error.error)
        }
        Frame::Evt(event) => validate_event(event),
        Frame::Cancel(cancel) => check_id("cancel.id", &cancel.id),
        Frame::Ping | Frame::Pong => Ok(()),
        Frame::Close(close) => validate_close(close),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        MAX_ID_CHARS, MAX_NAME_CHARS, is_reserved_method_name, is_valid_error_code,
        is_valid_method_name, is_valid_role, validate,
    };
    use crate::frame::{
        Cancel, Close, ErrorPayload, ErrorResponse, Event, Frame, Hello, Limits, PeerInfo, Request,
    };
    use crate::version::ProtocolVersion;
    use serde_json::{Map, Value};

    fn request(id: &str, method: &str) -> Frame {
        Frame::Req(Request {
            id: id.to_owned(),
            method: method.to_owned(),
            params: Value::Null,
        })
    }

    fn hello_with(role: &str, limits: Option<Limits>) -> Frame {
        Frame::Hello(Hello {
            protocol: ProtocolVersion::new(1, 0),
            peer: PeerInfo {
                name: "fixture".into(),
                version: "0.0.0".into(),
                role: role.to_owned(),
            },
            capabilities: Map::new(),
            limits,
        })
    }

    #[test]
    fn accepts_the_method_grammar() {
        for name in [
            "a.b",
            "fs.read-file",
            "runtime.update.begin-transfer",
            "a--b.c9",
            "rpc.discover",
            "a1.b2.c3",
        ] {
            assert!(is_valid_method_name(name), "{name} should be valid");
        }
    }

    #[test]
    fn refuses_names_outside_the_method_grammar() {
        for name in [
            "", "fs", "Fs.read", "fs..read", "fs.read-", "1fs.read", "-a.b", "a.b-", "a.B", ".a.b",
            "a.b.", "a b.c", "a_b.c", "a.b ",
        ] {
            assert!(!is_valid_method_name(name), "{name:?} should be refused");
        }
    }

    #[test]
    fn refuses_a_method_name_over_the_length_ceiling() {
        let long = format!("a.{}", "b".repeat(MAX_NAME_CHARS));
        assert!(!is_valid_method_name(&long));
        let at_ceiling = format!("a.{}", "b".repeat(MAX_NAME_CHARS - 2));
        assert!(is_valid_method_name(&at_ceiling));
    }

    #[test]
    fn role_is_a_single_lowercase_segment() {
        assert!(is_valid_role("runtime"));
        assert!(is_valid_role("mango-hub"));
        assert!(!is_valid_role("Runtime"));
        assert!(!is_valid_role(""));
        assert!(!is_valid_role("hub-"));
        assert!(!is_valid_role(&"a".repeat(65)));
    }

    #[test]
    fn error_codes_are_screaming_snake_case() {
        assert!(is_valid_error_code("INTERNAL"));
        assert!(is_valid_error_code("SOME_FUTURE_CODE_2"));
        assert!(!is_valid_error_code("denied"));
        assert!(!is_valid_error_code(""));
        assert!(!is_valid_error_code("_LEADING"));
        assert!(!is_valid_error_code(&"A".repeat(65)));
        assert!(is_valid_error_code(&"A".repeat(64)));
    }

    #[test]
    fn an_empty_id_names_the_field_and_the_expected_shape() {
        let error = validate(&request("", "a.b")).expect_err("empty id is refused");
        assert_eq!(error.field, "req.id");
        assert_eq!(error.received, "\"\"");
        assert!(error.expected.contains("1 to 256"), "{error}");
    }

    #[test]
    fn an_id_over_the_ceiling_is_refused_and_the_ceiling_itself_is_not() {
        assert!(validate(&request(&"i".repeat(MAX_ID_CHARS), "a.b")).is_ok());
        let error = validate(&request(&"i".repeat(MAX_ID_CHARS + 1), "a.b"))
            .expect_err("257 characters is refused");
        assert!(error.received.contains("257 characters"), "{error}");
    }

    #[test]
    fn a_reserved_method_is_schema_valid_but_flagged_reserved() {
        assert!(is_valid_method_name("rpc.discover"));
        assert!(is_reserved_method_name("rpc.discover"));
        assert!(!is_reserved_method_name("fs.read-file"));
    }

    #[test]
    fn a_bad_method_names_the_grammar() {
        let error = validate(&request("r", "fs")).expect_err("one segment is refused");
        assert_eq!(error.field, "req.method");
        assert!(error.expected.contains("two dot-separated"), "{error}");
    }

    #[test]
    fn hello_refuses_a_major_below_one() {
        let mut frame = hello_with("tool", None);
        if let Frame::Hello(hello) = &mut frame {
            hello.protocol.major = 0;
        }
        let error = validate(&frame).expect_err("major 0 is refused");
        assert_eq!(error.field, "hello.protocol.major");
    }

    #[test]
    fn hello_refuses_an_uppercase_role() {
        let error = validate(&hello_with("Runtime", None)).expect_err("uppercase role is refused");
        assert_eq!(error.field, "hello.peer.role");
    }

    #[test]
    fn hello_refuses_a_frame_ceiling_below_the_floor() {
        let limits = Limits {
            max_frame_bytes: Some(4095),
            max_in_flight: None,
        };
        let error = validate(&hello_with("tool", Some(limits))).expect_err("4095 is refused");
        assert_eq!(error.field, "hello.limits.maxFrameBytes");
        assert_eq!(error.received, "4095");
        assert!(
            validate(&hello_with(
                "tool",
                Some(Limits {
                    max_frame_bytes: Some(4096),
                    max_in_flight: None,
                })
            ))
            .is_ok()
        );
    }

    #[test]
    fn hello_refuses_an_in_flight_ceiling_of_zero() {
        let limits = Limits {
            max_frame_bytes: None,
            max_in_flight: Some(0),
        };
        let error = validate(&hello_with("tool", Some(limits))).expect_err("0 is refused");
        assert_eq!(error.field, "hello.limits.maxInFlight");
        assert_eq!(error.received, "0");
        // Absent is the default, not a zero, and 1 is the floor a peer may say.
        assert!(
            validate(&hello_with(
                "tool",
                Some(Limits {
                    max_frame_bytes: None,
                    max_in_flight: Some(1),
                })
            ))
            .is_ok()
        );
    }

    #[test]
    fn err_refuses_a_lowercase_code_and_an_empty_message() {
        let lowercase = Frame::Err(ErrorResponse {
            id: "r".into(),
            error: ErrorPayload {
                code: "denied".into(),
                message: "x".into(),
                details: None,
            },
        });
        assert_eq!(
            validate(&lowercase).expect_err("lowercase code").field,
            "err.error.code"
        );
        let empty = Frame::Err(ErrorResponse {
            id: "r".into(),
            error: ErrorPayload {
                code: "INTERNAL".into(),
                message: String::new(),
                details: None,
            },
        });
        assert_eq!(
            validate(&empty).expect_err("empty message").field,
            "err.error.message"
        );
    }

    #[test]
    fn evt_refuses_a_bad_topic_and_an_empty_stream_id() {
        let bad_topic = Frame::Evt(Event {
            topic: "Topic".into(),
            seq: 0,
            stream_id: None,
            payload: Value::Null,
            end: None,
        });
        assert_eq!(
            validate(&bad_topic).expect_err("bad topic").field,
            "evt.topic"
        );
        let empty_stream = Frame::Evt(Event {
            topic: "a.b".into(),
            seq: 0,
            stream_id: Some(String::new()),
            payload: Value::Null,
            end: None,
        });
        assert_eq!(
            validate(&empty_stream).expect_err("empty streamId").field,
            "evt.streamId"
        );
    }

    #[test]
    fn close_bounds_the_code_and_the_reason() {
        for code in [3999, 5000] {
            let frame = Frame::Close(Close { code, reason: None });
            assert_eq!(
                validate(&frame).expect_err("out of range").field,
                "close.code"
            );
        }
        for code in [4000, 4999, 4777] {
            assert!(validate(&Frame::Close(Close { code, reason: None })).is_ok());
        }
        let long = Frame::Close(Close {
            code: 4000,
            reason: Some("r".repeat(1025)),
        });
        assert_eq!(
            validate(&long).expect_err("long reason").field,
            "close.reason"
        );
    }

    #[test]
    fn liveness_frames_have_nothing_to_validate() {
        assert!(validate(&Frame::Ping).is_ok());
        assert!(validate(&Frame::Pong).is_ok());
        assert!(validate(&Frame::Cancel(Cancel { id: "r".into() })).is_ok());
    }
}
