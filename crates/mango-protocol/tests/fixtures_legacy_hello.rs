//! `spec/fixtures/1/legacy-hello.json` run against this crate's decoders.
//!
//! A runtime built on `runtime-protocol` 1.0.1 is still on somebody's machine,
//! and what it says on connecting is not a Mango Protocol 1 frame. The rule
//! that matters is which close code that refusal maps to: `4426`, the one a
//! dialler reads as "this peer speaks a wire I cannot", not the generic
//! `4400`.

use mango_protocol::close::{close_code_for_codec_error, close_codes};
use mango_protocol::codec::chunk::{ChunkReassembler, DEFAULT_MAX_MESSAGE_BYTES};
use mango_protocol::codec::ndjson::{DEFAULT_MAX_FRAME_BYTES, LineDecoder, decode_line};
use mango_protocol::error::CodecErrorKind;
use serde_json::Value;

const CORPUS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../spec/fixtures/1/legacy-hello.json"
));

/// One case: the record, the same frame as chunk messages, and the code the
/// refusal must map to.
struct Case {
    name: String,
    line: String,
    chunks: Vec<Vec<u8>>,
    close_code: u16,
}

fn cases() -> Vec<Case> {
    let document: Value = serde_json::from_str(CORPUS).expect("legacy-hello.json is valid JSON");
    let cases = document["cases"].as_array().expect("a cases array");
    assert!(!cases.is_empty(), "expected at least one case");
    cases
        .iter()
        .map(|case| Case {
            name: case["name"].as_str().expect("a name").to_owned(),
            line: case["line"].as_str().expect("a line").to_owned(),
            chunks: case["chunks"]
                .as_array()
                .expect("a chunks array")
                .iter()
                .map(|message| decode_base64(message.as_str().expect("base64 text")))
                .collect(),
            close_code: u16::try_from(case["closeCode"].as_u64().expect("a close code"))
                .expect("a close code in range"),
        })
        .collect()
}

/// The corpus spells binary messages in base64, as `chunks.json` does. Decoded
/// here rather than through a dependency the crate does not otherwise need.
fn decode_base64(text: &str) -> Vec<u8> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut bytes = Vec::new();
    let mut accumulator: u32 = 0;
    let mut bits = 0_u32;
    for character in text.bytes().filter(|byte| *byte != b'=') {
        let value = ALPHABET
            .iter()
            .position(|candidate| *candidate == character)
            .unwrap_or_else(|| panic!("{} is not base64", character as char));
        accumulator = (accumulator << 6) | u32::try_from(value).expect("six bits");
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push(u8::try_from((accumulator >> bits) & 0xFF).expect("one byte"));
        }
    }
    bytes
}

#[test]
fn the_legacy_hello_is_refused_as_a_hello_nobody_can_read() {
    for case in cases() {
        let error = decode_line(case.line.as_bytes(), DEFAULT_MAX_FRAME_BYTES).expect_err(
            &format!("{}: a 1.0.1 hello is not a wire 1 frame", case.name),
        );
        assert_eq!(error.kind, CodecErrorKind::Schema, "{}", case.name);
        assert_eq!(
            close_code_for_codec_error(&error),
            case.close_code,
            "{}: a hello nobody can read closes with 4426, not 4400",
            case.name
        );
        assert_eq!(case.close_code, close_codes::PROTOCOL_MISMATCH);
    }
}

#[test]
fn the_stdio_decoder_refuses_the_record_it_arrives_as() {
    for case in cases() {
        let mut decoder = LineDecoder::new(DEFAULT_MAX_FRAME_BYTES);
        let outcome = decoder.push(format!("{}\n", case.line).as_bytes());
        assert!(outcome.frames.is_empty(), "{}", case.name);
        let error = outcome
            .error
            .unwrap_or_else(|| panic!("{}: the stream decoder refuses it too", case.name));
        assert_eq!(close_code_for_codec_error(&error), case.close_code);
    }
}

#[test]
fn the_websocket_reassembler_refuses_the_messages_it_arrives_as() {
    for case in cases() {
        let mut reassembler =
            ChunkReassembler::new(DEFAULT_MAX_MESSAGE_BYTES, DEFAULT_MAX_FRAME_BYTES);
        let mut refusal = None;
        for message in &case.chunks {
            match reassembler.push(message) {
                Ok(Some(frame)) => panic!("{}: decoded {frame:?}, expected a refusal", case.name),
                Ok(None) => {}
                Err(error) => {
                    refusal = Some(error);
                    break;
                }
            }
        }
        let error =
            refusal.unwrap_or_else(|| panic!("{}: the chunk path refuses it too", case.name));
        assert_eq!(close_code_for_codec_error(&error), case.close_code);
    }
}
