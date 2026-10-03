//! Lossy UTF-8 decoding of a byte buffer the caller already owns — the
//! `Buffer#toString('utf8')` result without the copy
//! `String::from_utf8_lossy(&bytes).into_owned()` always makes.

/// The valid prefix of an invalid buffer is kept in place only while it is
/// at least `1 / (PREFIX_REUSE_RATIO + 1)` of the buffer, that is while
/// `valid * PREFIX_REUSE_RATIO >= invalid_tail`. Below that the prefix saves
/// less than reusing it costs, see [`lossy_string_from_bytes`].
const PREFIX_REUSE_RATIO: usize = 4;

/// Decodes an owned buffer as UTF-8, replacing each invalid sequence with
/// U+FFFD exactly as [`String::from_utf8_lossy`] does.
///
/// Valid input, the usual case for file contents and child-process output,
/// becomes the `String` in place: validation is one scan, and the buffer's
/// allocation and capacity are reused rather than copied.
///
/// Invalid input first fails that scan at the first bad byte, then takes one
/// of two paths, chosen by how much of the buffer was valid:
///
/// - Mostly valid (the prefix is at least a fifth of the buffer, typically a
///   character cut by a byte cap at the very end): only the bytes from the
///   first invalid one onwards are decoded lossily into a small `String`.
///   The valid prefix then stays in the original allocation, but the safe
///   API has no way to turn it back into a `String` without validating it
///   again, so the prefix is scanned twice in total. In exchange it is not
///   copied unless the buffer must grow, and it grows by exactly the
///   decoded tail instead of doubling. The result keeps the buffer's spare
///   capacity when that already fits the tail.
/// - Mostly invalid (invalid start, dense invalid bytes): reusing a short
///   prefix saves almost nothing and costs a second allocation for a large
///   tail plus a regrow of the buffer, which measured up to 1.6 times the
///   plain [`String::from_utf8_lossy`] decode, with up to 1.7 times its
///   requested bytes. These buffers are decoded from scratch instead, which is the
///   old helper's cost and ownership: the input buffer is dropped.
///
/// Measured on Rust 1.97 and 1.99 with 4 KiB to 2 MiB buffers (the 16 KiB
/// winget stdout and 256 KiB auth-config caps included), as a ratio of the
/// plain [`String::from_utf8_lossy`] decode: valid input skips the decode
/// allocation, a truncated tail or a late invalid byte costs about 0.25 to
/// 0.4 times, and invalid-start and dense-invalid input is near 1.0 times.
/// These are helper timings, not filesystem or vendor latency. A
/// `String::from_utf8_lossy_owned` helper needs its own measurement against
/// this one before any switch; this helper makes no promise about it.
///
/// `lossy_string_from_bytes(b"a\xFFb".to_vec())` is `"a\u{FFFD}b"`.
#[must_use]
pub(crate) fn lossy_string_from_bytes(bytes: Vec<u8>) -> String {
    let error = match String::from_utf8(bytes) {
        Ok(text) => return text,
        Err(error) => error,
    };
    let valid = error.utf8_error().valid_up_to();
    let mut bytes = error.into_bytes();
    if valid.saturating_mul(PREFIX_REUSE_RATIO) < bytes.len() - valid {
        return String::from_utf8_lossy(&bytes).into_owned();
    }
    let tail = String::from_utf8_lossy(&bytes[valid..]).into_owned();
    bytes.truncate(valid);
    match String::from_utf8(bytes) {
        Ok(mut text) => {
            text.reserve_exact(tail.len());
            text.push_str(&tail);
            text
        }
        // Unreachable: `valid_up_to` bounds a valid prefix. Decoding it
        // lossily anyway keeps this path total without a panic.
        Err(error) => String::from_utf8_lossy(error.as_bytes()).into_owned() + &tail,
    }
}

#[cfg(test)]
mod tests {
    use super::lossy_string_from_bytes;

    fn assert_matches_std(input: &[u8]) {
        let expected = String::from_utf8_lossy(input).into_owned();
        let received = lossy_string_from_bytes(input.to_vec());
        assert_eq!(
            received, expected,
            "expected the std lossy decoding of {input:?}: {expected:?} | received: {received:?}"
        );
    }

    #[test]
    fn valid_ascii_and_multi_byte_input_decodes_unchanged() {
        assert_eq!(
            lossy_string_from_bytes(b"node v24.1.0\n".to_vec()),
            "node v24.1.0\n"
        );
        let multi_byte = "manga \u{e7}\u{e3}o \u{6f22}\u{5b57} \u{1F96D}";
        assert_eq!(
            lossy_string_from_bytes(multi_byte.as_bytes().to_vec()),
            multi_byte
        );
    }

    #[test]
    fn empty_input_decodes_to_an_empty_string() {
        assert_eq!(lossy_string_from_bytes(Vec::new()), "");
    }

    #[test]
    fn invalid_sequences_are_replaced_exactly_as_from_utf8_lossy_replaces_them() {
        assert_eq!(
            lossy_string_from_bytes(b"a\xFFb".to_vec()),
            "a\u{FFFD}b",
            "expected one replacement character for the invalid byte between a and b"
        );
        let cases: [&[u8]; 19] = [
            b"\xFF",
            // An invalid byte at the start, in the middle and at the end.
            b"\xFFstart",
            b"a\xFFb",
            b"end\xFF",
            // A multi-byte character cut at the end of a bounded read, at
            // each possible length.
            b"caf\xC3",
            b"\xE6\xBC",
            b"text \xE6",
            b"text \xF0\x9F\xA5",
            // A truncated four-byte lead followed by valid text: one
            // replacement per maximal subpart.
            b"\xF0\x9F\xA5ok",
            // Consecutive invalid bytes, alone and between valid text.
            b"\xFF\xFE\xFD",
            b"a\x80\x80\x80b",
            b"a\xFF\xFFb\xFF\xFFc",
            // An invalid byte right after a multi-byte character, and
            // between two of them.
            b"\xE6\xBC\xA2\xFF",
            b"\xE6\xBC\xA2\xFF\xE5\xAD\x97",
            b"\xF0\x9F\xA5\xAD\x80tail",
            // Overlong encoding and a UTF-16 surrogate half.
            b"\xC0\xAF",
            b"\xED\xA0\x80",
            // Several separate invalid runs after a valid prefix.
            b"ok \xE6\xBC\xA2 \x80\x80 tail \xF4\x90\x80\x80",
            b"valid \xC3\xA7 then \xFF and \xE6\xBC cut \xC3",
        ];
        for input in cases {
            assert_matches_std(input);
        }
    }

    #[test]
    fn every_short_byte_string_decodes_exactly_as_from_utf8_lossy_decodes_it() {
        // Bytes chosen to cover ASCII, continuation bytes and every lead
        // length, in all arrangements up to four bytes long.
        let alphabet = [b'a', 0x80, 0xBC, 0xC3, 0xE6, 0xF0, 0xFF];
        let mut inputs: Vec<Vec<u8>> = vec![Vec::new()];
        for _ in 0..4 {
            let longer: Vec<Vec<u8>> = inputs
                .iter()
                .flat_map(|input| {
                    alphabet.iter().map(move |byte| {
                        let mut next = input.clone();
                        next.push(*byte);
                        next
                    })
                })
                .collect();
            for input in &longer {
                assert_matches_std(input);
            }
            inputs = longer;
        }
    }

    #[test]
    fn decoding_matches_std_on_both_sides_of_the_prefix_reuse_boundary() {
        // `p` valid bytes, one invalid byte, then `t` valid bytes: the
        // invalid tail is `t + 1` long, so the boundary sits near
        // `4 * p == t + 1`, and every neighbour of it is covered.
        for prefix in 0..12usize {
            for suffix in 0..60usize {
                let mut input = vec![b'a'; prefix];
                input.push(0xFF);
                input.extend(std::iter::repeat_n(b'b', suffix));
                assert_matches_std(&input);
            }
        }
    }

    #[test]
    fn a_mostly_invalid_buffer_decodes_exactly_as_from_utf8_lossy_decodes_it() {
        let mut bytes = Vec::with_capacity(256);
        bytes.extend_from_slice(b"ab");
        bytes.extend(std::iter::repeat_n(0xFFu8, 100));
        let expected = String::from_utf8_lossy(&bytes).into_owned();

        let text = lossy_string_from_bytes(bytes);

        assert_eq!(
            text, expected,
            "expected the std lossy decoding {expected:?} | received: {text:?}"
        );
    }

    #[test]
    fn a_cut_tail_grows_the_buffer_by_the_tail_not_by_doubling() {
        let mut bytes = Vec::with_capacity(4_096);
        bytes.extend(std::iter::repeat_n(b'a', 4_096));
        bytes.pop();
        bytes.push(0xE6);
        let input_len = bytes.len();

        let text = lossy_string_from_bytes(bytes);

        assert_eq!(text.len(), input_len - 1 + '\u{FFFD}'.len_utf8());
        assert!(
            text.capacity() < 2 * input_len,
            "expected the capacity to grow by the 3-byte replacement, not double | received: \
             {} for a {input_len}-byte input",
            text.capacity()
        );
    }

    #[test]
    fn invalid_input_keeps_its_valid_prefix_in_the_buffer_allocation() {
        let mut bytes = Vec::with_capacity(64);
        bytes.extend_from_slice(b"prefix \xE6\xBC\xA2 cut \xE6");
        let buffer = bytes.as_ptr();

        let text = lossy_string_from_bytes(bytes);

        assert_eq!(text, "prefix \u{6f22} cut \u{FFFD}");
        assert!(
            std::ptr::eq(text.as_ptr(), buffer),
            "expected the valid prefix to stay in its buffer allocation {buffer:p} | received: a copy at {:p}",
            text.as_ptr()
        );
    }

    #[test]
    fn valid_input_reuses_the_buffer_allocation() {
        let mut bytes = Vec::with_capacity(64);
        bytes.extend_from_slice("reused \u{6f22}".as_bytes());
        let buffer = bytes.as_ptr();
        let capacity = bytes.capacity();

        let text = lossy_string_from_bytes(bytes);

        assert!(
            std::ptr::eq(text.as_ptr(), buffer),
            "expected valid UTF-8 to keep its buffer allocation {buffer:p} | received: a copy at {:p}",
            text.as_ptr()
        );
        assert_eq!(
            text.capacity(),
            capacity,
            "expected the buffer capacity to carry over to the string"
        );
    }
}
