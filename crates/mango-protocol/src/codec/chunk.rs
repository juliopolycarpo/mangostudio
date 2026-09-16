//! WebSocket chunk framing: one frame split across binary messages.
//!
//! A message is a nine-byte header — format version, chunk index and chunk
//! count — followed by a slice of the frame's UTF-8 bytes, which are the NDJSON
//! line without its terminator. Chunks of two frames never interleave, so one
//! [`ChunkReassembler`] per connection is enough.

use crate::codec::limits::{check_at_least, check_max_frame_bytes};
use crate::codec::ndjson::{decode_line, encode_frame_bytes};
use crate::error::{CodecError, CodecErrorKind};
use crate::frame::Frame;

/// Bytes of the chunk header: version, index, count.
pub const CHUNK_HEADER_BYTES: usize = 9;
/// The only chunk format version wire 1 defines.
pub const CHUNK_FORMAT_VERSION: u8 = 1;
/// The reference message ceiling: safe on a server shared with browser sockets.
pub const DEFAULT_MAX_MESSAGE_BYTES: usize = 16 * 1024;
/// The lowest message ceiling a sender may choose.
pub const MIN_MAX_MESSAGE_BYTES: usize = 2048;
/// Every chunk but the last carries at least this many payload bytes.
pub const MIN_NONFINAL_PAYLOAD_BYTES: usize = 1024;

/// The most chunks one frame can need, derived from the frame limit alone.
///
/// A non-final chunk carries at least [`MIN_NONFINAL_PAYLOAD_BYTES`], so a
/// receiver can refuse an absurd `count` before it allocates anything.
///
/// # Example
///
/// ```
/// use mango_protocol::codec::chunk::max_chunks_for;
///
/// assert_eq!(max_chunks_for(16 * 1024 * 1024), 16_384);
/// ```
#[must_use]
pub fn max_chunks_for(max_frame_bytes: usize) -> u32 {
    u32::try_from(max_frame_bytes.div_ceil(MIN_NONFINAL_PAYLOAD_BYTES)).unwrap_or(u32::MAX)
}

fn refuse(kind: CodecErrorKind, message: String) -> CodecError {
    CodecError::new(kind, message)
}

/// Splits one frame into chunk messages, filling every non-final message to capacity.
///
/// # Example
///
/// ```
/// use mango_protocol::codec::chunk::{DEFAULT_MAX_MESSAGE_BYTES, encode_chunks};
/// use mango_protocol::codec::ndjson::DEFAULT_MAX_FRAME_BYTES;
/// use mango_protocol::Frame;
///
/// let messages =
///     encode_chunks(&Frame::Ping, DEFAULT_MAX_MESSAGE_BYTES, DEFAULT_MAX_FRAME_BYTES).unwrap();
/// assert_eq!(messages.len(), 1);
/// assert_eq!(&messages[0][9..], br#"{"type":"ping"}"#);
/// ```
pub fn encode_chunks(
    frame: &Frame,
    max_message_bytes: usize,
    max_frame_bytes: usize,
) -> Result<Vec<Vec<u8>>, CodecError> {
    if max_message_bytes < MIN_MAX_MESSAGE_BYTES {
        return Err(refuse(
            CodecErrorKind::ChunkHeader,
            format!(
                "received a message ceiling of {max_message_bytes} bytes, \
                 expected at least {MIN_MAX_MESSAGE_BYTES}"
            ),
        ));
    }
    let bytes = encode_frame_bytes(frame, max_frame_bytes)?;
    let capacity = max_message_bytes - CHUNK_HEADER_BYTES;
    let count = bytes.len().div_ceil(capacity).max(1);
    let bound = max_chunks_for(max_frame_bytes);
    let count = u32::try_from(count).unwrap_or(u32::MAX);
    if count > bound {
        return Err(refuse(
            CodecErrorKind::ChunkCount,
            format!("received a frame needing {count} chunks, expected at most {bound}"),
        ));
    }

    let mut messages = Vec::with_capacity(count as usize);
    for index in 0..count {
        let start = index as usize * capacity;
        let end = (start + capacity).min(bytes.len());
        let payload = &bytes[start..end];
        let mut message = Vec::with_capacity(CHUNK_HEADER_BYTES + payload.len());
        message.push(CHUNK_FORMAT_VERSION);
        message.extend_from_slice(&index.to_be_bytes());
        message.extend_from_slice(&count.to_be_bytes());
        message.extend_from_slice(payload);
        messages.push(message);
    }
    Ok(messages)
}

/// Rebuilds one frame from the chunk messages of a WebSocket connection.
///
/// Every refusal resets the reassembler, because a refusal is fatal on this
/// transport: the receiver closes with `4400` rather than resynchronising.
///
/// # Example
///
/// ```
/// use mango_protocol::codec::chunk::{ChunkReassembler, DEFAULT_MAX_MESSAGE_BYTES, encode_chunks};
/// use mango_protocol::codec::ndjson::DEFAULT_MAX_FRAME_BYTES;
/// use mango_protocol::Frame;
///
/// let messages =
///     encode_chunks(&Frame::Ping, DEFAULT_MAX_MESSAGE_BYTES, DEFAULT_MAX_FRAME_BYTES).unwrap();
/// let mut reassembler =
///     ChunkReassembler::new(DEFAULT_MAX_MESSAGE_BYTES, DEFAULT_MAX_FRAME_BYTES);
/// assert_eq!(reassembler.push(&messages[0]).unwrap(), Some(Frame::Ping));
/// ```
#[derive(Debug, Clone)]
pub struct ChunkReassembler {
    max_message_bytes: usize,
    max_frame_bytes: usize,
    count: Option<u32>,
    next_index: u32,
    buffer: Vec<u8>,
}

impl ChunkReassembler {
    /// Builds a reassembler for one connection.
    ///
    /// `max_message_bytes` is the ceiling this connection's sender uses; it
    /// sizes the reassembly buffer. `max_frame_bytes` is the frame limit and is
    /// what actually bounds reassembly.
    ///
    /// # Panics
    ///
    /// Panics when `max_message_bytes` is below [`MIN_MAX_MESSAGE_BYTES`] or
    /// `max_frame_bytes` is below [`crate::codec::ndjson::MIN_MAX_FRAME_BYTES`],
    /// naming both.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::codec::chunk::{ChunkReassembler, DEFAULT_MAX_MESSAGE_BYTES};
    /// use mango_protocol::codec::ndjson::DEFAULT_MAX_FRAME_BYTES;
    ///
    /// let reassembler =
    ///     ChunkReassembler::new(DEFAULT_MAX_MESSAGE_BYTES, DEFAULT_MAX_FRAME_BYTES);
    /// assert_eq!(reassembler.max_message_bytes(), 16 * 1024);
    /// ```
    #[must_use]
    pub fn new(max_message_bytes: usize, max_frame_bytes: usize) -> Self {
        let max_message_bytes = check_at_least(
            "max_message_bytes",
            max_message_bytes,
            MIN_MAX_MESSAGE_BYTES,
        );
        let max_frame_bytes = check_max_frame_bytes(max_frame_bytes);
        Self {
            max_message_bytes,
            max_frame_bytes,
            count: None,
            next_index: 0,
            buffer: Vec::new(),
        }
    }

    /// The message ceiling this connection was built with.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::codec::chunk::{ChunkReassembler, MIN_MAX_MESSAGE_BYTES};
    ///
    /// assert_eq!(ChunkReassembler::new(MIN_MAX_MESSAGE_BYTES, 4096).max_message_bytes(), 2048);
    /// ```
    #[must_use]
    pub const fn max_message_bytes(&self) -> usize {
        self.max_message_bytes
    }

    /// The frame limit that bounds reassembly.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::codec::chunk::{ChunkReassembler, MIN_MAX_MESSAGE_BYTES};
    ///
    /// assert_eq!(ChunkReassembler::new(MIN_MAX_MESSAGE_BYTES, 4096).max_frame_bytes(), 4096);
    /// ```
    #[must_use]
    pub const fn max_frame_bytes(&self) -> usize {
        self.max_frame_bytes
    }

    /// Drops any partially reassembled frame.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::codec::chunk::{ChunkReassembler, DEFAULT_MAX_MESSAGE_BYTES};
    /// use mango_protocol::codec::ndjson::DEFAULT_MAX_FRAME_BYTES;
    ///
    /// let mut reassembler =
    ///     ChunkReassembler::new(DEFAULT_MAX_MESSAGE_BYTES, DEFAULT_MAX_FRAME_BYTES);
    /// reassembler.reset();
    /// assert!(!reassembler.is_reassembling());
    /// ```
    pub fn reset(&mut self) {
        self.count = None;
        self.next_index = 0;
        self.buffer.clear();
    }

    /// True while chunks of a frame have arrived but the final one has not.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::codec::chunk::{ChunkReassembler, DEFAULT_MAX_MESSAGE_BYTES};
    /// use mango_protocol::codec::ndjson::DEFAULT_MAX_FRAME_BYTES;
    ///
    /// let reassembler =
    ///     ChunkReassembler::new(DEFAULT_MAX_MESSAGE_BYTES, DEFAULT_MAX_FRAME_BYTES);
    /// assert!(!reassembler.is_reassembling());
    /// ```
    #[must_use]
    pub const fn is_reassembling(&self) -> bool {
        self.count.is_some()
    }

    /// Feeds one binary WebSocket message.
    ///
    /// Returns the frame once its final chunk arrives, `None` while more are
    /// expected, and a refusal — after resetting — for anything the transport
    /// specification forbids.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::codec::chunk::{ChunkReassembler, DEFAULT_MAX_MESSAGE_BYTES};
    /// use mango_protocol::codec::ndjson::DEFAULT_MAX_FRAME_BYTES;
    /// use mango_protocol::error::CodecErrorKind;
    ///
    /// let mut reassembler =
    ///     ChunkReassembler::new(DEFAULT_MAX_MESSAGE_BYTES, DEFAULT_MAX_FRAME_BYTES);
    /// let error = reassembler.push(&[2, 0, 0, 0, 0, 0, 0, 0, 1, b'{']).unwrap_err();
    /// assert_eq!(error.kind, CodecErrorKind::ChunkVersion);
    /// ```
    pub fn push(&mut self, message: &[u8]) -> Result<Option<Frame>, CodecError> {
        match self.decode(message) {
            Ok(outcome) => Ok(outcome),
            Err(error) => {
                self.reset();
                Err(error)
            }
        }
    }

    /// The rules of `spec/transports/websocket.md`, in the order it states them.
    fn decode(&mut self, message: &[u8]) -> Result<Option<Frame>, CodecError> {
        if let Some(version) = message.first()
            && *version != CHUNK_FORMAT_VERSION
        {
            return Err(refuse(
                CodecErrorKind::ChunkVersion,
                format!("received chunk format version {version}, expected {CHUNK_FORMAT_VERSION}"),
            ));
        }
        if message.len() < CHUNK_HEADER_BYTES {
            return Err(refuse(
                CodecErrorKind::ChunkHeader,
                format!(
                    "received a chunk message of {} bytes, expected at least {CHUNK_HEADER_BYTES}",
                    message.len()
                ),
            ));
        }
        let index = u32::from_be_bytes([message[1], message[2], message[3], message[4]]);
        let count = u32::from_be_bytes([message[5], message[6], message[7], message[8]]);
        let payload = &message[CHUNK_HEADER_BYTES..];

        let bound = max_chunks_for(self.max_frame_bytes);
        if count == 0 || count > bound {
            return Err(refuse(
                CodecErrorKind::ChunkCount,
                format!("received chunk count {count}, expected 1 to {bound}"),
            ));
        }
        if let Some(started) = self.count
            && count != started
        {
            return Err(refuse(
                CodecErrorKind::ChunkCount,
                format!("received chunk count {count}, expected {started} for this frame"),
            ));
        }
        if index != self.next_index {
            return Err(refuse(
                CodecErrorKind::ChunkIndex,
                format!(
                    "received chunk index {index}, expected {} of a {count}-chunk frame",
                    self.next_index
                ),
            ));
        }
        if payload.is_empty() {
            return Err(refuse(
                CodecErrorKind::ChunkDribble,
                format!("received chunk {index} with no payload, expected at least 1 byte"),
            ));
        }
        let is_final = index + 1 == count;
        if !is_final && payload.len() < MIN_NONFINAL_PAYLOAD_BYTES {
            return Err(refuse(
                CodecErrorKind::ChunkDribble,
                format!(
                    "received {} payload bytes in non-final chunk {index}, \
                     expected at least {MIN_NONFINAL_PAYLOAD_BYTES}",
                    payload.len()
                ),
            ));
        }
        let accumulated = self.buffer.len() + payload.len();
        if accumulated > self.max_frame_bytes {
            return Err(refuse(
                CodecErrorKind::TooLarge,
                format!(
                    "received {accumulated} reassembled bytes, expected at most {}",
                    self.max_frame_bytes
                ),
            ));
        }

        if self.count.is_none() {
            self.count = Some(count);
            let estimate = (count as usize)
                .saturating_mul(self.max_message_bytes.saturating_sub(CHUNK_HEADER_BYTES))
                .min(self.max_frame_bytes);
            self.buffer.reserve(estimate);
        }
        self.buffer.extend_from_slice(payload);
        if !is_final {
            self.next_index = index + 1;
            return Ok(None);
        }

        let line = std::mem::take(&mut self.buffer);
        self.reset();
        decode_line(&line, self.max_frame_bytes).map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CHUNK_HEADER_BYTES, ChunkReassembler, DEFAULT_MAX_MESSAGE_BYTES, MIN_MAX_MESSAGE_BYTES,
        MIN_NONFINAL_PAYLOAD_BYTES, encode_chunks, max_chunks_for,
    };
    use crate::codec::ndjson::{DEFAULT_MAX_FRAME_BYTES, MIN_MAX_FRAME_BYTES, encode_frame_bytes};
    use crate::error::CodecErrorKind;
    use crate::frame::{Frame, Request};
    use serde_json::Value;

    fn message(version: u8, index: u32, count: u32, payload: &[u8]) -> Vec<u8> {
        let mut bytes = vec![version];
        bytes.extend_from_slice(&index.to_be_bytes());
        bytes.extend_from_slice(&count.to_be_bytes());
        bytes.extend_from_slice(payload);
        bytes
    }

    fn bulk(blob: usize) -> Frame {
        Frame::Req(Request {
            id: "bulk".into(),
            method: "test.bulk".into(),
            params: serde_json::json!({ "blob": "x".repeat(blob) }),
        })
    }

    fn reassembler() -> ChunkReassembler {
        ChunkReassembler::new(DEFAULT_MAX_MESSAGE_BYTES, DEFAULT_MAX_FRAME_BYTES)
    }

    #[test]
    fn the_chunk_bound_is_the_frame_limit_over_the_minimum_payload() {
        assert_eq!(max_chunks_for(16 * 1024 * 1024), 16_384);
        assert_eq!(max_chunks_for(MIN_MAX_FRAME_BYTES), 4);
        assert_eq!(max_chunks_for(1), 1);
        assert_eq!(max_chunks_for(MIN_NONFINAL_PAYLOAD_BYTES + 1), 2);
    }

    #[test]
    fn a_small_frame_becomes_one_chunk_carrying_the_whole_line() {
        let messages = encode_chunks(
            &Frame::Ping,
            DEFAULT_MAX_MESSAGE_BYTES,
            DEFAULT_MAX_FRAME_BYTES,
        )
        .expect("encodes");
        assert_eq!(messages.len(), 1);
        assert_eq!(
            &messages[0][..CHUNK_HEADER_BYTES],
            &[1, 0, 0, 0, 0, 0, 0, 0, 1]
        );
    }

    #[test]
    fn every_non_final_message_is_filled_to_capacity() {
        let messages = encode_chunks(
            &bulk(40_000),
            DEFAULT_MAX_MESSAGE_BYTES,
            DEFAULT_MAX_FRAME_BYTES,
        )
        .expect("encodes");
        assert!(messages.len() > 2);
        for message in &messages[..messages.len() - 1] {
            assert_eq!(message.len(), DEFAULT_MAX_MESSAGE_BYTES);
        }
        assert!(messages[messages.len() - 1].len() <= DEFAULT_MAX_MESSAGE_BYTES);
    }

    #[test]
    fn encoding_refuses_a_message_ceiling_below_the_floor() {
        let error = encode_chunks(&Frame::Ping, 1024, DEFAULT_MAX_FRAME_BYTES).expect_err("floor");
        assert_eq!(error.kind, CodecErrorKind::ChunkHeader);
        assert!(error.message.contains("2048"), "{error}");
    }

    #[test]
    fn building_a_reassembler_below_the_message_floor_panics_naming_both() {
        let message = crate::codec::limits::panic_message(|| {
            let _ = ChunkReassembler::new(MIN_MAX_MESSAGE_BYTES - 1, DEFAULT_MAX_FRAME_BYTES);
        });
        assert_eq!(
            message,
            format!(
                "max_message_bytes is {}; expected at least {MIN_MAX_MESSAGE_BYTES}",
                MIN_MAX_MESSAGE_BYTES - 1
            )
        );
    }

    #[test]
    fn building_a_reassembler_below_the_frame_floor_panics_naming_both() {
        let message = crate::codec::limits::panic_message(|| {
            let _ = ChunkReassembler::new(DEFAULT_MAX_MESSAGE_BYTES, MIN_MAX_FRAME_BYTES - 1);
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
    fn a_round_trip_through_the_chunker_keeps_the_frame() {
        let frame = bulk(40_000);
        let messages =
            encode_chunks(&frame, MIN_MAX_MESSAGE_BYTES, DEFAULT_MAX_FRAME_BYTES).expect("encodes");
        let mut reassembler = ChunkReassembler::new(MIN_MAX_MESSAGE_BYTES, DEFAULT_MAX_FRAME_BYTES);
        let mut decoded = None;
        for message in &messages {
            decoded = reassembler.push(message).expect("accepts");
        }
        assert_eq!(decoded, Some(frame));
        assert!(!reassembler.is_reassembling());
    }

    #[test]
    fn a_wrong_format_version_is_refused() {
        let error = reassembler()
            .push(&message(2, 0, 1, br#"{"type":"ping"}"#))
            .expect_err("version");
        assert_eq!(error.kind, CodecErrorKind::ChunkVersion);
    }

    #[test]
    fn a_short_header_is_refused() {
        let error = reassembler().push(&[1, 0, 0, 0, 0]).expect_err("header");
        assert_eq!(error.kind, CodecErrorKind::ChunkHeader);
        let empty = reassembler().push(&[]).expect_err("header");
        assert_eq!(empty.kind, CodecErrorKind::ChunkHeader);
    }

    #[test]
    fn a_zero_or_oversized_count_is_refused() {
        let zero = reassembler()
            .push(&message(1, 0, 0, &[]))
            .expect_err("zero");
        assert_eq!(zero.kind, CodecErrorKind::ChunkCount);
        let over = reassembler()
            .push(&message(1, 0, 16_385, &vec![0; MIN_NONFINAL_PAYLOAD_BYTES]))
            .expect_err("bound");
        assert_eq!(over.kind, CodecErrorKind::ChunkCount);
    }

    #[test]
    fn an_index_that_is_not_the_expected_one_is_refused() {
        let error = reassembler()
            .push(&message(1, 1, 1, br#"{"type":"ping"}"#))
            .expect_err("index");
        assert_eq!(error.kind, CodecErrorKind::ChunkIndex);
    }

    #[test]
    fn a_gap_in_the_indexes_is_refused_and_resets() {
        let mut reassembler = reassembler();
        let payload = vec![b'x'; MIN_NONFINAL_PAYLOAD_BYTES];
        assert_eq!(
            reassembler
                .push(&message(1, 0, 3, &payload))
                .expect("first"),
            None
        );
        let error = reassembler
            .push(&message(1, 2, 3, &payload))
            .expect_err("gap");
        assert_eq!(error.kind, CodecErrorKind::ChunkIndex);
        assert!(!reassembler.is_reassembling());
    }

    #[test]
    fn a_count_that_changes_mid_frame_is_refused() {
        let mut reassembler = reassembler();
        let payload = vec![b'x'; MIN_NONFINAL_PAYLOAD_BYTES];
        assert_eq!(
            reassembler
                .push(&message(1, 0, 3, &payload))
                .expect("first"),
            None
        );
        let error = reassembler
            .push(&message(1, 1, 4, &payload))
            .expect_err("count");
        assert_eq!(error.kind, CodecErrorKind::ChunkCount);
    }

    #[test]
    fn an_empty_payload_is_refused() {
        let error = reassembler()
            .push(&message(1, 0, 1, &[]))
            .expect_err("empty");
        assert_eq!(error.kind, CodecErrorKind::ChunkDribble);
    }

    #[test]
    fn a_dribbling_non_final_payload_is_refused_but_the_minimum_is_accepted() {
        let error = reassembler()
            .push(&message(
                1,
                0,
                2,
                &vec![b'x'; MIN_NONFINAL_PAYLOAD_BYTES - 1],
            ))
            .expect_err("dribble");
        assert_eq!(error.kind, CodecErrorKind::ChunkDribble);
        assert_eq!(
            reassembler()
                .push(&message(1, 0, 2, &vec![b'x'; MIN_NONFINAL_PAYLOAD_BYTES]))
                .expect("minimum"),
            None
        );
    }

    #[test]
    fn a_final_payload_below_the_minimum_is_accepted() {
        let line = encode_frame_bytes(&Frame::Ping, DEFAULT_MAX_FRAME_BYTES).expect("encodes");
        assert!(line.len() < MIN_NONFINAL_PAYLOAD_BYTES);
        assert_eq!(
            reassembler().push(&message(1, 0, 1, &line)).expect("final"),
            Some(Frame::Ping)
        );
    }

    #[test]
    fn accumulating_past_the_frame_limit_is_refused_as_soon_as_it_happens() {
        let mut reassembler = ChunkReassembler::new(MIN_MAX_MESSAGE_BYTES, MIN_MAX_FRAME_BYTES);
        let payload = vec![b'x'; MIN_MAX_MESSAGE_BYTES - CHUNK_HEADER_BYTES];
        assert_eq!(
            reassembler
                .push(&message(1, 0, 3, &payload))
                .expect("first"),
            None
        );
        assert_eq!(
            reassembler
                .push(&message(1, 1, 3, &payload))
                .expect("second"),
            None
        );
        let error = reassembler
            .push(&message(1, 2, 3, &payload))
            .expect_err("limit");
        assert_eq!(error.kind, CodecErrorKind::TooLarge);
        assert!(!reassembler.is_reassembling());
    }

    #[test]
    fn a_reassembled_line_that_is_not_a_frame_is_a_schema_refusal() {
        let error = reassembler()
            .push(&message(1, 0, 1, br#"{"type":"nope"}"#))
            .expect_err("schema");
        assert_eq!(error.kind, CodecErrorKind::Schema);
    }

    #[test]
    fn a_frame_split_across_chunks_survives_a_multibyte_boundary() {
        let frame = Frame::Req(Request {
            id: "r".into(),
            method: "text.echo".into(),
            params: Value::String("🥭".repeat(2000)),
        });
        let messages =
            encode_chunks(&frame, MIN_MAX_MESSAGE_BYTES, DEFAULT_MAX_FRAME_BYTES).expect("encodes");
        let mut reassembler = ChunkReassembler::new(MIN_MAX_MESSAGE_BYTES, DEFAULT_MAX_FRAME_BYTES);
        let mut decoded = None;
        for chunk in &messages {
            decoded = reassembler.push(chunk).expect("accepts");
        }
        assert_eq!(decoded, Some(frame));
    }
}
