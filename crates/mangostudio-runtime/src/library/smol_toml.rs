//! TOML validity as `smol-toml` (the TypeScript host's parser) decides it,
//! built on the `toml` crate rather than a second TOML implementation.
//!
//! Both parsers speak TOML 1.1, so inline-table newlines and trailing commas,
//! `\e` and `\xHH` escapes, and times without seconds agree already. They
//! disagree in two places:
//!
//! - **Bare scalars.** `smol-toml` reads an integer through `Number()` and
//!   refuses one outside `Number.isSafeInteger`; reads a float the same way,
//!   so `1e1000` is `Infinity`, not an error; and hands every date or time to
//!   Bun's `Date`, which rolls `1979-02-30` over to March, refuses a `:60`
//!   leap second, accepts `07:32Z`, `1979-05-27Z` and `1979-05-27 Z`, and
//!   reads `1979-01-0007:32Z` through its legacy fallback. [`smol_scalar`]
//!   ports that decision for each bare scalar; one `smol-toml` refuses makes
//!   the document invalid, and one it accepts but the `toml` crate would not
//!   is swapped for an equivalent the `toml` crate accepts before the
//!   structural parse. A bare scalar is never a string, so the swap cannot
//!   change a title or description. These date rules are what
//!   `apps/runtime/scripts/generate-library-fixtures.ts` recorded from Bun,
//!   not rules of the TOML specification.
//! - **Nesting.** `smol-toml` accepts any depth of dotted keys and table
//!   headers and 999 levels of arrays and inline tables; the `toml` crate
//!   stops at 80 and, unbounded, would recurse once per level. Neither limit
//!   is closed: both hosts narrow validity instead, refusing a document whose
//!   parsed value nests more than [`TOML_NESTING_LIMIT`] containers below
//!   the root (`apps/shared/src/library/machine/toml-nesting.ts` on the
//!   TypeScript side). The limit sits under the `toml` crate's guard, so that
//!   guard never decides a verdict on its own.

use toml_parser::parser::{EventReceiver, parse_document};
use toml_parser::{ErrorSink, Source, Span};

/// The deepest container a TOML document may hold, the root table being
/// depth 0 — `TOML_NESTING_LIMIT` in `toml-nesting.ts`.
pub(crate) const TOML_NESTING_LIMIT: usize = 64;

/// `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: u128 = (1 << 53) - 1;

/// A bare date or time `smol-toml` accepts, rewritten to one the `toml` crate
/// accepts too.
const ACCEPTED_DATE: &str = "1979-05-27";

/// Parses `text` into a table when `smol-toml` would and it nests no deeper
/// than [`TOML_NESTING_LIMIT`]; `None` otherwise.
///
/// # Example
///
/// ```ignore
/// assert!(parse_like_smol_toml("a = 1979-02-30").is_some());
/// assert!(parse_like_smol_toml("a = 9007199254740992").is_none());
/// ```
#[must_use]
pub(crate) fn parse_like_smol_toml(text: &str) -> Option<toml::Table> {
    let tokens = Source::new(text).lex().into_vec();
    let mut scan = BareScalars::default();
    parse_document(&tokens, &mut scan, &mut ());
    if scan.too_deep {
        return None;
    }
    let mut adjusted = String::with_capacity(text.len());
    let mut copied = 0;
    for span in scan.spans {
        let raw = &text[span.start()..span.end()];
        let replacement = match smol_scalar(raw) {
            SmolScalar::Refused => return None,
            SmolScalar::Accepted => continue,
            SmolScalar::AcceptedAs(replacement) => replacement,
        };
        adjusted.push_str(&text[copied..span.start()]);
        adjusted.push_str(replacement);
        copied = span.end();
    }
    adjusted.push_str(&text[copied..]);
    let table: toml::Table = adjusted.parse().ok()?;
    within_nesting_limit(&table).then_some(table)
}

/// Whether no container in `table` sits deeper than [`TOML_NESTING_LIMIT`].
/// The `toml` crate's own guard caps the recursion here.
fn within_nesting_limit(table: &toml::Table) -> bool {
    fn fits(value: &toml::Value, depth: usize) -> bool {
        let children: Box<dyn Iterator<Item = &toml::Value>> = match value {
            toml::Value::Table(table) => Box::new(table.values()),
            toml::Value::Array(items) => Box::new(items.iter()),
            _ => return true,
        };
        depth <= TOML_NESTING_LIMIT && children.into_iter().all(|child| fits(child, depth + 1))
    }
    table.values().all(|value| fits(value, 1))
}

/// Collects the span of every bare (unquoted) scalar, and refuses to descend
/// into arrays or inline tables nested past [`TOML_NESTING_LIMIT`]: each is a
/// container under the root, so the document is too deep either way, and the
/// event parser's recursion stays bounded.
#[derive(Default)]
struct BareScalars {
    depth: usize,
    too_deep: bool,
    spans: Vec<Span>,
}

impl BareScalars {
    /// Enters a container; `false` tells the parser to skip its contents,
    /// which it still closes with a matching close event.
    fn open(&mut self) -> bool {
        self.depth += 1;
        let within = self.depth <= TOML_NESTING_LIMIT;
        self.too_deep |= !within;
        within
    }

    fn close(&mut self) {
        self.depth = self.depth.saturating_sub(1);
    }
}

impl EventReceiver for BareScalars {
    fn array_open(&mut self, _span: Span, _error: &mut dyn ErrorSink) -> bool {
        self.open()
    }

    fn array_close(&mut self, _span: Span, _error: &mut dyn ErrorSink) {
        self.close();
    }

    fn inline_table_open(&mut self, _span: Span, _error: &mut dyn ErrorSink) -> bool {
        self.open()
    }

    fn inline_table_close(&mut self, _span: Span, _error: &mut dyn ErrorSink) {
        self.close();
    }

    fn scalar(
        &mut self,
        span: Span,
        encoding: Option<toml_parser::decoder::Encoding>,
        _error: &mut dyn ErrorSink,
    ) {
        if encoding.is_none() {
            self.spans.push(span);
        }
    }
}

/// `smol-toml`'s verdict on one bare scalar.
#[derive(Debug, PartialEq, Eq)]
enum SmolScalar {
    /// `parseValue` throws.
    Refused,
    /// Accepted, and the `toml` crate agrees on the text as written.
    Accepted,
    /// Accepted; parse this text in its place, since the `toml` crate refuses
    /// the original.
    AcceptedAs(&'static str),
}

/// `parseValue` from `smol-toml`'s `primitive.js`, for an unquoted scalar.
fn smol_scalar(raw: &str) -> SmolScalar {
    if matches!(
        raw,
        "true" | "false" | "inf" | "+inf" | "-inf" | "nan" | "+nan" | "-nan" | "-0"
    ) {
        return SmolScalar::Accepted;
    }
    let integer = is_smol_integer(raw);
    if !integer && !is_smol_float(raw) {
        return if date_accepted(raw) {
            SmolScalar::AcceptedAs(ACCEPTED_DATE)
        } else {
            SmolScalar::Refused
        };
    }
    if has_leading_zero(raw) {
        return SmolScalar::Refused;
    }
    let digits = raw.replace('_', "");
    if integer {
        return if safe_integer(&digits) {
            SmolScalar::Accepted
        } else {
            SmolScalar::Refused
        };
    }
    match digits.parse::<f64>() {
        Ok(value) if value == f64::INFINITY => SmolScalar::AcceptedAs("inf"),
        Ok(value) if value == f64::NEG_INFINITY => SmolScalar::AcceptedAs("-inf"),
        Ok(_) => SmolScalar::Accepted,
        Err(_) => SmolScalar::Refused,
    }
}

/// `\d(_?\d)*` over ASCII digits of `radix`.
fn is_digit_run(text: &str, radix: u32) -> bool {
    !text.is_empty()
        && !text.starts_with('_')
        && !text.ends_with('_')
        && !text.contains("__")
        && text.chars().all(|c| c == '_' || c.is_digit(radix))
}

/// `INT_REGEX`: `0x` hex, or an optional sign or `0o`/`0b` prefix before
/// decimal digits (`0o8` matches; `Number()` then refuses it).
fn is_smol_integer(raw: &str) -> bool {
    if let Some(hex) = raw.strip_prefix("0x") {
        return is_digit_run(hex, 16);
    }
    let body = raw
        .strip_prefix(['+', '-'])
        .or_else(|| raw.strip_prefix("0o"))
        .or_else(|| raw.strip_prefix("0b"))
        .unwrap_or(raw);
    is_digit_run(body, 10)
}

/// `FLOAT_REGEX`: sign, digits, optional fraction, optional exponent.
fn is_smol_float(raw: &str) -> bool {
    let body = raw.strip_prefix(['+', '-']).unwrap_or(raw);
    let (mantissa, exponent) = match body.find(['e', 'E']) {
        Some(at) => (&body[..at], Some(&body[at + 1..])),
        None => (body, None),
    };
    let (whole, fraction) = match mantissa.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (mantissa, None),
    };
    let exponent_ok = exponent.is_none_or(|exponent| {
        is_digit_run(exponent.strip_prefix(['+', '-']).unwrap_or(exponent), 10)
    });
    is_digit_run(whole, 10) && fraction.is_none_or(|f| is_digit_run(f, 10)) && exponent_ok
}

/// `LEADING_ZERO`: `/^[+-]?0[0-9_]/`.
fn has_leading_zero(raw: &str) -> bool {
    let body = raw.strip_prefix(['+', '-']).unwrap_or(raw).as_bytes();
    body.first() == Some(&b'0')
        && body
            .get(1)
            .is_some_and(|b| b.is_ascii_digit() || *b == b'_')
}

/// `Number.isSafeInteger(+digits)` for text `is_smol_integer` matched with
/// its underscores removed; a prefix `Number()` cannot read is unsafe.
fn safe_integer(digits: &str) -> bool {
    let (radix, body) = match digits.get(..2) {
        Some("0x") => (16, &digits[2..]),
        Some("0o") => (8, &digits[2..]),
        Some("0b") => (2, &digits[2..]),
        _ => (10, digits.strip_prefix(['+', '-']).unwrap_or(digits)),
    };
    u128::from_str_radix(body, radix).is_ok_and(|value| value <= MAX_SAFE_INTEGER)
}

/// Splits `count` ASCII digits off the front of `text`.
fn take_digits(text: &str, count: usize) -> Option<(u32, &str)> {
    let digits = text.get(..count)?;
    if !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((digits.parse().ok()?, &text[count..]))
}

/// `new TomlDate(raw).isValid()`: `DATE_TIME_RE`, the hour-24 guard, then
/// what Bun's `Date` accepts for the string `TomlDate` builds from it.
fn date_accepted(raw: &str) -> bool {
    let (date, rest) = match take_date(raw) {
        Some((date, rest)) => (Some(date), rest),
        None => (None, raw),
    };
    let (separator, rest) = match rest.chars().next() {
        Some(c @ ('T' | 't' | ' ')) => (Some(c), &rest[1..]),
        _ => (None, rest),
    };
    let (time, offset) = match take_time(rest) {
        Some((valid, offset)) => (Some(valid), offset),
        None => (None, rest),
    };
    let Some(offset) = parse_offset(offset) else {
        return false;
    };
    match (date, time) {
        (Some(date), Some(time)) if separator.is_some() => date.valid() && time && offset.valid,
        // Without a separator Bun's ISO parser refuses the string, and its
        // legacy fallback reads only a `00` day glued to a time
        // (`1979-01-0007:32Z`), checking offset minutes but not hours.
        (Some(date), Some(time)) => {
            date.month_valid() && date.day == 0 && time && offset.minutes_valid
        }
        // `Date` takes `1979-05-27`, `1979-05-27Z` and `1979-05-27 Z`, not a
        // numeric offset or a dangling `T`.
        (Some(date), None) => date.valid() && separator.is_none_or(|c| c == ' ') && !offset.numeric,
        // A bare time is prefixed with `0000-01-01T`; a separator of its own
        // would double it.
        (None, Some(time)) => separator.is_none() && time && offset.valid,
        (None, None) => false,
    }
}

/// The month and day of a `\d{4}-\d{2}-\d{2}` date.
struct DateParts {
    month: u32,
    day: u32,
}

impl DateParts {
    fn month_valid(&self) -> bool {
        (1..=12).contains(&self.month)
    }

    /// What `Date` accepts: it rolls day 29–31 over past a short month's end.
    fn valid(&self) -> bool {
        self.month_valid() && (1..=31).contains(&self.day)
    }
}

/// `\d{4}-\d{2}-\d{2}` off the front of `text`.
fn take_date(text: &str) -> Option<(DateParts, &str)> {
    let (_, rest) = take_digits(text, 4)?;
    let (month, rest) = take_digits(rest.strip_prefix('-')?, 2)?;
    let (day, rest) = take_digits(rest.strip_prefix('-')?, 2)?;
    Some((DateParts { month, day }, rest))
}

/// `\d{2}:\d{2}(:\d{2}(\.\d+)?)?`, and whether `Date` accepts it (no `:60`;
/// `smol-toml` itself refuses an hour past 23).
fn take_time(text: &str) -> Option<(bool, &str)> {
    let (hour, rest) = take_digits(text, 2)?;
    let (minute, rest) = take_digits(rest.strip_prefix(':')?, 2)?;
    let Some((second, rest)) = rest.strip_prefix(':').and_then(|rest| take_digits(rest, 2)) else {
        return Some((hour <= 23 && minute <= 59, rest));
    };
    let rest = match rest.strip_prefix('.') {
        Some(fraction) => {
            let end = fraction
                .find(|c: char| !c.is_ascii_digit())
                .unwrap_or(fraction.len());
            if end == 0 {
                return None;
            }
            &fraction[end..]
        }
        None => rest,
    };
    Some((hour <= 23 && minute <= 59 && second <= 59, rest))
}

/// The offset that ends a `DATE_TIME_RE` match.
struct Offset {
    numeric: bool,
    valid: bool,
    minutes_valid: bool,
}

/// `(Z|[-+]\d{2}:\d{2})?` followed by the end of the scalar.
fn parse_offset(text: &str) -> Option<Offset> {
    if text.is_empty() || text.eq_ignore_ascii_case("z") {
        return Some(Offset {
            numeric: false,
            valid: true,
            minutes_valid: true,
        });
    }
    let (hours, rest) = take_digits(text.strip_prefix(['+', '-'])?, 2)?;
    let (minutes, rest) = take_digits(rest.strip_prefix(':')?, 2)?;
    rest.is_empty().then_some(Offset {
        numeric: true,
        valid: hours <= 23 && minutes <= 59,
        minutes_valid: minutes <= 59,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_scalar(raw: &str, expected: &SmolScalar) {
        let received = smol_scalar(raw);
        assert_eq!(
            &received, expected,
            "expected smol-toml verdict for {raw:?}: {expected:?} | received: {received:?}"
        );
    }

    #[test]
    fn integers_follow_number_is_safe_integer() {
        for raw in [
            "9007199254740991",
            "-9007199254740991",
            "0x1F",
            "0o17",
            "0b101",
            "1_000",
        ] {
            assert_scalar(raw, &SmolScalar::Accepted);
        }
        for raw in [
            "9007199254740992",
            "-9007199254740992",
            "0x20000000000000",
            "0o8",
            "0b2",
        ] {
            assert_scalar(raw, &SmolScalar::Refused);
        }
    }

    #[test]
    fn leading_zeroes_and_malformed_numbers_are_refused() {
        for raw in [
            "03", "+03", "0_1", "1_", "1__0", "-0x1", "+0x1", "1.", ".1", "1e", "",
        ] {
            assert_scalar(raw, &SmolScalar::Refused);
        }
    }

    #[test]
    fn overflowing_floats_become_infinity() {
        assert_scalar("1e1000", &SmolScalar::AcceptedAs("inf"));
        assert_scalar("-1e400", &SmolScalar::AcceptedAs("-inf"));
        assert_scalar("1e-400", &SmolScalar::Accepted);
        assert_scalar("1.5e300", &SmolScalar::Accepted);
    }

    #[test]
    fn dates_follow_bun_date_rather_than_the_toml_calendar() {
        for raw in [
            "1979-02-30",
            "1979-06-31T07:32",
            "1979-05-27Z",
            "07:32Z",
            "07:32:00+01:00",
            "1979-05-27t07:32:00z",
            "1979-05-27 07:32:00.123456789123",
            "0000-01-01",
        ] {
            assert_scalar(raw, &SmolScalar::AcceptedAs(ACCEPTED_DATE));
        }
        for raw in [
            "00:00:60",
            "24:00",
            "23:60",
            "1979-12-32",
            "1979-13-01",
            "1979-01-00",
            "1979-05-27+01:00",
            "1979-05-27T",
            "T07:32",
            "1979-05-27T07:32:00+24:00",
            "1979-05-27T07:32:00.",
            "1979-05-2707:32",
            "Z",
        ] {
            assert_scalar(raw, &SmolScalar::Refused);
        }
    }

    #[test]
    fn a_date_then_a_space_then_z_is_a_utc_date_like_bun() {
        for raw in ["1979-05-27 Z", "1979-05-27 z"] {
            assert_scalar(raw, &SmolScalar::AcceptedAs(ACCEPTED_DATE));
        }
        for raw in ["1979-05-27T Z", "1979-05-27TZ", "1979-05-27 +01:00"] {
            assert_scalar(raw, &SmolScalar::Refused);
        }
    }

    #[test]
    fn day_00_glued_to_a_time_takes_bun_legacy_fallback() {
        for raw in [
            "1979-01-0007:32Z",
            "1979-01-0007:32",
            "1979-02-0007:32z",
            "1979-12-0023:59:59.5-05:00",
            "0000-01-0000:00",
            "1979-01-0007:32+99:59",
            "1979-01-0007:32-24:00",
        ] {
            assert_scalar(raw, &SmolScalar::AcceptedAs(ACCEPTED_DATE));
        }
        for raw in [
            "1979-01-0107:32Z",
            "1979-01-3107:32Z",
            "1979-13-0007:32Z",
            "1979-00-0007:32Z",
            "1979-01-00T07:32Z",
            "1979-01-00 07:32Z",
            "1979-01-00Z",
            "1979-01-0007:60Z",
            "1979-01-0007:32:60",
            "1979-01-0024:00",
            "1979-01-0007:32+23:60",
        ] {
            assert_scalar(raw, &SmolScalar::Refused);
        }
    }

    #[test]
    fn nesting_counts_parsed_containers_below_the_root() {
        let arrays = |depth: usize| format!("a = {}{}", "[".repeat(depth), "]".repeat(depth));
        for (text, expected) in [
            (arrays(TOML_NESTING_LIMIT), true),
            (arrays(TOML_NESTING_LIMIT + 1), false),
            (arrays(1_000_000), false),
        ] {
            let received = parse_like_smol_toml(&text).is_some();
            assert_eq!(
                received,
                expected,
                "expected parsed={expected} for {} brackets | received: parsed={received}",
                text.matches('[').count()
            );
        }
    }
}
