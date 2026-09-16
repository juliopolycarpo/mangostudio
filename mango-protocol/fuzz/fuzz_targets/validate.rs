//! `mango_protocol::validate` over an arbitrary [`Frame`]: must never panic.
//!
//! Most inputs come from [`Script`], which builds a `Frame` directly so the
//! fuzzer varies the fields `validate` actually branches on; raw JSON bytes
//! are kept as a second path; only such text is ever a `Frame` serde itself
//! never had to build.
#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use mango_protocol::validate;
use mango_protocol_fuzz::Script;

#[derive(Debug, Arbitrary)]
enum Input {
    Structured(Script),
    RawJson(Vec<u8>),
}

fuzz_target!(|input: Input| {
    let frame = match input {
        Input::Structured(script) => script.into_frame(),
        Input::RawJson(bytes) => match serde_json::from_slice(&bytes) {
            Ok(frame) => frame,
            Err(_) => return,
        },
    };
    let _ = validate(&frame);
});
