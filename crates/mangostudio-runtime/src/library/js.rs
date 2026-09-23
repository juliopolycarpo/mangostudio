//! The handful of ECMAScript string and number semantics the TypeScript
//! library readers lean on implicitly, spelled out so the Rust port computes
//! byte-identical hashes, titles and orderings.
//!
//! Each helper names the exact JavaScript operation it reproduces. None of
//! them is a general-purpose JS engine; they cover precisely what
//! `apps/shared/src/library/` and `apps/shared/src/markdown/` call.

use std::cmp::Ordering;

/// Whether `c` is in ECMAScript's `WhiteSpace` or `LineTerminator` sets —
/// the characters `String.prototype.trim` strips and the regex class `\s`
/// matches. Differs from [`char::is_whitespace`]: U+FEFF is included and
/// U+0085 (NEL) is not.
#[must_use]
pub(crate) fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `String.prototype.trim`.
#[must_use]
pub(crate) fn js_trim(value: &str) -> &str {
    value.trim_matches(is_js_whitespace)
}

/// `value.replaceAll(/\s+/g, '')`.
#[must_use]
pub(crate) fn strip_js_whitespace(value: &str) -> String {
    value.chars().filter(|c| !is_js_whitespace(*c)).collect()
}

/// JavaScript's default string ordering (`<`, `Array.prototype.sort` with no
/// comparator): UTF-16 code units, which differs from `str`'s UTF-8 byte
/// order once a supplementary-plane character meets U+E000..U+FFFF.
#[must_use]
pub(crate) fn cmp_utf16(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// `string.length`: UTF-16 code units, not bytes or scalar values.
#[must_use]
pub(crate) fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// `new TextDecoder().decode(bytes)`: lossy UTF-8 with maximal-subpart
/// replacement, and one leading byte-order mark removed (`ignoreBOM` is
/// false by default).
#[must_use]
pub(crate) fn text_decoder_decode(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

/// `Buffer.prototype.toString('utf8')`: the same lossy decode as
/// [`text_decoder_decode`], but a leading byte-order mark survives as
/// U+FEFF.
#[must_use]
pub(crate) fn buffer_to_utf8_string(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// `Number(raw)` when it is finite, else `None` — the check
/// `parseFrontmatterScalar` makes before treating a scalar as a number.
/// `raw` is trimmed first, as `StringToNumber` does.
#[must_use]
pub(crate) fn js_finite_number(raw: &str) -> Option<f64> {
    let text = js_trim(raw);
    let value = if text.is_empty() {
        0.0
    } else if let Some(value) = parse_non_decimal(text) {
        value
    } else if is_decimal_literal(text) {
        text.parse::<f64>().ok()?
    } else {
        return None;
    };
    value.is_finite().then_some(value)
}

/// `0x`/`0o`/`0b` integer literals. `StringToNumber` accepts no sign on
/// these, so `-0x10` is `NaN`.
fn parse_non_decimal(text: &str) -> Option<f64> {
    let bytes = text.as_bytes();
    if bytes.len() < 3 || bytes[0] != b'0' {
        return None;
    }
    let radix = match bytes[1] {
        b'x' | b'X' => 16,
        b'o' | b'O' => 8,
        b'b' | b'B' => 2,
        _ => return None,
    };
    let digits = &text[2..];
    if !digits.chars().all(|c| c.is_digit(radix)) {
        return None;
    }
    // Exact while it fits; beyond u128 the value is astronomically outside
    // anything a frontmatter title carries, so a float accumulation's
    // rounding is immaterial.
    match u128::from_str_radix(digits, radix) {
        #[allow(clippy::cast_precision_loss)]
        Ok(value) => Some(value as f64),
        Err(_) => Some(digits.chars().fold(0.0, |total, c| {
            total * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
        })),
    }
}

/// `StrDecimalLiteral`: an optional sign, digits with at most one `.` and at
/// least one digit, and an optional exponent. `Infinity` is left out on
/// purpose — it is never finite, so the caller's answer is `None` either
/// way — and Rust's own `inf`/`nan` spellings must not slip through
/// [`str::parse`].
fn is_decimal_literal(text: &str) -> bool {
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
    let (mantissa, exponent) = match unsigned.find(['e', 'E']) {
        Some(index) => (&unsigned[..index], Some(&unsigned[index + 1..])),
        None => (unsigned, None),
    };
    let mut parts = mantissa.splitn(2, '.');
    let whole = parts.next().unwrap_or("");
    let fraction = parts.next().unwrap_or("");
    let digits_only = |part: &str| part.bytes().all(|b| b.is_ascii_digit());
    if !digits_only(whole) || !digits_only(fraction) || whole.len() + fraction.len() == 0 {
        return false;
    }
    exponent.is_none_or(|exponent| {
        let digits = exponent.strip_prefix(['+', '-']).unwrap_or(exponent);
        !digits.is_empty() && digits_only(digits)
    })
}

/// `String(value)` for a finite number — ECMAScript's `Number::toString`,
/// shortest round-trip digits laid out per its exponent thresholds
/// (`1e21` prints `1e+21`, `1e-7` prints `1e-7`, `-0` prints `0`).
#[must_use]
pub(crate) fn js_number_to_string(value: f64) -> String {
    if value == 0.0 {
        return "0".to_string();
    }
    if value.is_nan() {
        return "NaN".to_string();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    if value < 0.0 {
        return format!("-{}", js_number_to_string(-value));
    }
    // `{:e}` prints the shortest round-trip digits as `d[.ddd]e<exp>`.
    let scientific = format!("{value:e}");
    let (mantissa, exponent) = scientific
        .split_once('e')
        .expect("LowerExp output always carries an exponent");
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let exponent: i32 = exponent.parse().expect("LowerExp exponent is an integer");
    let k = i32::try_from(digits.len()).expect("a double has at most 17 significant digits");
    let n = exponent + 1;
    if k <= n && n <= 21 {
        return format!(
            "{digits}{}",
            "0".repeat(usize::try_from(n - k).unwrap_or(0))
        );
    }
    if 0 < n && n <= 21 {
        let split = usize::try_from(n).unwrap_or(0);
        return format!("{}.{}", &digits[..split], &digits[split..]);
    }
    if -6 < n && n <= 0 {
        return format!("0.{}{digits}", "0".repeat(usize::try_from(-n).unwrap_or(0)));
    }
    let sign = if n - 1 < 0 { '-' } else { '+' };
    let magnitude = (n - 1).abs();
    if k == 1 {
        return format!("{digits}e{sign}{magnitude}");
    }
    format!("{}.{}e{sign}{magnitude}", &digits[..1], &digits[1..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_whitespace_matches_the_ecmascript_sets_not_unicode_white_space() {
        assert!(
            is_js_whitespace('\u{FEFF}'),
            "U+FEFF is ECMAScript WhiteSpace"
        );
        assert!(
            !is_js_whitespace('\u{85}'),
            "U+0085 is not ECMAScript WhiteSpace"
        );
        assert_eq!(js_trim("\u{FEFF}\u{A0} x \u{3000}"), "x");
        assert_eq!(strip_js_whitespace("a\u{2028}b\tc\u{85}"), "abc\u{85}");
    }

    #[test]
    fn utf16_order_differs_from_utf8_order_across_the_surrogate_range() {
        // U+FF01 is one code unit 0xFF01; U+1F600 starts with 0xD83D.
        assert_eq!(cmp_utf16("\u{1F600}", "\u{FF01}"), Ordering::Less);
        assert_eq!("\u{1F600}".cmp("\u{FF01}"), Ordering::Greater);
        assert_eq!(utf16_len("\u{1F600}a"), 3);
    }

    #[test]
    fn decoders_differ_only_in_what_they_do_with_a_leading_bom() {
        assert_eq!(text_decoder_decode(b"\xEF\xBB\xBFhi"), "hi");
        assert_eq!(buffer_to_utf8_string(b"\xEF\xBB\xBFhi"), "\u{FEFF}hi");
        assert_eq!(text_decoder_decode(b"a\xFFb"), "a\u{FFFD}b");
    }

    #[test]
    fn number_parsing_follows_string_to_number() {
        let cases: [(&str, Option<f64>); 12] = [
            ("007", Some(7.0)),
            ("0x1f", Some(31.0)),
            ("0B101", Some(5.0)),
            ("-0x10", None),
            ("5.", Some(5.0)),
            (".5", Some(0.5)),
            (".", None),
            ("1e999", None),
            ("Infinity", None),
            ("inf", None),
            ("1_000", None),
            ("+1e3", Some(1000.0)),
        ];
        for (raw, expected) in cases {
            assert_eq!(
                js_finite_number(raw),
                expected,
                "Number({raw:?}): expected {expected:?} | received {:?}",
                js_finite_number(raw)
            );
        }
    }

    #[test]
    fn number_formatting_follows_number_to_string() {
        let cases = [
            (1000.0, "1000"),
            (1e21, "1e+21"),
            (1e-7, "1e-7"),
            (1.5e300, "1.5e+300"),
            (0.000_001, "0.000001"),
            (123_456_789_012_345_680_000.0, "123456789012345680000"),
            (-0.0, "0"),
            (0.1, "0.1"),
            (-2.5, "-2.5"),
        ];
        for (value, expected) in cases {
            assert_eq!(
                js_number_to_string(value),
                expected,
                "String({value:e}): expected {expected} | received {}",
                js_number_to_string(value)
            );
        }
    }
}
