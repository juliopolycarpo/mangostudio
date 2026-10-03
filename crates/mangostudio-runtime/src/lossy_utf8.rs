//! Lossy UTF-8 decoding of a byte buffer the caller already owns — the
//! `Buffer#toString('utf8')` result without the copy
//! `String::from_utf8_lossy(&bytes).into_owned()` always makes.

/// Decodes an owned buffer as UTF-8, replacing each invalid sequence with
/// U+FFFD exactly as [`String::from_utf8_lossy`] does.
///
/// Valid input, the usual case for file contents and child-process output,
/// becomes the `String` in place: the buffer's allocation is reused rather
/// than copied. Invalid input keeps its valid prefix in place too, and only
/// the bytes from the first invalid one onwards are decoded lossily and
/// appended, so a character cut by a byte cap at the very end costs a few
/// bytes of work rather than a second pass over the whole buffer. Any spare
/// capacity of `bytes` is kept by the result.
///
/// `String::from_utf8_lossy_owned` replaces this helper once the workspace
/// minimum Rust version reaches 1.99.
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
    let tail = String::from_utf8_lossy(&bytes[valid..]).into_owned();
    bytes.truncate(valid);
    match String::from_utf8(bytes) {
        Ok(mut text) => {
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
