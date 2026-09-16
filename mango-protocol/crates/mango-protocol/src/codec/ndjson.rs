//! NDJSON framing: one frame per line, as the stdio transport speaks it.
//!
//! The frame limit bounds the bytes of a line **without** its terminator. A
//! `\r` immediately before the `\n` is part of the terminator: it is stripped
//! and does not count.

use serde_json::error::Category;

use crate::codec::limits::{check_at_least, checked_at_least};
use crate::error::{CodecError, CodecErrorKind};
use crate::frame::Frame;
use crate::validate::validate;

/// The default frame limit: 16 MiB, as §11 states.
pub const DEFAULT_MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
/// The lowest ceiling a peer may announce in `hello.limits.maxFrameBytes`.
pub const MIN_MAX_FRAME_BYTES: usize = crate::validate::MIN_ANNOUNCED_FRAME_BYTES as usize;

/// How much of a refused line an error message quotes.
const PREVIEW_CHARS: usize = 120;

/// Quotes the head of a refused line for an error message.
fn preview(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let count = text.chars().count();
    if count <= PREVIEW_CHARS {
        return format!("{text:?}");
    }
    let head: String = text.chars().take(PREVIEW_CHARS).collect();
    format!("{head:?}… ({} bytes)", bytes.len())
}

fn too_large(length: usize, max_frame_bytes: usize) -> CodecError {
    CodecError::new(
        CodecErrorKind::TooLarge,
        format!("received a line of {length} bytes, expected at most {max_frame_bytes}"),
    )
}

/// The `"type"` member of a line that parses as a JSON object, if it has a
/// string one. Used only to name the frame type of a record that failed
/// deserialisation entirely, mirroring the TypeScript SDK's `frameTypeOf`.
fn frame_type_of(line: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(line).ok()?;
    match value.as_object()?.get("type")? {
        serde_json::Value::String(frame_type) => Some(frame_type.clone()),
        _ => None,
    }
}

/// Drops one `\r` immediately before the line terminator.
fn strip_carriage_return(line: &[u8]) -> &[u8] {
    match line.split_last() {
        Some((b'\r', head)) => head,
        _ => line,
    }
}

/// True for a line that is empty or only ASCII whitespace; the stream ignores it.
fn is_blank(line: &[u8]) -> bool {
    line.iter().all(u8::is_ascii_whitespace)
}

/// Encodes one frame as compact UTF-8 JSON, without a terminator.
///
/// The frame is validated first: a peer must never send a frame that violates
/// the schema. `max_frame_bytes` below [`MIN_MAX_FRAME_BYTES`] is refused the
/// same way, naming both — this function already returns a `Result`, so it
/// refuses rather than panics, unlike the builders that carry this same rule.
///
/// # Example
///
/// ```
/// use mango_protocol::{Frame, codec::ndjson::{DEFAULT_MAX_FRAME_BYTES, encode_frame_bytes}};
///
/// let bytes = encode_frame_bytes(&Frame::Ping, DEFAULT_MAX_FRAME_BYTES).unwrap();
/// assert_eq!(bytes, br#"{"type":"ping"}"#);
/// ```
pub fn encode_frame_bytes(frame: &Frame, max_frame_bytes: usize) -> Result<Vec<u8>, CodecError> {
    let max_frame_bytes = checked_at_least("max_frame_bytes", max_frame_bytes, MIN_MAX_FRAME_BYTES)
        .map_err(|message| CodecError::new(CodecErrorKind::Schema, message))?;
    validate(frame).map_err(|error| CodecError::new(CodecErrorKind::Schema, error.to_string()))?;
    let bytes = serde_json::to_vec(frame).map_err(|error| {
        CodecError::new(
            CodecErrorKind::Schema,
            format!(
                "received a {} frame that would not serialise: {error}",
                frame.type_name()
            ),
        )
    })?;
    if bytes.len() > max_frame_bytes {
        return Err(too_large(bytes.len(), max_frame_bytes));
    }
    Ok(bytes)
}

/// Encodes one frame as an NDJSON record: [`encode_frame_bytes`] plus a `\n`.
///
/// The terminator does not count towards the frame limit.
///
/// # Example
///
/// ```
/// use mango_protocol::{Frame, codec::ndjson::{DEFAULT_MAX_FRAME_BYTES, encode_line}};
///
/// let line = encode_line(&Frame::Pong, DEFAULT_MAX_FRAME_BYTES).unwrap();
/// assert_eq!(line, b"{\"type\":\"pong\"}\n");
/// ```
pub fn encode_line(frame: &Frame, max_frame_bytes: usize) -> Result<Vec<u8>, CodecError> {
    let mut line = encode_frame_bytes(frame, max_frame_bytes)?;
    line.push(b'\n');
    Ok(line)
}

/// Decodes one NDJSON record — a line without its `\n` — into a frame.
///
/// A trailing `\r` is stripped. A blank or whitespace-only line is refused with
/// [`CodecErrorKind::Schema`]: the stream decoder skips such lines, but there is
/// no frame to hand back here. Bytes that are not JSON are
/// [`CodecErrorKind::InvalidJson`]; JSON that is not a valid frame, or a frame
/// whose members break a length, grammar or range rule, is
/// [`CodecErrorKind::Schema`]. `max_frame_bytes` below [`MIN_MAX_FRAME_BYTES`]
/// is refused the same way, naming both.
///
/// # Example
///
/// ```
/// use mango_protocol::{Frame, codec::ndjson::{DEFAULT_MAX_FRAME_BYTES, decode_line}};
///
/// let frame = decode_line(br#"{"type":"ping"}"#, DEFAULT_MAX_FRAME_BYTES).unwrap();
/// assert_eq!(frame, Frame::Ping);
/// ```
pub fn decode_line(bytes: &[u8], max_frame_bytes: usize) -> Result<Frame, CodecError> {
    let max_frame_bytes = checked_at_least("max_frame_bytes", max_frame_bytes, MIN_MAX_FRAME_BYTES)
        .map_err(|message| CodecError::new(CodecErrorKind::Schema, message))?;
    let line = strip_carriage_return(bytes);
    if line.len() > max_frame_bytes {
        return Err(too_large(line.len(), max_frame_bytes));
    }
    if is_blank(line) {
        return Err(CodecError::new(
            CodecErrorKind::Schema,
            format!(
                "received a blank line of {} bytes, expected one JSON object with a type member",
                line.len()
            ),
        ));
    }
    let frame: Frame = serde_json::from_slice(line).map_err(|error| {
        let kind = match error.classify() {
            Category::Syntax | Category::Eof | Category::Io => CodecErrorKind::InvalidJson,
            Category::Data => CodecErrorKind::Schema,
        };
        let refusal = CodecError::new(
            kind,
            format!(
                "received {}, expected one Mango Protocol frame: {error}",
                preview(line)
            ),
        );
        match frame_type_of(line) {
            Some(frame_type) if kind == CodecErrorKind::Schema => {
                refusal.with_frame_type(frame_type)
            }
            _ => refusal,
        }
    })?;
    validate(&frame).map_err(|error| {
        CodecError::new(CodecErrorKind::Schema, error.to_string())
            .with_frame_type(frame.type_name())
    })?;
    Ok(frame)
}

/// What one [`LineDecoder::push`] produced.
///
/// A refusal ends the stream, so `frames` carries every frame decoded **before**
/// the refused record and `error` carries the refusal. Both may be non-empty in
/// the same outcome; the caller delivers the frames, then closes with `4400`.
///
/// # Example
///
/// ```
/// use mango_protocol::codec::ndjson::{DEFAULT_MAX_FRAME_BYTES, LineDecoder};
///
/// let mut decoder = LineDecoder::new(DEFAULT_MAX_FRAME_BYTES);
/// let outcome = decoder.push(b"{\"type\":\"ping\"}\n{\"type\":\"nope\"}\n");
/// assert_eq!(outcome.frames.len(), 1);
/// assert!(outcome.error.is_some());
/// ```
#[derive(Debug, Clone, PartialEq)]
pub struct PushOutcome {
    /// Frames decoded from the complete records in this push, in order.
    pub frames: Vec<Frame>,
    /// The refusal that ended the stream, if one happened.
    pub error: Option<CodecError>,
}

impl PushOutcome {
    /// True when nothing was refused.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::codec::ndjson::{DEFAULT_MAX_FRAME_BYTES, LineDecoder};
    ///
    /// let mut decoder = LineDecoder::new(DEFAULT_MAX_FRAME_BYTES);
    /// assert!(decoder.push(b"{\"type\":\"ping\"}\n").is_ok());
    /// ```
    #[must_use]
    pub const fn is_ok(&self) -> bool {
        self.error.is_none()
    }
}

/// Buffers bytes and hands back whole frames, one per NDJSON record.
///
/// Pieces may split anywhere, including inside a multi-byte UTF-8 sequence, so
/// the decoder buffers bytes rather than characters. Blank and whitespace-only
/// lines are ignored. A partial record that already exceeds the frame limit is
/// refused before its terminator arrives.
///
/// A refusal is fatal: the stream cannot be resynchronised, so every later
/// [`LineDecoder::push`] repeats the same refusal and decodes nothing.
///
/// # Example
///
/// ```
/// use mango_protocol::{Frame, codec::ndjson::{DEFAULT_MAX_FRAME_BYTES, LineDecoder}};
///
/// let mut decoder = LineDecoder::new(DEFAULT_MAX_FRAME_BYTES);
/// assert!(decoder.push(b"{\"type\":\"pi").frames.is_empty());
/// assert_eq!(decoder.push(b"ng\"}\n").frames, vec![Frame::Ping]);
/// ```
#[derive(Debug, Clone)]
pub struct LineDecoder {
    max_frame_bytes: usize,
    buffer: Vec<u8>,
    failure: Option<CodecError>,
}

impl LineDecoder {
    /// Builds a decoder bounded by `max_frame_bytes`.
    ///
    /// # Panics
    ///
    /// Panics when `max_frame_bytes` is below [`MIN_MAX_FRAME_BYTES`], naming
    /// both.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::codec::ndjson::{LineDecoder, MIN_MAX_FRAME_BYTES};
    ///
    /// let decoder = LineDecoder::new(MIN_MAX_FRAME_BYTES);
    /// assert_eq!(decoder.max_frame_bytes(), 4096);
    /// ```
    #[must_use]
    pub fn new(max_frame_bytes: usize) -> Self {
        let max_frame_bytes =
            check_at_least("max_frame_bytes", max_frame_bytes, MIN_MAX_FRAME_BYTES);
        Self {
            max_frame_bytes,
            buffer: Vec::new(),
            failure: None,
        }
    }

    /// The frame limit this decoder enforces.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::codec::ndjson::{DEFAULT_MAX_FRAME_BYTES, LineDecoder};
    ///
    /// assert_eq!(LineDecoder::new(DEFAULT_MAX_FRAME_BYTES).max_frame_bytes(), 16 * 1024 * 1024);
    /// ```
    #[must_use]
    pub const fn max_frame_bytes(&self) -> usize {
        self.max_frame_bytes
    }

    /// Feeds the next bytes off the transport.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::{Frame, codec::ndjson::{DEFAULT_MAX_FRAME_BYTES, LineDecoder}};
    ///
    /// let mut decoder = LineDecoder::new(DEFAULT_MAX_FRAME_BYTES);
    /// let outcome = decoder.push(b"{\"type\":\"ping\"}\n{\"type\":\"pong\"}\n");
    /// assert_eq!(outcome.frames, vec![Frame::Ping, Frame::Pong]);
    /// ```
    pub fn push(&mut self, bytes: &[u8]) -> PushOutcome {
        if let Some(failure) = &self.failure {
            return PushOutcome {
                frames: Vec::new(),
                error: Some(failure.clone()),
            };
        }
        self.buffer.extend_from_slice(bytes);

        let max_frame_bytes = self.max_frame_bytes;
        let mut frames = Vec::new();
        let mut failure = None;
        let mut consumed = 0;
        while let Some(offset) = self.buffer[consumed..]
            .iter()
            .position(|byte| *byte == b'\n')
        {
            let end = consumed + offset;
            let line = &self.buffer[consumed..end];
            consumed = end + 1;
            let content = strip_carriage_return(line);
            // The size check runs before the blank check, not after: §11's "a
            // decoder MUST refuse a line that exceeds the limit" names the
            // line, not the frame it might have held, and a completed blank
            // line must refuse exactly when the same bytes, still partial (no
            // `\n` yet), already would have above. Checking blankness first
            // let an oversized blank line buffer to completion and then be
            // silently ignored, while the identical bytes arriving in two
            // pushes were refused the moment they crossed the limit.
            if content.len() > max_frame_bytes {
                failure = Some(too_large(content.len(), max_frame_bytes));
                break;
            }
            if is_blank(content) {
                continue;
            }
            match decode_line(line, max_frame_bytes) {
                Ok(frame) => frames.push(frame),
                Err(error) => {
                    failure = Some(error);
                    break;
                }
            }
        }
        self.buffer.drain(..consumed);

        if failure.is_none() {
            let partial = strip_carriage_return(&self.buffer).len();
            if partial > max_frame_bytes {
                failure = Some(too_large(partial, max_frame_bytes));
            }
        }
        if let Some(error) = &failure {
            self.failure = Some(error.clone());
            self.buffer.clear();
        }
        PushOutcome {
            frames,
            error: failure,
        }
    }

    /// Flushes a final record that arrived without a terminator, at end of stream.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::{Frame, codec::ndjson::{DEFAULT_MAX_FRAME_BYTES, LineDecoder}};
    ///
    /// let mut decoder = LineDecoder::new(DEFAULT_MAX_FRAME_BYTES);
    /// decoder.push(b"{\"type\":\"ping\"}");
    /// assert_eq!(decoder.finish().unwrap(), vec![Frame::Ping]);
    /// ```
    pub fn finish(&mut self) -> Result<Vec<Frame>, CodecError> {
        if let Some(failure) = &self.failure {
            return Err(failure.clone());
        }
        let line = std::mem::take(&mut self.buffer);
        if is_blank(strip_carriage_return(&line)) {
            return Ok(Vec::new());
        }
        match decode_line(&line, self.max_frame_bytes) {
            Ok(frame) => Ok(vec![frame]),
            Err(error) => {
                self.failure = Some(error.clone());
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        DEFAULT_MAX_FRAME_BYTES, LineDecoder, MIN_MAX_FRAME_BYTES, decode_line, encode_frame_bytes,
        encode_line,
    };
    use crate::error::CodecErrorKind;
    use crate::frame::{Close, Frame, Request};
    use serde_json::Value;

    #[test]
    fn encodes_compactly_and_without_a_terminator() {
        let bytes = encode_frame_bytes(&Frame::Ping, DEFAULT_MAX_FRAME_BYTES).expect("encodes");
        assert_eq!(bytes, br#"{"type":"ping"}"#);
    }

    #[test]
    fn encode_line_appends_exactly_one_newline() {
        let line = encode_line(&Frame::Ping, DEFAULT_MAX_FRAME_BYTES).expect("encodes");
        assert_eq!(line.last(), Some(&b'\n'));
        assert_eq!(line.len(), 16);
    }

    #[test]
    fn encoding_refuses_a_frame_over_the_limit() {
        let frame = Frame::Req(Request {
            id: "r".into(),
            method: "a.b".into(),
            params: Value::String("x".repeat(5000)),
        });
        let error = encode_frame_bytes(&frame, MIN_MAX_FRAME_BYTES).expect_err("too large");
        assert_eq!(error.kind, CodecErrorKind::TooLarge);
        assert!(error.message.contains("4096"), "{error}");
    }

    #[test]
    fn encoding_refuses_a_frame_that_breaks_a_value_rule() {
        let frame = Frame::Close(Close {
            code: 3999,
            reason: None,
        });
        let error = encode_frame_bytes(&frame, DEFAULT_MAX_FRAME_BYTES).expect_err("invalid");
        assert_eq!(error.kind, CodecErrorKind::Schema);
        assert!(error.message.contains("close.code"), "{error}");
    }

    #[test]
    fn decoding_strips_one_trailing_carriage_return() {
        let frame =
            decode_line(b"{\"type\":\"ping\"}\r", DEFAULT_MAX_FRAME_BYTES).expect("decodes");
        assert_eq!(frame, Frame::Ping);
    }

    #[test]
    fn decoding_a_blank_line_is_a_schema_refusal() {
        let error = decode_line(b"   ", DEFAULT_MAX_FRAME_BYTES).expect_err("blank");
        assert_eq!(error.kind, CodecErrorKind::Schema);
        assert!(error.message.contains("blank"), "{error}");
    }

    #[test]
    fn decoding_separates_bad_json_from_a_bad_frame() {
        let syntax = decode_line(b"{\"type\":\"ping\"", DEFAULT_MAX_FRAME_BYTES).expect_err("eof");
        assert_eq!(syntax.kind, CodecErrorKind::InvalidJson);
        let data = decode_line(b"{\"type\":\"nope\"}", DEFAULT_MAX_FRAME_BYTES).expect_err("data");
        assert_eq!(data.kind, CodecErrorKind::Schema);
    }

    #[test]
    fn a_line_at_the_limit_is_accepted_and_one_byte_over_is_not() {
        // The ceiling itself must stay at or above MIN_MAX_FRAME_BYTES now
        // that decode_line refuses a sub-floor one, so the boundary under
        // test is sized up rather than using the 16-byte ping line.
        let frame = Frame::Req(Request {
            id: "r".into(),
            method: "a.b".into(),
            params: Value::String("x".repeat(MIN_MAX_FRAME_BYTES)),
        });
        let line = encode_frame_bytes(&frame, DEFAULT_MAX_FRAME_BYTES).expect("encodes");
        assert!(line.len() > MIN_MAX_FRAME_BYTES);
        assert!(decode_line(&line, line.len()).is_ok());
        let error = decode_line(&line, line.len() - 1).expect_err("too large");
        assert_eq!(error.kind, CodecErrorKind::TooLarge);
    }

    #[test]
    fn encoding_refuses_a_frame_ceiling_below_the_floor() {
        let error =
            encode_frame_bytes(&Frame::Ping, MIN_MAX_FRAME_BYTES - 1).expect_err("below floor");
        assert_eq!(error.kind, CodecErrorKind::Schema);
        assert_eq!(
            error.message,
            format!(
                "max_frame_bytes is {}; expected at least {MIN_MAX_FRAME_BYTES}",
                MIN_MAX_FRAME_BYTES - 1
            )
        );
    }

    #[test]
    fn decoding_refuses_a_frame_ceiling_below_the_floor() {
        let error =
            decode_line(b"{\"type\":\"ping\"}", MIN_MAX_FRAME_BYTES - 1).expect_err("below floor");
        assert_eq!(error.kind, CodecErrorKind::Schema);
        assert_eq!(
            error.message,
            format!(
                "max_frame_bytes is {}; expected at least {MIN_MAX_FRAME_BYTES}",
                MIN_MAX_FRAME_BYTES - 1
            )
        );
    }

    #[test]
    fn building_a_decoder_below_the_floor_panics_naming_both() {
        let message = crate::codec::limits::panic_message(|| {
            let _ = LineDecoder::new(MIN_MAX_FRAME_BYTES - 1);
        });
        assert_eq!(
            message,
            format!(
                "max_frame_bytes is {}; expected at least {MIN_MAX_FRAME_BYTES}",
                MIN_MAX_FRAME_BYTES - 1
            )
        );
    }

    #[test]
    fn the_stream_ignores_blank_lines() {
        let mut decoder = LineDecoder::new(DEFAULT_MAX_FRAME_BYTES);
        let outcome = decoder.push(b"\n\r\n   \n{\"type\":\"ping\"}\n\n");
        assert_eq!(outcome.frames, vec![Frame::Ping]);
        assert!(outcome.is_ok());
    }

    #[test]
    fn the_stream_buffers_across_a_multibyte_split() {
        let mut decoder = LineDecoder::new(DEFAULT_MAX_FRAME_BYTES);
        let line = "{\"type\":\"req\",\"id\":\"é\",\"method\":\"a.b\",\"params\":\"🥭\"}\n";
        let bytes = line.as_bytes();
        let mut frames = Vec::new();
        for byte in bytes {
            let outcome = decoder.push(std::slice::from_ref(byte));
            assert!(outcome.is_ok());
            frames.extend(outcome.frames);
        }
        assert_eq!(frames.len(), 1);
        assert_eq!(
            serde_json::to_value(&frames[0]).expect("serialises")["id"],
            Value::String("é".into())
        );
    }

    #[test]
    fn the_stream_delivers_the_prefix_before_a_refusal_and_then_stays_refused() {
        let mut decoder = LineDecoder::new(DEFAULT_MAX_FRAME_BYTES);
        let outcome =
            decoder.push(b"{\"type\":\"ping\"}\n{\"type\":\"nope\"}\n{\"type\":\"pong\"}\n");
        assert_eq!(outcome.frames, vec![Frame::Ping]);
        assert_eq!(
            outcome.error.as_ref().map(|error| error.kind),
            Some(CodecErrorKind::Schema)
        );
        let again = decoder.push(b"{\"type\":\"ping\"}\n");
        assert!(again.frames.is_empty());
        assert_eq!(
            again.error.map(|error| error.kind),
            Some(CodecErrorKind::Schema)
        );
        assert!(decoder.finish().is_err());
    }

    #[test]
    fn a_partial_record_over_the_limit_is_refused_before_its_terminator() {
        let mut decoder = LineDecoder::new(MIN_MAX_FRAME_BYTES);
        let outcome = decoder.push(&vec![b'x'; MIN_MAX_FRAME_BYTES + 1]);
        assert!(outcome.frames.is_empty());
        assert_eq!(
            outcome.error.map(|error| error.kind),
            Some(CodecErrorKind::TooLarge)
        );
    }

    #[test]
    fn a_partial_record_at_the_limit_waits_for_its_terminator() {
        let mut decoder = LineDecoder::new(MIN_MAX_FRAME_BYTES);
        let outcome = decoder.push(&vec![b'x'; MIN_MAX_FRAME_BYTES]);
        assert!(outcome.is_ok());
        assert!(outcome.frames.is_empty());
    }

    /// The standalone decoder orders the two checks the same way the stream
    /// decoder does: over the limit is over the limit, blank or not. The
    /// TypeScript `decodeLine` reported `empty` for this input until the same
    /// order landed there.
    #[test]
    fn an_oversized_blank_line_is_refused_for_its_size_not_its_blankness() {
        let blank = vec![b' '; MIN_MAX_FRAME_BYTES + 1];
        let error = decode_line(&blank, MIN_MAX_FRAME_BYTES).expect_err("over the limit");
        assert_eq!(error.kind, CodecErrorKind::TooLarge);

        let fits = vec![b' '; MIN_MAX_FRAME_BYTES];
        let error = decode_line(&fits, MIN_MAX_FRAME_BYTES).expect_err("blank");
        assert_eq!(error.kind, CodecErrorKind::Schema);
    }

    #[test]
    fn an_oversized_blank_line_is_refused_whether_it_arrives_whole_or_split() {
        let mut blank = vec![b' '; MIN_MAX_FRAME_BYTES + 1];
        blank.push(b'\n');

        let mut whole = LineDecoder::new(MIN_MAX_FRAME_BYTES);
        let whole_outcome = whole.push(&blank);
        assert!(whole_outcome.frames.is_empty());
        assert_eq!(
            whole_outcome.error.map(|error| error.kind),
            Some(CodecErrorKind::TooLarge),
            "a blank line over the limit must be refused, not silently ignored"
        );

        let (head, tail) = blank.split_at(blank.len() - 1);
        let mut split = LineDecoder::new(MIN_MAX_FRAME_BYTES);
        let first = split.push(head);
        assert!(first.frames.is_empty());
        assert_eq!(
            first.error.map(|error| error.kind),
            Some(CodecErrorKind::TooLarge),
            "the same bytes, delivered before their terminator, must refuse identically"
        );
        let second = split.push(tail);
        assert_eq!(
            second.error.map(|error| error.kind),
            Some(CodecErrorKind::TooLarge)
        );
    }

    #[test]
    fn finish_flushes_a_record_without_a_terminator_and_then_is_empty() {
        let mut decoder = LineDecoder::new(DEFAULT_MAX_FRAME_BYTES);
        decoder.push(b"{\"type\":\"ping\"}");
        assert_eq!(decoder.finish().expect("flushes"), vec![Frame::Ping]);
        assert_eq!(decoder.finish().expect("empty"), Vec::new());
    }

    #[test]
    fn a_round_trip_through_the_stream_keeps_the_frame() {
        let frame = Frame::Close(Close {
            code: 4409,
            reason: Some("superseded by a newer connection".into()),
        });
        let line = encode_line(&frame, DEFAULT_MAX_FRAME_BYTES).expect("encodes");
        let mut decoder = LineDecoder::new(DEFAULT_MAX_FRAME_BYTES);
        assert_eq!(decoder.push(&line).frames, vec![frame]);
    }

    #[test]
    fn a_structurally_incomplete_hello_names_the_frame_type() {
        let line = br#"{"type":"hello","protocol":{"major":1,"minor":0}}"#;
        let error = decode_line(line, DEFAULT_MAX_FRAME_BYTES).expect_err("missing peer");
        assert_eq!(error.kind, CodecErrorKind::Schema);
        assert_eq!(error.frame_type.as_deref(), Some("hello"));
    }

    #[test]
    fn a_hello_that_fails_value_validation_names_the_frame_type() {
        let line = br#"{"type":"hello","protocol":{"major":1,"minor":0},"peer":{"name":"","version":"1.0.0","role":"hub"},"capabilities":{}}"#;
        let error = decode_line(line, DEFAULT_MAX_FRAME_BYTES).expect_err("blank peer name");
        assert_eq!(error.kind, CodecErrorKind::Schema);
        assert_eq!(error.frame_type.as_deref(), Some("hello"));
    }

    #[test]
    fn invalid_json_never_names_a_frame_type() {
        let error = decode_line(b"{\"type\":\"hello\"", DEFAULT_MAX_FRAME_BYTES).expect_err("eof");
        assert_eq!(error.kind, CodecErrorKind::InvalidJson);
        assert_eq!(error.frame_type, None);
    }

    #[test]
    fn a_schema_refusal_of_a_non_hello_frame_names_that_frame_type() {
        let error = decode_line(b"{\"type\":\"nope\"}", DEFAULT_MAX_FRAME_BYTES).expect_err("data");
        assert_eq!(error.kind, CodecErrorKind::Schema);
        assert_eq!(error.frame_type.as_deref(), Some("nope"));
    }
}
