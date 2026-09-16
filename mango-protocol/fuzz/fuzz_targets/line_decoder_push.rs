//! `LineDecoder::push` fed the same bytes whole, and split at boundaries the
//! fuzzer chooses. The two must never panic, and must decode the same frames
//! (and, if one refuses, the same refusal kind) as each other — a decoder
//! that only works when a transport hands it whole lines is not one this
//! crate can ship.
#![no_main]

use libfuzzer_sys::fuzz_target;
use mango_protocol::codec::ndjson::{LineDecoder, MIN_MAX_FRAME_BYTES};
use mango_protocol::error::CodecErrorKind;
use mango_protocol::frame::Frame;

#[derive(Debug, arbitrary::Arbitrary)]
struct Input {
    /// Chooses the frame ceiling both decoders run under.
    max_frame_bytes_offset: u16,
    /// Byte offsets the whole input is cut at, before clamping and sorting.
    cuts: Vec<u16>,
    bytes: Vec<u8>,
}

/// A ceiling in `MIN_MAX_FRAME_BYTES..=8192`, the same range `decode_line`
/// uses. The floor is not a preference: `LineDecoder::new` refuses anything
/// below it, so a smaller ceiling would abort the run rather than exercise
/// the decoder. The top of the range is what keeps the too-large refusal
/// reachable — it is exactly the path where the whole-push and split-push
/// decoders once disagreed (a blank line over the limit) — and it is only
/// reachable because the lane raises `-max_len` past 8192 for this target.
fn max_frame_bytes(offset: u16) -> usize {
    MIN_MAX_FRAME_BYTES + (usize::from(offset) % (8192 - MIN_MAX_FRAME_BYTES + 1))
}

/// Splits `bytes` at every cut point, each reduced into range so any `u16`
/// the fuzzer picks is a valid boundary; duplicate cuts collapse into an
/// empty piece rather than being skipped, which is its own useful case for a
/// decoder that must treat zero new bytes as a no-op push.
fn split_at(bytes: &[u8], cuts: &[u16]) -> Vec<Vec<u8>> {
    if bytes.is_empty() {
        return Vec::new();
    }
    let mut boundaries: Vec<usize> = cuts
        .iter()
        .map(|cut| usize::from(*cut) % (bytes.len() + 1))
        .collect();
    boundaries.sort_unstable();

    let mut pieces = Vec::with_capacity(boundaries.len() + 1);
    let mut start = 0;
    for cut in boundaries.drain(..) {
        pieces.push(bytes[start..cut].to_vec());
        start = cut;
    }
    pieces.push(bytes[start..].to_vec());
    pieces
}

/// Pushes `bytes` through `decoder` in one or more pieces, then flushes with
/// `finish`, collecting every decoded frame and the first refusal kind.
fn drain(decoder: &mut LineDecoder, pieces: &[Vec<u8>]) -> (Vec<Frame>, Option<CodecErrorKind>) {
    let mut frames = Vec::new();
    let mut error = None;
    for piece in pieces {
        let outcome = decoder.push(piece);
        frames.extend(outcome.frames);
        if let Some(refusal) = outcome.error {
            error = Some(refusal.kind);
            break;
        }
    }
    if error.is_none() {
        match decoder.finish() {
            Ok(flushed) => frames.extend(flushed),
            Err(refusal) => error = Some(refusal.kind),
        }
    }
    (frames, error)
}

fuzz_target!(|input: Input| {
    let max_frame_bytes = max_frame_bytes(input.max_frame_bytes_offset);

    let mut whole = LineDecoder::new(max_frame_bytes);
    let (whole_frames, whole_error) = drain(&mut whole, std::slice::from_ref(&input.bytes));

    let pieces = split_at(&input.bytes, &input.cuts);
    let mut split = LineDecoder::new(max_frame_bytes);
    let (split_frames, split_error) = drain(&mut split, &pieces);

    assert_eq!(
        split_frames,
        whole_frames,
        "splitting {} bytes into {} pieces decoded different frames than one push",
        input.bytes.len(),
        pieces.len()
    );
    assert_eq!(
        split_error,
        whole_error,
        "splitting {} bytes into {} pieces produced a different refusal than one push",
        input.bytes.len(),
        pieces.len()
    );
});
