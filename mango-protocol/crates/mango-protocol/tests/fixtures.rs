//! The conformance corpus of `spec/fixtures/1/`, run against this crate.
//!
//! Both SDKs read these files, so a disagreement between the TypeScript and the
//! Rust half shows up here rather than on a wire. Every `accept` case must
//! decode and re-encode to a value the fixture's `expected` is a subset of,
//! every `reject` case must be refused with the kind the fixture's `reason`
//! names, and an `implementation-defined` case must not panic.

use mango_protocol::codec::chunk::{ChunkReassembler, DEFAULT_MAX_MESSAGE_BYTES, encode_chunks};
use mango_protocol::codec::ndjson::{DEFAULT_MAX_FRAME_BYTES, LineDecoder, decode_line};
use mango_protocol::error::CodecErrorKind;
use mango_protocol::frame::Frame;
use mango_protocol::version::{Negotiation, ProtocolVersion, negotiate};
use serde_json::Value;

/// Reads one corpus file relative to this crate.
macro_rules! corpus {
    ($file:literal) => {
        serde_json::from_str::<Value>(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../spec/fixtures/1/",
            $file
        )))
        .expect(concat!($file, " is valid JSON"))
    };
}

/// The `cases` array of a corpus file, refusing an empty corpus.
fn cases(document: &Value, file: &str) -> Vec<Value> {
    let list = document["cases"]
        .as_array()
        .unwrap_or_else(|| panic!("{file}: expected a cases array"))
        .clone();
    assert!(!list.is_empty(), "{file}: expected at least one case");
    list
}

fn text(case: &Value, member: &str) -> String {
    case[member]
        .as_str()
        .unwrap_or_else(|| panic!("case {case} has no string {member}"))
        .to_owned()
}

fn name(case: &Value) -> String {
    text(case, "name")
}

fn usize_member(case: &Value, member: &str, fallback: usize) -> usize {
    match case.get(member).and_then(Value::as_u64) {
        Some(value) => usize::try_from(value).expect("a usize"),
        None => fallback,
    }
}

/// Maps a corpus `reason` onto the codec kind it must produce.
fn kind_for(reason: &str) -> Option<CodecErrorKind> {
    match reason {
        "invalid-json" => Some(CodecErrorKind::InvalidJson),
        "schema" => Some(CodecErrorKind::Schema),
        "too-large" => Some(CodecErrorKind::TooLarge),
        "chunk-version" => Some(CodecErrorKind::ChunkVersion),
        "chunk-header" => Some(CodecErrorKind::ChunkHeader),
        "chunk-count" => Some(CodecErrorKind::ChunkCount),
        "chunk-index" => Some(CodecErrorKind::ChunkIndex),
        "chunk-dribble" => Some(CodecErrorKind::ChunkDribble),
        _ => None,
    }
}

/// Recursive subset match: every member of `expected` equals the actual member.
///
/// Extra members are allowed on objects, because `expected` lists known members
/// only and a decoder ignores the rest.
fn is_subset(expected: &Value, actual: &Value) -> bool {
    match expected {
        Value::Array(items) => actual.as_array().is_some_and(|other| {
            items.len() == other.len()
                && items
                    .iter()
                    .zip(other)
                    .all(|(item, value)| is_subset(item, value))
        }),
        Value::Object(members) => actual.as_object().is_some_and(|other| {
            members.iter().all(|(key, value)| {
                other
                    .get(key)
                    .is_some_and(|actual| is_subset(value, actual))
            })
        }),
        _ => expected == actual,
    }
}

/// Asserts that a decoded frame re-encodes to a value `expected` is a subset of.
fn assert_expected(case: &str, expected: &Value, frame: &Frame) {
    let actual = serde_json::to_value(frame).expect("a frame serialises");
    assert!(
        is_subset(expected, &actual),
        "{case}: expected {expected} is not a subset of {actual}"
    );
}

/// The sextet a base64 character stands for.
fn sextet(byte: u8) -> Option<u32> {
    match byte {
        b'A'..=b'Z' => Some(u32::from(byte - b'A')),
        b'a'..=b'z' => Some(u32::from(byte - b'a') + 26),
        b'0'..=b'9' => Some(u32::from(byte - b'0') + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// Decodes standard base64, so the corpus needs no dependency of its own.
fn decode_base64(text: &str) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(text.len() / 4 * 3);
    let mut accumulator = 0_u32;
    let mut bits = 0_u32;
    for byte in text.bytes() {
        if byte == b'=' {
            continue;
        }
        let value = sextet(byte)
            .unwrap_or_else(|| panic!("received {byte:?}, expected a standard base64 character"));
        accumulator = (accumulator << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push(u8::try_from((accumulator >> bits) & 0xFF).expect("one byte"));
        }
    }
    bytes
}

#[test]
fn base64_decoding_matches_a_known_vector() {
    assert_eq!(decode_base64("eyJ0eXBlIjoicGluZyJ9"), br#"{"type":"ping"}"#);
    assert_eq!(decode_base64("AQAAAAA="), [1, 0, 0, 0, 0]);
    assert_eq!(decode_base64(""), Vec::<u8>::new());
}

#[test]
fn the_subset_match_is_recursive_and_allows_extra_members() {
    let expected = serde_json::json!({ "a": { "b": 1 }, "c": [1, 2] });
    let actual = serde_json::json!({ "a": { "b": 1, "x": 9 }, "c": [1, 2], "d": 3 });
    assert!(is_subset(&expected, &actual));
    assert!(!is_subset(
        &expected,
        &serde_json::json!({ "a": { "b": 2 }, "c": [1, 2] })
    ));
    assert!(!is_subset(
        &expected,
        &serde_json::json!({ "a": { "b": 1 }, "c": [1] })
    ));
}

#[test]
fn every_frame_case_agrees_with_the_corpus() {
    let document = corpus!("frames.json");
    let list = cases(&document, "frames.json");
    for case in &list {
        let case_name = name(case);
        let line = text(case, "line");
        let outcome = decode_line(line.as_bytes(), DEFAULT_MAX_FRAME_BYTES);
        match text(case, "verdict").as_str() {
            "accept" => {
                let frame = outcome
                    .unwrap_or_else(|error| panic!("{case_name}: should decode but got {error}"));
                if let Some(expected) = case.get("expected") {
                    assert_expected(&case_name, expected, &frame);
                }
            }
            "reject" => {
                let error = outcome
                    .err()
                    .unwrap_or_else(|| panic!("{case_name}: should be refused but decoded"));
                if let Some(kind) = kind_for(&text(case, "reason")) {
                    assert_eq!(error.kind, kind, "{case_name}: {error}");
                }
            }
            "implementation-defined" => drop(outcome),
            other => panic!("{case_name}: unknown verdict {other}"),
        }
    }
}

/// Feeds the pieces to a decoder and reports the frames delivered before any refusal.
fn run_ndjson(
    pieces: &[String],
    max_frame_bytes: usize,
    finish: bool,
) -> (Vec<Frame>, Option<CodecErrorKind>) {
    let mut decoder = LineDecoder::new(max_frame_bytes);
    let mut frames = Vec::new();
    for piece in pieces {
        let outcome = decoder.push(piece.as_bytes());
        frames.extend(outcome.frames);
        if let Some(error) = outcome.error {
            return (frames, Some(error.kind));
        }
    }
    if finish {
        match decoder.finish() {
            Ok(flushed) => frames.extend(flushed),
            Err(error) => return (frames, Some(error.kind)),
        }
    }
    (frames, None)
}

#[test]
fn every_ndjson_case_agrees_with_the_corpus() {
    let document = corpus!("ndjson.json");
    let list = cases(&document, "ndjson.json");
    for case in &list {
        let case_name = name(case);
        let pieces: Vec<String> = case["pieces"]
            .as_array()
            .unwrap_or_else(|| panic!("{case_name}: expected pieces"))
            .iter()
            .map(|piece| piece.as_str().expect("a string piece").to_owned())
            .collect();
        let max_frame_bytes = usize_member(case, "maxFrameBytes", DEFAULT_MAX_FRAME_BYTES);
        let finish = case["finish"].as_bool().unwrap_or(false);
        let (frames, kind) = run_ndjson(&pieces, max_frame_bytes, finish);

        let expected = case
            .get("expected")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert_eq!(
            frames.len(),
            expected.len(),
            "{case_name}: delivered {} frames, expected {}",
            frames.len(),
            expected.len()
        );
        for (value, frame) in expected.iter().zip(&frames) {
            assert_expected(&case_name, value, frame);
        }

        match text(case, "verdict").as_str() {
            "accept" => assert_eq!(kind, None, "{case_name}: should not be refused"),
            "reject" => {
                let kind = kind.unwrap_or_else(|| panic!("{case_name}: should be refused"));
                if let Some(expected_kind) = kind_for(&text(case, "reason")) {
                    assert_eq!(kind, expected_kind, "{case_name}");
                }
            }
            other => panic!("{case_name}: unknown verdict {other}"),
        }
    }
}

#[test]
fn an_ndjson_accept_case_survives_a_byte_at_a_time_stream() {
    let document = corpus!("ndjson.json");
    let list = cases(&document, "ndjson.json");
    let mut checked = 0;
    for case in &list {
        if text(case, "verdict") != "accept" {
            continue;
        }
        let case_name = name(case);
        let joined: String = case["pieces"]
            .as_array()
            .expect("pieces")
            .iter()
            .map(|piece| piece.as_str().expect("a string piece"))
            .collect();
        let finish = case["finish"].as_bool().unwrap_or(false);
        let max_frame_bytes = usize_member(case, "maxFrameBytes", DEFAULT_MAX_FRAME_BYTES);
        let (frames, kind) = run_bytes(joined.as_bytes(), max_frame_bytes, finish);
        assert_eq!(
            kind, None,
            "{case_name}: a byte-at-a-time stream was refused"
        );
        let expected = case
            .get("expected")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert_eq!(frames.len(), expected.len(), "{case_name}");
        for (value, frame) in expected.iter().zip(&frames) {
            assert_expected(&case_name, value, frame);
        }
        checked += 1;
    }
    assert!(checked > 0, "expected at least one accept case to replay");
}

/// Feeds one byte per push, so a split inside a multi-byte sequence is exercised.
fn run_bytes(
    bytes: &[u8],
    max_frame_bytes: usize,
    finish: bool,
) -> (Vec<Frame>, Option<CodecErrorKind>) {
    let mut decoder = LineDecoder::new(max_frame_bytes);
    let mut frames = Vec::new();
    for byte in bytes {
        let outcome = decoder.push(std::slice::from_ref(byte));
        frames.extend(outcome.frames);
        if let Some(error) = outcome.error {
            return (frames, Some(error.kind));
        }
    }
    if finish {
        match decoder.finish() {
            Ok(flushed) => frames.extend(flushed),
            Err(error) => return (frames, Some(error.kind)),
        }
    }
    (frames, None)
}

#[test]
fn every_chunk_case_agrees_with_the_corpus() {
    let document = corpus!("chunks.json");
    let list = cases(&document, "chunks.json");
    let mut re_encoded = 0;
    for case in &list {
        let case_name = name(case);
        let messages: Vec<Vec<u8>> = case["messages"]
            .as_array()
            .unwrap_or_else(|| panic!("{case_name}: expected messages"))
            .iter()
            .map(|message| decode_base64(message.as_str().expect("a base64 string")))
            .collect();
        let max_message_bytes = usize_member(case, "maxMessageBytes", DEFAULT_MAX_MESSAGE_BYTES);
        let max_frame_bytes = usize_member(case, "maxFrameBytes", DEFAULT_MAX_FRAME_BYTES);
        let mut reassembler = ChunkReassembler::new(max_message_bytes, max_frame_bytes);

        let mut decoded = None;
        let mut refusal = None;
        for (index, message) in messages.iter().enumerate() {
            match reassembler.push(message) {
                Ok(None) => {}
                Ok(Some(frame)) => {
                    assert!(
                        decoded.is_none(),
                        "{case_name}: two frames from one corpus case"
                    );
                    decoded = Some((index, frame));
                }
                Err(error) => {
                    refusal = Some((index, error));
                    break;
                }
            }
        }

        match text(case, "verdict").as_str() {
            "accept" => {
                assert!(refusal.is_none(), "{case_name}: should not be refused");
                let (index, frame) = decoded
                    .unwrap_or_else(|| panic!("{case_name}: no frame came out of the chunks"));
                assert_eq!(
                    index,
                    messages.len() - 1,
                    "{case_name}: the last chunk completes"
                );
                if let Some(expected) = case.get("expected") {
                    assert_expected(&case_name, expected, &frame);
                }
                if assert_reference_chunking(
                    &case_name,
                    &frame,
                    &messages,
                    max_message_bytes,
                    max_frame_bytes,
                ) {
                    re_encoded += 1;
                }
            }
            "reject" => {
                let (index, error) =
                    refusal.unwrap_or_else(|| panic!("{case_name}: should be refused"));
                assert!(
                    decoded.is_none(),
                    "{case_name}: a frame came out before the refusal"
                );
                let expected_index = case
                    .get("refusedAt")
                    .and_then(Value::as_u64)
                    .map_or(messages.len() - 1, |at| at as usize);
                assert_eq!(
                    index, expected_index,
                    "{case_name}: refused at chunk {index}, expected chunk {expected_index}"
                );
                if let Some(kind) = kind_for(&text(case, "reason")) {
                    assert_eq!(error.kind, kind, "{case_name}: {error}");
                }
            }
            other => panic!("{case_name}: unknown verdict {other}"),
        }
    }
    assert!(
        re_encoded >= 3,
        "expected the reference chunking check to run, it ran {re_encoded} times"
    );
}

/// When the corpus messages were produced by the reference chunker — every
/// non-final message filled to capacity — this crate's encoder must reproduce
/// them byte for byte. Returns whether the case qualified.
fn assert_reference_chunking(
    case_name: &str,
    frame: &Frame,
    messages: &[Vec<u8>],
    max_message_bytes: usize,
    max_frame_bytes: usize,
) -> bool {
    let filled = messages[..messages.len() - 1]
        .iter()
        .all(|message| message.len() == max_message_bytes);
    if !filled {
        return false;
    }
    let encoded = encode_chunks(frame, max_message_bytes, max_frame_bytes)
        .unwrap_or_else(|error| panic!("{case_name}: should re-encode but got {error}"));
    assert_eq!(
        encoded, messages,
        "{case_name}: re-encoded chunks differ from the corpus"
    );
    true
}

#[test]
fn every_negotiation_case_agrees_with_the_corpus() {
    let document = corpus!("negotiation.json");
    let list = cases(&document, "negotiation.json");
    for case in &list {
        let case_name = name(case);
        let version = |member: &str| ProtocolVersion {
            major: u32::try_from(case[member]["major"].as_u64().expect("a major")).expect("u32"),
            minor: u32::try_from(case[member]["minor"].as_u64().expect("a minor")).expect("u32"),
        };
        let outcome = negotiate(version("local"), version("remote"));
        let expected = &case["expected"];
        if expected.get("mismatch").is_some() {
            let close_code =
                u16::try_from(expected["closeCode"].as_u64().expect("a close code")).expect("u16");
            assert_eq!(outcome, Negotiation::Mismatch { close_code }, "{case_name}");
            continue;
        }
        let effective_minor =
            u32::try_from(expected["effectiveMinor"].as_u64().expect("a minor")).expect("u32");
        assert_eq!(
            outcome,
            Negotiation::Compatible { effective_minor },
            "{case_name}"
        );
    }
}
