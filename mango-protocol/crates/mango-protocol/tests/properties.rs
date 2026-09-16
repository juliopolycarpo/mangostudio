//! Property-based round trips proving the codec and negotiation rules hold
//! for more than the fixture corpus's fixed cases.
//!
//! Every [`Frame`] the strategies below produce is schema-valid by
//! construction (grammar, length and range rules baked into the generators
//! rather than filtered after the fact), so [`encode_line`] never refuses
//! one; a refusal here is itself a property failure, not a generator bug.

use mango_protocol::codec::chunk::{
    CHUNK_HEADER_BYTES, ChunkReassembler, DEFAULT_MAX_MESSAGE_BYTES, MIN_MAX_MESSAGE_BYTES,
    MIN_NONFINAL_PAYLOAD_BYTES, encode_chunks,
};
use mango_protocol::codec::ndjson::{
    DEFAULT_MAX_FRAME_BYTES, decode_line, encode_frame_bytes, encode_line,
};
use mango_protocol::frame::{
    Cancel, Close, End, ErrorPayload, ErrorResponse, Event, Frame, Hello, Limits, PeerInfo,
    Request, Response,
};
use mango_protocol::{Negotiation, ProtocolVersion, close_codes, negotiate};
use proptest::prelude::*;
use serde_json::{Map, Value};

/// A lowercase-letter-first, dash-and-alnum body segment: the grammar shared
/// by a method/topic segment (§6.1) and a `peer.role` label, at a caller-given
/// length.
fn segment(len: std::ops::RangeInclusive<usize>) -> impl Strategy<Value = String> {
    let lower = b'a'..=b'z';
    let alnum: Vec<u8> = (b'a'..=b'z').chain(b'0'..=b'9').collect();
    let body: Vec<u8> = (b'a'..=b'z')
        .chain(b'0'..=b'9')
        .chain(std::iter::once(b'-'))
        .collect();
    len.prop_flat_map(move |length| {
        if length == 1 {
            prop::sample::select(lower.clone().collect::<Vec<u8>>())
                .prop_map(|c| (c as char).to_string())
                .boxed()
        } else {
            let first = prop::sample::select(lower.clone().collect::<Vec<u8>>());
            let last = prop::sample::select(alnum.clone());
            let middle = proptest::collection::vec(prop::sample::select(body.clone()), length - 2);
            (first, middle, last)
                .prop_map(|(first, middle, last)| {
                    let mut segment = String::with_capacity(middle.len() + 2);
                    segment.push(first as char);
                    segment.extend(middle.into_iter().map(|byte| byte as char));
                    segment.push(last as char);
                    segment
                })
                .boxed()
        }
    })
}

/// A `method` or `topic`: 2 to 4 segments joined by `.`, well under the
/// 128-character ceiling.
fn method_name() -> impl Strategy<Value = String> {
    proptest::collection::vec(segment(1..=8), 2..=4).prop_map(|segments| segments.join("."))
}

/// A `peer.role`: one segment, 1 to 16 characters.
fn role() -> impl Strategy<Value = String> {
    segment(1..=16)
}

/// An `error.code`: `^[A-Z][A-Z0-9_]*$`, 1 to 32 characters.
fn error_code() -> impl Strategy<Value = String> {
    let first = prop::sample::select((b'A'..=b'Z').collect::<Vec<u8>>());
    let rest_charset: Vec<u8> = (b'A'..=b'Z')
        .chain(b'0'..=b'9')
        .chain(std::iter::once(b'_'))
        .collect();
    (
        first,
        proptest::collection::vec(prop::sample::select(rest_charset), 0..31),
    )
        .prop_map(|(first, rest)| {
            let mut code = String::with_capacity(rest.len() + 1);
            code.push(first as char);
            code.extend(rest.into_iter().map(|byte| byte as char));
            code
        })
}

/// Any short string, unconstrained beyond a character count: covers `id`,
/// `streamId`, `peer.name`, `peer.version`, `err.error.message` and
/// `close.reason`, which the schema bounds only by length.
fn short_string(len: std::ops::RangeInclusive<usize>) -> impl Strategy<Value = String> {
    proptest::collection::vec(any::<char>(), len).prop_map(|chars| chars.into_iter().collect())
}

/// A bounded JSON value: `params`, `result`, `payload` and `capabilities` may
/// be anything the wire can carry, but a fuzz-scale property test does not
/// need arbitrary depth to catch a codec bug.
fn json_value() -> impl Strategy<Value = Value> {
    let leaf = prop_oneof![
        Just(Value::Null),
        any::<bool>().prop_map(Value::Bool),
        any::<i32>().prop_map(|n| Value::Number(n.into())),
        short_string(0..=8).prop_map(Value::String),
    ];
    leaf.prop_recursive(3, 16, 4, |inner| {
        prop_oneof![
            proptest::collection::vec(inner.clone(), 0..4).prop_map(Value::Array),
            proptest::collection::vec((short_string(0..=6), inner), 0..4).prop_map(|entries| {
                let mut object = Map::new();
                for (key, value) in entries {
                    object.insert(key, value);
                }
                Value::Object(object)
            }),
        ]
    })
}

/// An open JSON object: `hello.capabilities` and `err.error.details`.
fn json_object() -> impl Strategy<Value = Map<String, Value>> {
    proptest::collection::vec((short_string(0..=6), json_value()), 0..3).prop_map(|entries| {
        let mut object = Map::new();
        for (key, value) in entries {
            object.insert(key, value);
        }
        object
    })
}

fn hello_frame() -> impl Strategy<Value = Frame> {
    (
        1u32..=5,
        0u32..=20,
        short_string(1..=16),
        short_string(1..=16),
        role(),
        json_object(),
        prop::option::of(4096u64..=1_000_000u64),
        prop::option::of(1u64..=100_000u64),
    )
        .prop_map(
            |(major, minor, name, version, role, capabilities, max_frame_bytes, max_in_flight)| {
                // Absent when neither ceiling is announced: `limits: {}` is
                // schema-valid but says nothing, and a generator that emitted
                // it would stop covering the absent case.
                let limits =
                    (max_frame_bytes.is_some() || max_in_flight.is_some()).then_some(Limits {
                        max_frame_bytes,
                        max_in_flight,
                    });
                Frame::Hello(Hello {
                    protocol: ProtocolVersion::new(major, minor),
                    peer: PeerInfo {
                        name,
                        version,
                        role,
                    },
                    capabilities,
                    limits,
                })
            },
        )
}

fn req_frame() -> impl Strategy<Value = Frame> {
    (short_string(1..=32), method_name(), json_value())
        .prop_map(|(id, method, params)| Frame::Req(Request { id, method, params }))
}

fn res_frame() -> impl Strategy<Value = Frame> {
    (short_string(1..=32), json_value())
        .prop_map(|(id, result)| Frame::Res(Response { id, result }))
}

fn err_frame() -> impl Strategy<Value = Frame> {
    (
        short_string(1..=32),
        error_code(),
        short_string(1..=16),
        prop::option::of(json_object()),
    )
        .prop_map(|(id, code, message, details)| {
            Frame::Err(ErrorResponse {
                id,
                error: ErrorPayload {
                    code,
                    message,
                    details,
                },
            })
        })
}

fn evt_frame() -> impl Strategy<Value = Frame> {
    (
        method_name(),
        0u64..=1000,
        prop::option::of(short_string(1..=32)),
        json_value(),
        any::<bool>(),
    )
        .prop_map(|(topic, seq, stream_id, payload, end)| {
            Frame::Evt(Event {
                topic,
                seq,
                stream_id,
                payload,
                end: end.then_some(End),
            })
        })
}

fn cancel_frame() -> impl Strategy<Value = Frame> {
    short_string(1..=32).prop_map(|id| Frame::Cancel(Cancel { id }))
}

fn close_frame() -> impl Strategy<Value = Frame> {
    (4000u16..=4999u16, prop::option::of(short_string(0..=32)))
        .prop_map(|(code, reason)| Frame::Close(Close { code, reason }))
}

/// One of the eight frame types, always schema-valid.
fn any_frame() -> impl Strategy<Value = Frame> {
    prop_oneof![
        hello_frame(),
        req_frame(),
        res_frame(),
        err_frame(),
        evt_frame(),
        cancel_frame(),
        Just(Frame::Ping),
        Just(Frame::Pong),
        close_frame(),
    ]
}

/// A message cap the chunk framing allows: the floor, a few values above it,
/// and the reference default.
fn message_cap() -> impl Strategy<Value = usize> {
    prop_oneof![
        Just(MIN_MAX_MESSAGE_BYTES),
        (MIN_MAX_MESSAGE_BYTES..=65536),
        Just(DEFAULT_MAX_MESSAGE_BYTES)
    ]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    /// `decode_line(encode_line(f)) == f` for an arbitrary schema-valid frame.
    #[test]
    fn decode_line_undoes_encode_line(frame in any_frame()) {
        let line = encode_line(&frame, DEFAULT_MAX_FRAME_BYTES).expect("a schema-valid frame encodes");
        prop_assert_eq!(line.last(), Some(&b'\n'));
        let decoded = decode_line(&line[..line.len() - 1], DEFAULT_MAX_FRAME_BYTES)
            .expect("the encoder's own output always decodes");
        prop_assert_eq!(decoded, frame);
    }

    /// `reassemble(encode_chunks(frame, cap)) == frame` for every allowed message cap.
    #[test]
    fn chunk_round_trip_holds_at_every_allowed_cap(frame in any_frame(), cap in message_cap()) {
        let messages = encode_chunks(&frame, cap, DEFAULT_MAX_FRAME_BYTES).expect("encodes");
        let mut reassembler = ChunkReassembler::new(cap, DEFAULT_MAX_FRAME_BYTES);
        let last = messages.len() - 1;
        let mut decoded = None;
        for (index, message) in messages.iter().enumerate() {
            let outcome = reassembler.push(message).expect("every chunk of its own encoding is accepted");
            if index == last {
                prop_assert_eq!(outcome.clone(), Some(frame.clone()));
            } else {
                prop_assert_eq!(outcome.clone(), None);
            }
            decoded = outcome;
        }
        prop_assert_eq!(decoded, Some(frame));
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    /// Negotiation agrees on the effective minor (or the mismatch) no matter
    /// which side is "local" and which is "remote".
    #[test]
    fn negotiation_is_symmetric(
        a_major in 0u32..=4,
        a_minor in 0u32..=10,
        b_major in 0u32..=4,
        b_minor in 0u32..=10,
    ) {
        let a = ProtocolVersion::new(a_major, a_minor);
        let b = ProtocolVersion::new(b_major, b_minor);
        prop_assert_eq!(negotiate(a, b), negotiate(b, a));
        match negotiate(a, b) {
            Negotiation::Compatible { effective_minor } => {
                prop_assert_eq!(a_major, b_major);
                prop_assert_eq!(effective_minor, a_minor.min(b_minor));
            }
            Negotiation::Mismatch { close_code } => {
                prop_assert_ne!(a_major, b_major);
                prop_assert_eq!(close_code, close_codes::PROTOCOL_MISMATCH);
            }
        }
    }
}

/// The chunk framing's one hard threshold: a non-final chunk's payload must
/// be at least [`MIN_NONFINAL_PAYLOAD_BYTES`]. `encode_chunks` always fills
/// non-final chunks to capacity, so hitting the boundary on the *last* chunk
/// — which carries no such minimum — needs a hand-sized payload rather than
/// arbitrary generation.
#[test]
fn reassembles_when_the_final_chunk_lands_on_the_minimum_payload_boundary() {
    let cap = MIN_MAX_MESSAGE_BYTES;
    let capacity = cap - CHUNK_HEADER_BYTES;
    let empty = Frame::Req(Request {
        id: "r".into(),
        method: "a.b".into(),
        params: Value::String(String::new()),
    });
    let overhead = encode_frame_bytes(&empty, DEFAULT_MAX_FRAME_BYTES)
        .expect("encodes")
        .len();

    for final_len in [
        MIN_NONFINAL_PAYLOAD_BYTES - 1,
        MIN_NONFINAL_PAYLOAD_BYTES,
        MIN_NONFINAL_PAYLOAD_BYTES + 1,
    ] {
        let total = capacity + final_len;
        let blob_len = total - overhead;
        let frame = Frame::Req(Request {
            id: "r".into(),
            method: "a.b".into(),
            params: Value::String("x".repeat(blob_len)),
        });

        let messages = encode_chunks(&frame, cap, DEFAULT_MAX_FRAME_BYTES).expect("encodes");
        assert_eq!(messages.len(), 2, "final_len {final_len}");
        assert_eq!(messages[0].len(), cap, "final_len {final_len}");
        assert_eq!(
            messages[1].len(),
            CHUNK_HEADER_BYTES + final_len,
            "final_len {final_len}"
        );

        let mut reassembler = ChunkReassembler::new(cap, DEFAULT_MAX_FRAME_BYTES);
        assert_eq!(reassembler.push(&messages[0]).expect("first chunk"), None);
        assert_eq!(
            reassembler.push(&messages[1]).expect("final chunk"),
            Some(frame),
            "final_len {final_len}"
        );
    }
}
