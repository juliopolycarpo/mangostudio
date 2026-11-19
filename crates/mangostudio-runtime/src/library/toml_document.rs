//! TOML validity for `toml-agent` and `toml-settings` library instances, as
//! the hub's `Bun.TOML.parse` decides it, built on the `toml` crate rather
//! than a second TOML implementation.
//!
//! Both parsers follow the TOML specification, so dates and times agree
//! without help: `1979-02-30`, `07:32Z`, `1979-05-27Z` and `1979-05-27 Z` are
//! refused, and a `:60` leap second is accepted (Bun reads it as `:59`, and
//! this runtime follows the hub because the hub is the host users see).
//! Inline-table newlines and trailing commas, `\e` and `\xHH` escapes, and
//! times without seconds agree too. They differ in two places, which this
//! module narrows to the hub's verdict:
//!
//! - **Bare scalars.** Bun refuses an integer outside `Number.isSafeInteger`
//!   and reads a float through `strtod`, so `1e1000` is `Infinity`, not an
//!   error. [`bound_scalar`] judges each bare scalar: one Bun refuses makes
//!   the document invalid, and one it accepts but the `toml` crate would not
//!   is swapped for an equivalent the `toml` crate accepts before the
//!   structural parse. A bare scalar is never a string, so the swap cannot
//!   change a title or description.
//! - **Nesting.** Bun accepts any depth of dotted keys and table headers;
//!   the `toml` crate stops at 80 and, unbounded, would recurse once per
//!   level. Neither limit is closed: both hosts narrow validity instead,
//!   refusing a document whose parsed value nests more than
//!   [`TOML_NESTING_LIMIT`] containers below the root
//!   (`apps/shared/src/library/machine/toml-nesting.ts` on the hub side).
//!   The limit sits under the `toml` crate's guard, so that guard never
//!   decides a verdict on its own.
//!
//! `tests/fixtures/library-toml/validity-cases.json` is the case table both
//! hosts replay, so a parser change on either side fails a test.

use toml_parser::parser::{EventReceiver, parse_document};
use toml_parser::{ErrorSink, Source, Span};

/// The deepest container a TOML document may hold, the root table being
/// depth 0 — `TOML_NESTING_LIMIT` in `toml-nesting.ts`.
pub(crate) const TOML_NESTING_LIMIT: usize = 64;

/// `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: u128 = (1 << 53) - 1;

/// Parses `text` into a table when `Bun.TOML.parse` would and it nests no
/// deeper than [`TOML_NESTING_LIMIT`]; `None` otherwise.
///
/// # Example
///
/// ```ignore
/// assert!(parse_library_toml("a = 1e1000").is_some());
/// assert!(parse_library_toml("a = 1979-02-30").is_none());
/// assert!(parse_library_toml("a = 9007199254740992").is_none());
/// ```
#[must_use]
pub(crate) fn parse_library_toml(text: &str) -> Option<toml::Table> {
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
        let replacement = match bound_scalar(raw) {
            BoundScalar::Refused => return None,
            BoundScalar::Unchanged => continue,
            BoundScalar::ReadAs(replacement) => replacement,
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

/// What this host's extra rules make of one bare scalar. Anything not listed
/// here (dates, times, booleans, `inf`, `nan`, malformed numbers) is left to
/// the `toml` crate, which follows the specification as Bun does.
#[derive(Debug, PartialEq, Eq)]
enum BoundScalar {
    /// Bun refuses it although the `toml` crate would accept it.
    Refused,
    /// The `toml` crate decides on the text as written.
    Unchanged,
    /// Bun accepts it but the `toml` crate refuses the original; parse this
    /// text in its place.
    ReadAs(&'static str),
}

/// Applies the safe-integer bound and the float-overflow rule to an
/// unquoted scalar.
fn bound_scalar(raw: &str) -> BoundScalar {
    let digits = raw.replace('_', "");
    if is_integer_literal(raw) {
        return if safe_integer(&digits) {
            BoundScalar::Unchanged
        } else {
            BoundScalar::Refused
        };
    }
    if !is_float_literal(raw) {
        return BoundScalar::Unchanged;
    }
    match digits.parse::<f64>() {
        Ok(value) if value == f64::INFINITY => BoundScalar::ReadAs("inf"),
        Ok(value) if value == f64::NEG_INFINITY => BoundScalar::ReadAs("-inf"),
        _ => BoundScalar::Unchanged,
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

/// A TOML integer: `0x`, `0o` or `0b` digits, or decimal digits with an
/// optional sign. A malformed one is not an integer here; the `toml` crate
/// refuses it.
fn is_integer_literal(raw: &str) -> bool {
    for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] {
        if let Some(body) = raw.strip_prefix(prefix) {
            return is_digit_run(body, radix);
        }
    }
    is_digit_run(raw.strip_prefix(['+', '-']).unwrap_or(raw), 10)
}

/// A TOML float with a fraction or an exponent: sign, digits, optional
/// fraction, optional exponent.
fn is_float_literal(raw: &str) -> bool {
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

/// `Number.isSafeInteger(+digits)` for text [`is_integer_literal`] matched
/// with its underscores removed.
fn safe_integer(digits: &str) -> bool {
    let (radix, body) = match digits.get(..2) {
        Some("0x") => (16, &digits[2..]),
        Some("0o") => (8, &digits[2..]),
        Some("0b") => (2, &digits[2..]),
        _ => (10, digits.strip_prefix(['+', '-']).unwrap_or(digits)),
    };
    u128::from_str_radix(body, radix).is_ok_and(|value| value <= MAX_SAFE_INTEGER)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_scalar(raw: &str, expected: &BoundScalar) {
        let received = bound_scalar(raw);
        assert_eq!(
            &received, expected,
            "expected bound verdict for {raw:?}: {expected:?} | received: {received:?}"
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
            assert_scalar(raw, &BoundScalar::Unchanged);
        }
        for raw in [
            "9007199254740992",
            "-9007199254740992",
            "0x20000000000000",
            "9223372036854775807",
            "340282366920938463463374607431768211456",
        ] {
            assert_scalar(raw, &BoundScalar::Refused);
        }
    }

    #[test]
    fn malformed_numbers_are_left_to_the_toml_crate_which_refuses_them() {
        for raw in [
            "03", "+03", "0_1", "1_", "1__0", "-0x1", "+0x1", "1.", ".1", "1e", "0o8", "0b2",
        ] {
            assert_scalar(raw, &BoundScalar::Unchanged);
            assert!(
                parse_library_toml(&format!("a = {raw}")).is_none(),
                "expected a = {raw} to be invalid | received: valid"
            );
        }
    }

    #[test]
    fn dates_and_times_are_left_to_the_toml_crate() {
        for raw in ["1979-02-30", "07:32Z", "23:59:60", "1979-05-27T07:32:00Z"] {
            assert_scalar(raw, &BoundScalar::Unchanged);
        }
    }

    #[test]
    fn overflowing_floats_become_infinity() {
        assert_scalar("1e1000", &BoundScalar::ReadAs("inf"));
        assert_scalar("-1e400", &BoundScalar::ReadAs("-inf"));
        assert_scalar("1e-400", &BoundScalar::Unchanged);
        assert_scalar("1.5e300", &BoundScalar::Unchanged);
    }

    /// The case table the hub replays in
    /// `apps/shared/tests/unit/library/machine/toml-validity-cases.test.ts`.
    #[test]
    fn the_shared_case_table_gives_the_hub_verdict() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/library-toml/validity-cases.json");
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("case table {}: {error}", path.display()));
        let table: serde_json::Value = serde_json::from_str(&text).unwrap();
        let cases = table["cases"].as_array().expect("cases array");
        assert!(
            !cases.is_empty(),
            "case table {} has no cases",
            path.display()
        );
        let disagreements: Vec<String> = cases
            .iter()
            .filter_map(|case| {
                let name = case["name"].as_str().unwrap();
                let document = case["document"].as_str().unwrap();
                let expected = case["valid"].as_bool().unwrap();
                let received = parse_library_toml(document).is_some();
                (received != expected).then(|| {
                    format!(
                        "{name} ({document:?}): expected valid={expected} | received valid={received}"
                    )
                })
            })
            .collect();
        assert!(
            disagreements.is_empty(),
            "runtime disagrees with the hub on {} case(s):\n{}",
            disagreements.len(),
            disagreements.join("\n")
        );
    }

    #[test]
    fn nesting_counts_parsed_containers_below_the_root() {
        let arrays = |depth: usize| format!("a = {}{}", "[".repeat(depth), "]".repeat(depth));
        for (text, expected) in [
            (arrays(TOML_NESTING_LIMIT), true),
            (arrays(TOML_NESTING_LIMIT + 1), false),
            (arrays(1_000_000), false),
        ] {
            let received = parse_library_toml(&text).is_some();
            assert_eq!(
                received,
                expected,
                "expected parsed={expected} for {} brackets | received: parsed={received}",
                text.matches('[').count()
            );
        }
    }
}
