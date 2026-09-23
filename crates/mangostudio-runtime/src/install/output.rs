//! Turning raw installer bytes into the lines `install.output` carries.
//!
//! Mirrors the `capture`/`readStream` pair in `apps/runtime/src/services/install.ts`: one byte
//! limit shared by both pipes, and one streaming UTF-8 decoder per pipe that splits on `\n`.

/// The combined capture limit across stdout and stderr (`outputLimitBytes`).
#[derive(Debug)]
pub(crate) struct OutputLimit {
    limit: usize,
    label: String,
    captured: usize,
    truncated: bool,
    reported: bool,
}

impl OutputLimit {
    /// A limit of `limit` bytes, announced as `label` in the truncation notice.
    ///
    /// # Example
    ///
    /// ```ignore
    /// let mut limit = OutputLimit::new(4, "4".into());
    /// assert_eq!(limit.accept(b"0123456789"), b"0123");
    /// ```
    pub(crate) fn new(limit: usize, label: String) -> Self {
        Self {
            limit,
            label,
            captured: 0,
            truncated: false,
            reported: false,
        }
    }

    /// The prefix of `bytes` that still fits; anything beyond marks the run truncated.
    pub(crate) fn accept<'a>(&mut self, bytes: &'a [u8]) -> &'a [u8] {
        let remaining = self.limit.saturating_sub(self.captured);
        let accepted = &bytes[..bytes.len().min(remaining)];
        self.captured += accepted.len();
        if accepted.len() < bytes.len() {
            self.truncated = true;
        }
        accepted
    }

    /// The one-time `system` notice, the first time it is asked for after truncation.
    pub(crate) fn take_notice(&mut self) -> Option<String> {
        if !self.truncated || self.reported {
            return None;
        }
        self.reported = true;
        Some(format!("Output truncated after {} bytes.", self.label))
    }

    /// Whether any byte was dropped.
    pub(crate) fn truncated(&self) -> bool {
        self.truncated
    }
}

/// A streaming `TextDecoder` (UTF-8, non-fatal, BOM-stripping) followed by a `\n` splitter.
#[derive(Debug, Default)]
pub(crate) struct LineDecoder {
    pending_bytes: Vec<u8>,
    pending_text: String,
    started: bool,
}

impl LineDecoder {
    /// Decodes `bytes` and returns every line it completed, without a trailing `\r`.
    ///
    /// # Example
    ///
    /// ```ignore
    /// let mut decoder = LineDecoder::default();
    /// assert_eq!(decoder.push(b"a\r\nb"), vec!["a".to_string()]);
    /// assert_eq!(decoder.finish(), Some("b".to_string()));
    /// ```
    pub(crate) fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        let text = self.decode(bytes);
        self.pending_text.push_str(&text);
        let mut lines = Vec::new();
        while let Some(index) = self.pending_text.find('\n') {
            let mut line: String = self.pending_text.drain(..=index).collect();
            line.pop();
            if line.ends_with('\r') {
                line.pop();
            }
            lines.push(line);
        }
        lines
    }

    /// Flushes the decoder at EOF and returns the unterminated tail, if any, verbatim.
    pub(crate) fn finish(&mut self) -> Option<String> {
        if !self.pending_bytes.is_empty() {
            self.pending_bytes.clear();
            self.pending_text.push('\u{FFFD}');
        }
        let tail = std::mem::take(&mut self.pending_text);
        (!tail.is_empty()).then_some(tail)
    }

    /// WHATWG streaming decode: invalid maximal subparts become U+FFFD, an incomplete trailing
    /// sequence waits for the next chunk, and a leading BOM is dropped once per stream.
    fn decode(&mut self, bytes: &[u8]) -> String {
        let mut buffer = std::mem::take(&mut self.pending_bytes);
        buffer.extend_from_slice(bytes);
        let mut decoded = String::new();
        let mut rest = buffer.as_slice();
        while !rest.is_empty() {
            match std::str::from_utf8(rest) {
                Ok(text) => {
                    decoded.push_str(text);
                    rest = &[];
                }
                Err(error) => {
                    let (valid, after) = rest.split_at(error.valid_up_to());
                    decoded.push_str(std::str::from_utf8(valid).expect("validated prefix"));
                    match error.error_len() {
                        Some(invalid) => {
                            decoded.push('\u{FFFD}');
                            rest = &after[invalid..];
                        }
                        None => {
                            self.pending_bytes = after.to_vec();
                            rest = &[];
                        }
                    }
                }
            }
        }
        if !self.started && !decoded.is_empty() {
            self.started = true;
            if let Some(stripped) = decoded.strip_prefix('\u{FEFF}') {
                return stripped.to_owned();
            }
        }
        decoded
    }
}

#[cfg(test)]
mod tests {
    use super::{LineDecoder, OutputLimit};

    fn lines(chunks: &[&[u8]]) -> Vec<String> {
        let mut decoder = LineDecoder::default();
        let mut lines: Vec<String> = chunks
            .iter()
            .flat_map(|chunk| decoder.push(chunk))
            .collect();
        lines.extend(decoder.finish());
        lines
    }

    #[test]
    fn lines_split_on_newline_and_drop_one_trailing_carriage_return() {
        assert_eq!(
            lines(&[b"hello\nworld\r\n\r\r\nlast"]),
            vec!["hello", "world", "\r", "last"],
            "expected LF splitting, one CR stripped per line, and the tail flushed"
        );
    }

    #[test]
    fn an_unterminated_tail_is_flushed_verbatim_including_its_carriage_return() {
        assert_eq!(lines(&[b"tail\r"]), vec!["tail\r"]);
        assert_eq!(lines(&[b"done\n"]), vec!["done"]);
        assert_eq!(lines(&[b""]), Vec::<String>::new());
    }

    #[test]
    fn a_multibyte_character_split_across_chunks_is_reassembled() {
        let text = "caf\u{e9} \u{1F96D}\n".as_bytes();
        let chunks: Vec<&[u8]> = text.chunks(1).collect();
        assert_eq!(
            lines(&chunks),
            vec!["caf\u{e9} \u{1F96D}"],
            "expected byte-at-a-time chunks to decode like one chunk"
        );
    }

    #[test]
    fn invalid_bytes_become_replacement_characters_and_a_cut_tail_flushes_as_one() {
        assert_eq!(lines(&[b"a\xffb\n"]), vec!["a\u{FFFD}b"]);
        assert_eq!(lines(&[b"x\xe2\x82"]), vec!["x\u{FFFD}"]);
    }

    #[test]
    fn a_leading_bom_is_stripped_once_per_stream_even_when_split() {
        assert_eq!(
            lines(&[b"\xef", b"\xbb\xbfhi\n\xef\xbb\xbfagain\n"]),
            vec!["hi", "\u{FEFF}again"]
        );
    }

    /// TS: "caps captured output while continuing to a terminal result".
    #[test]
    fn the_limit_is_shared_across_chunks_and_announced_once() {
        let mut limit = OutputLimit::new(4, "4".into());
        assert_eq!(limit.take_notice(), None);
        assert_eq!(limit.accept(b"01"), b"01");
        assert!(!limit.truncated());
        assert_eq!(limit.accept(b"2345"), b"23");
        assert!(limit.truncated());
        assert_eq!(
            limit.take_notice().as_deref(),
            Some("Output truncated after 4 bytes.")
        );
        assert_eq!(limit.accept(b"6"), b"");
        assert_eq!(limit.take_notice(), None, "expected the notice only once");
    }

    #[test]
    fn a_chunk_that_exactly_fills_the_limit_is_not_truncated() {
        let mut limit = OutputLimit::new(3, "3".into());
        assert_eq!(limit.accept(b"abc"), b"abc");
        assert!(!limit.truncated());
        assert_eq!(limit.accept(b""), b"");
        assert!(!limit.truncated());
    }
}
