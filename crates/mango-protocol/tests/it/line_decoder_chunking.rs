//! `LineDecoder` against a model that cannot get chunking wrong.
//!
//! The model never buffers. After every push it takes the whole stream received so far, splits it
//! on `\n`, and decodes each complete record it has not delivered yet with [`decode_line`]. The
//! decoder under test sees the same bytes cut at random places, including inside a multi-byte
//! character, between a `\r` and its `\n`, and in zero-length pushes. Every push must produce the
//! same frames and the same refusal, text included, as the model, and so must `finish`.

use mango_protocol::codec::ndjson::{LineDecoder, MIN_MAX_FRAME_BYTES, PushOutcome, decode_line};
use mango_protocol::error::{CodecError, CodecErrorKind};
use mango_protocol::frame::Frame;
use proptest::prelude::*;

const LIMIT: usize = MIN_MAX_FRAME_BYTES;

/// The trivially correct reference: whole-stream splitting, no incremental state beyond how many
/// complete records it already delivered.
#[derive(Default)]
struct SplitModel {
    stream: Vec<u8>,
    delivered_records: usize,
    refusal: Option<CodecError>,
}

fn without_carriage_return(line: &[u8]) -> &[u8] {
    line.strip_suffix(b"\r").unwrap_or(line)
}

fn is_blank(line: &[u8]) -> bool {
    line.iter().all(u8::is_ascii_whitespace)
}

impl SplitModel {
    fn push(&mut self, bytes: &[u8]) -> PushOutcome {
        if let Some(refusal) = &self.refusal {
            return PushOutcome {
                frames: Vec::new(),
                error: Some(refusal.clone()),
            };
        }
        self.stream.extend_from_slice(bytes);
        let mut records: Vec<&[u8]> = self.stream.split(|byte| *byte == b'\n').collect();
        // The last element is the unterminated remainder, not a record.
        let partial = records.pop().expect("split yields at least one element");

        let mut frames = Vec::new();
        let mut error = None;
        for record in &records[self.delivered_records..] {
            self.delivered_records += 1;
            let content = without_carriage_return(record);
            if content.len() > LIMIT {
                error = Some(CodecError::new(
                    CodecErrorKind::TooLarge,
                    format!(
                        "received a line of {} bytes, expected at most {LIMIT}",
                        content.len()
                    ),
                ));
                break;
            }
            if is_blank(content) {
                continue;
            }
            match decode_line(record, LIMIT) {
                Ok(frame) => frames.push(frame),
                Err(refusal) => {
                    error = Some(refusal);
                    break;
                }
            }
        }
        if error.is_none() && without_carriage_return(partial).len() > LIMIT {
            error = Some(CodecError::new(
                CodecErrorKind::TooLarge,
                format!(
                    "received a line of {} bytes, expected at most {LIMIT}",
                    without_carriage_return(partial).len()
                ),
            ));
        }
        self.refusal.clone_from(&error);
        PushOutcome { frames, error }
    }

    fn finish(&mut self) -> Result<Vec<Frame>, CodecError> {
        if let Some(refusal) = &self.refusal {
            return Err(refusal.clone());
        }
        let partial = self
            .stream
            .rsplit(|byte| *byte == b'\n')
            .next()
            .expect("split yields at least one element")
            .to_vec();
        if is_blank(without_carriage_return(&partial)) {
            return Ok(Vec::new());
        }
        match decode_line(&partial, LIMIT) {
            Ok(frame) => Ok(vec![frame]),
            Err(refusal) => {
                self.refusal = Some(refusal.clone());
                Err(refusal)
            }
        }
    }
}

/// One record body, with the shapes that matter to framing: frames, blanks, bad JSON, a body of
/// multi-byte characters, and bodies on either side of the limit.
fn record_body() -> impl Strategy<Value = Vec<u8>> {
    prop_oneof![
        8 => Just(br#"{"type":"ping"}"#.to_vec()),
        6 => Just(br#"{"type":"pong"}"#.to_vec()),
        3 => Just(
            "{\"type\":\"req\",\"id\":\"é\",\"method\":\"a.b\",\"params\":\"🥭\"}"
                .as_bytes()
                .to_vec()
        ),
        2 => Just(Vec::new()),
        2 => proptest::collection::vec(prop::sample::select(vec![b' ', b'\t', b'\r']), 0..6),
        2 => Just(br#"{"type":"nope"}"#.to_vec()),
        1 => Just(br#"{"type":"ping""#.to_vec()),
        // A record of `x` that is too long, exactly at, or just under the limit.
        1 => (LIMIT - 3..=LIMIT + 3).prop_map(|length| vec![b'x'; length]),
        // A blank record around the limit: refused for its size, not its blankness.
        1 => (LIMIT - 1..=LIMIT + 1).prop_map(|length| vec![b' '; length]),
    ]
}

/// A record body and the terminator that ends it.
fn terminated_record() -> impl Strategy<Value = Vec<u8>> {
    (
        record_body(),
        prop_oneof![4 => Just(&b"\n"[..]), 2 => Just(&b"\r\n"[..])],
    )
        .prop_map(|(mut body, terminator)| {
            body.extend_from_slice(terminator);
            body
        })
}

/// A stream of terminated records, with an optional unterminated tail.
fn stream() -> impl Strategy<Value = Vec<u8>> {
    (
        proptest::collection::vec(terminated_record(), 0..8),
        proptest::option::of(record_body()),
    )
        .prop_map(|(records, tail)| {
            let mut bytes: Vec<u8> = records.concat();
            bytes.extend(tail.unwrap_or_default());
            bytes
        })
}

/// Sorted cut points, reduced into `0..=length`. Duplicates make zero-length pushes.
fn cut_points(length: usize, raw: &[usize]) -> Vec<usize> {
    let mut cuts: Vec<usize> = raw.iter().map(|cut| cut % (length + 1)).collect();
    cuts.sort_unstable();
    cuts
}

fn pieces<'a>(bytes: &'a [u8], cuts: &[usize]) -> Vec<&'a [u8]> {
    let mut pieces = Vec::with_capacity(cuts.len() + 1);
    let mut start = 0;
    for cut in cuts {
        pieces.push(&bytes[start..*cut]);
        start = *cut;
    }
    pieces.push(&bytes[start..]);
    pieces
}

/// Runs both through the same pieces and `finish`, returning the first disagreement.
fn disagreement(pieces: &[&[u8]]) -> Option<String> {
    let mut decoder = LineDecoder::new(LIMIT);
    let mut model = SplitModel::default();
    for (index, piece) in pieces.iter().enumerate() {
        let actual = decoder.push(piece);
        let expected = model.push(piece);
        if actual != expected {
            return Some(format!(
                "push {index} of {} ({} bytes) | expected: {expected:?} | received: {actual:?}",
                pieces.len(),
                piece.len()
            ));
        }
    }
    let actual = decoder.finish();
    let expected = model.finish();
    (actual != expected).then(|| format!("finish | expected: {expected:?} | received: {actual:?}"))
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    #[test]
    fn random_chunking_matches_splitting_the_whole_stream(
        bytes in stream(),
        raw_cuts in proptest::collection::vec(any::<usize>(), 0..24),
    ) {
        let cuts = cut_points(bytes.len(), &raw_cuts);
        let pieces = pieces(&bytes, &cuts);
        if let Some(difference) = disagreement(&pieces) {
            prop_assert!(false, "{} bytes cut at {cuts:?}: {difference}", bytes.len());
        }
    }
}

proptest! {
    // The model re-splits the whole stream on every push, so a stream pushed a byte at a time
    // costs it quadratic work: fewer cases keep this under a second in a debug build.
    #![proptest_config(ProptestConfig::with_cases(48))]

    #[test]
    fn one_byte_pushes_match_splitting_the_whole_stream(bytes in stream()) {
        let pieces: Vec<&[u8]> = bytes.chunks(1).collect();
        if let Some(difference) = disagreement(&pieces) {
            prop_assert!(false, "{} bytes pushed one at a time: {difference}", bytes.len());
        }
    }
}

#[test]
fn the_model_agrees_with_the_decoder_on_a_refusal_split_before_its_terminator() {
    let mut stream = vec![b'x'; LIMIT];
    stream.extend_from_slice(b"x\n");
    let cut = LIMIT / 2;
    assert_eq!(
        disagreement(&[
            &stream[..cut],
            &stream[cut..LIMIT + 1],
            &stream[LIMIT + 1..]
        ]),
        None
    );
}

#[test]
fn a_carriage_return_after_a_limit_sized_partial_record_does_not_count() {
    // `LIMIT` bytes then `\r` is a partial record of `LIMIT` bytes once the `\r` is read as the
    // start of its terminator, so the first push is not refused; the model and the decoder must
    // agree on that and on the refusal for the non-JSON record that the `\n` then completes.
    let mut record = vec![b'x'; LIMIT];
    record.extend_from_slice(b"\r\n");
    let mut decoder = LineDecoder::new(LIMIT);
    let first = decoder.push(&record[..LIMIT + 1]);
    assert_eq!(
        first.error, None,
        "expected a {LIMIT}-byte partial record plus `\\r` to wait for its `\\n` | received: {first:?}"
    );
    let second = decoder.push(&record[LIMIT + 1..]);
    assert_eq!(
        second.error.map(|error| error.kind),
        Some(CodecErrorKind::InvalidJson)
    );
    assert_eq!(
        disagreement(&[&record[..LIMIT + 1], &record[LIMIT + 1..]]),
        None
    );
}
