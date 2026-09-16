//! Shared fuzz-input generator: builds a [`Frame`] straight from structured
//! `arbitrary` input rather than raw bytes.
//!
//! Feeding raw fuzzer bytes to `serde_json::from_slice::<Frame>` almost never
//! produces `Ok`, which starves any target that wants to exercise
//! [`mango_protocol::validate`] or a [`mango_protocol::session::Session`]
//! past its decoder. [`Script`] instead derives [`arbitrary::Arbitrary`]
//! directly over a frame's fields, so the fuzzer spends its budget varying
//! the shapes those consumers actually branch on, and a small shared pool of
//! ids and method names makes a `res`, `err` or `cancel` collide with an
//! earlier `req`'s id on purpose — the case a session's dispatch logic has to
//! get right.
//!
//! The `validate` and `session_frames` fuzz targets both use it.

use arbitrary::Arbitrary;
use mango_protocol::{
    Cancel, Close, End, ErrorPayload, ErrorResponse, Event, Frame, Hello, Limits, PeerInfo,
    ProtocolVersion, Request, Response,
};
use serde_json::{Map, Value};

const IDS: [&str; 4] = ["", "r-0", "r-1", "a-very-long-request-identifier-indeed"];
const METHODS: [&str; 4] = ["a.b", "rpc.discover", "fs.read-file", "x"];
const ROLES: [&str; 3] = ["", "tool", "Bad-Role"];
const CODES: [&str; 4] = ["", "DENIED", "denied", "APP_2"];

/// Picks one entry of a non-empty pool by index, wrapping rather than
/// panicking: every `u8` the fuzzer hands in is a valid choice.
///
/// # Example
///
/// ```
/// use mango_protocol_fuzz::pick;
///
/// assert_eq!(pick(&["a", "b"], 3), "b");
/// ```
#[must_use]
pub fn pick<'a>(pool: &[&'a str], index: u8) -> &'a str {
    pool[index as usize % pool.len()]
}

/// A small JSON value keyed off one byte, standing in for `params`, `result`
/// and `payload`.
fn small_json(seed: u8) -> Value {
    match seed % 5 {
        0 => Value::Null,
        1 => Value::Bool(seed.is_multiple_of(2)),
        2 => Value::Number(i64::from(seed).into()),
        3 => Value::String(format!("v{seed}")),
        _ => {
            let mut object = Map::new();
            object.insert("k".into(), Value::String("v".into()));
            Value::Object(object)
        }
    }
}

/// One frame, described structurally so `arbitrary` varies its members
/// instead of its bytes.
///
/// Deliberately produces schema-invalid frames sometimes (an empty id, an
/// uppercase role): those are exactly the inputs [`Script::into_frame`]'s
/// consumers must refuse rather than panic on.
///
/// # Example
///
/// ```
/// use mango_protocol::Frame;
/// use mango_protocol_fuzz::Script;
///
/// let script = Script::Ping;
/// assert_eq!(script.into_frame(), Frame::Ping);
/// ```
#[derive(Debug, Arbitrary)]
pub enum Script {
    /// Builds a [`Frame::Hello`].
    Hello {
        /// `hello.protocol.minor`.
        minor: u8,
        /// Index into a small pool of peer names.
        name_idx: u8,
        /// Index into a small pool of roles, some invalid on purpose.
        role_idx: u8,
        /// `hello.limits.maxFrameBytes`, when present.
        limit: Option<u16>,
        /// `hello.limits.maxInFlight`, when present. `Some(0)` is below the
        /// floor of §11.2 on purpose: that is the branch `validate` refuses.
        in_flight: Option<u16>,
    },
    /// Builds a [`Frame::Req`].
    Req {
        /// Index into a small pool of ids, reused across variants.
        id_idx: u8,
        /// Index into a small pool of method names.
        method_idx: u8,
        /// Seed for the request's `params`.
        payload: u8,
    },
    /// Builds a [`Frame::Res`].
    Res {
        /// Index into a small pool of ids, reused across variants.
        id_idx: u8,
        /// Seed for the response's `result`.
        payload: u8,
    },
    /// Builds a [`Frame::Err`].
    Err {
        /// Index into a small pool of ids, reused across variants.
        id_idx: u8,
        /// Index into a small pool of error codes, some invalid on purpose.
        code_idx: u8,
    },
    /// Builds a [`Frame::Evt`].
    Evt {
        /// Index into a small pool of topics.
        method_idx: u8,
        /// The event's `seq`.
        seq: u8,
        /// Index into a small pool of ids, when the event carries a `streamId`.
        stream_idx: Option<u8>,
        /// Whether the event carries `end: true`.
        end: bool,
        /// Seed for the event's `payload`.
        payload: u8,
    },
    /// Builds a [`Frame::Cancel`].
    Cancel {
        /// Index into a small pool of ids, reused across variants.
        id_idx: u8,
    },
    /// Builds [`Frame::Ping`].
    Ping,
    /// Builds [`Frame::Pong`].
    Pong,
    /// Builds a [`Frame::Close`].
    Close {
        /// `close.code`.
        code: u16,
        /// Index into a small pool of ids, reused as the close reason.
        reason_idx: Option<u8>,
    },
}

impl Script {
    /// Builds the [`Frame`] this script step describes.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::Frame;
    /// use mango_protocol_fuzz::Script;
    ///
    /// let frame = Script::Cancel { id_idx: 1 }.into_frame();
    /// assert!(matches!(frame, Frame::Cancel(_)));
    /// ```
    #[must_use]
    pub fn into_frame(self) -> Frame {
        match self {
            Self::Hello {
                minor,
                name_idx,
                role_idx,
                limit,
                in_flight,
            } => Frame::Hello(Hello {
                protocol: ProtocolVersion::new(1, u32::from(minor)),
                peer: PeerInfo {
                    name: pick(&IDS, name_idx).to_owned(),
                    version: "0.0.0".into(),
                    role: pick(&ROLES, role_idx).to_owned(),
                },
                capabilities: Map::new(),
                // Present when either ceiling is, so `maxInFlight` can be
                // announced on its own the way the wire allows it to be.
                limits: (limit.is_some() || in_flight.is_some()).then(|| Limits {
                    max_frame_bytes: limit.map(u64::from),
                    max_in_flight: in_flight.map(u64::from),
                }),
            }),
            Self::Req {
                id_idx,
                method_idx,
                payload,
            } => Frame::Req(Request {
                id: pick(&IDS, id_idx).to_owned(),
                method: pick(&METHODS, method_idx).to_owned(),
                params: small_json(payload),
            }),
            Self::Res { id_idx, payload } => Frame::Res(Response {
                id: pick(&IDS, id_idx).to_owned(),
                result: small_json(payload),
            }),
            Self::Err { id_idx, code_idx } => Frame::Err(ErrorResponse {
                id: pick(&IDS, id_idx).to_owned(),
                error: ErrorPayload {
                    code: pick(&CODES, code_idx).to_owned(),
                    message: "m".into(),
                    details: None,
                },
            }),
            Self::Evt {
                method_idx,
                seq,
                stream_idx,
                end,
                payload,
            } => Frame::Evt(Event {
                topic: pick(&METHODS, method_idx).to_owned(),
                seq: u64::from(seq),
                stream_id: stream_idx.map(|idx| pick(&IDS, idx).to_owned()),
                payload: small_json(payload),
                end: end.then_some(End),
            }),
            Self::Cancel { id_idx } => Frame::Cancel(Cancel {
                id: pick(&IDS, id_idx).to_owned(),
            }),
            Self::Ping => Frame::Ping,
            Self::Pong => Frame::Pong,
            Self::Close { code, reason_idx } => Frame::Close(Close {
                code,
                reason: reason_idx.map(|idx| pick(&IDS, idx).to_owned()),
            }),
        }
    }
}
