//! `ChunkReassembler::push` over an arbitrary sequence of WebSocket messages:
//! must never panic, and every refusal must leave the reassembler reset, per
//! its own documented contract ("every refusal resets the reassembler,
//! because a refusal is fatal on this transport").
#![no_main]

use libfuzzer_sys::fuzz_target;
use mango_protocol::codec::chunk::{ChunkReassembler, DEFAULT_MAX_MESSAGE_BYTES};
use mango_protocol::codec::ndjson::DEFAULT_MAX_FRAME_BYTES;

fuzz_target!(|messages: Vec<Vec<u8>>| {
    let mut reassembler = ChunkReassembler::new(DEFAULT_MAX_MESSAGE_BYTES, DEFAULT_MAX_FRAME_BYTES);
    for message in &messages {
        if reassembler.push(message).is_err() {
            assert!(
                !reassembler.is_reassembling(),
                "a refusal must reset the reassembler"
            );
        }
    }
});
