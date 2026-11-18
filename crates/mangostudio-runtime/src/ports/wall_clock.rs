//! When something happened, as a calendar instant — distinct from
//! [`crate::ports::clock::Clock`], which is monotonic and only ever
//! measures a duration.
//!
//! A `setup.state` record's `at` and an audit line's `ts` both need an
//! ISO-8601 instant a hub or a person can read, which [`std::time::Instant`]
//! cannot produce (it carries no relationship to a calendar at all). This
//! module is the one seam that reads [`std::time::SystemTime`], so a test
//! can hold it fixed instead of asserting against whatever the real clock
//! reads — the same reason [`crate::ports::clock::Clock`] exists.

use std::sync::Mutex;
use std::time::{Duration, SystemTime};

/// A source of the current calendar instant.
pub trait WallClock: Send + Sync + 'static {
    /// The current instant, by this clock's reckoning.
    fn now(&self) -> SystemTime;
}

/// The real wall clock. [`WallClock::now`] is [`SystemTime::now`], nothing
/// else.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemWallClock;

impl WallClock for SystemWallClock {
    fn now(&self) -> SystemTime {
        SystemTime::now()
    }
}

/// A clock fixed to one instant — for a test, or for the fixture generator
/// this crate's own freshness gate diffs, both of which need a `ts` or an
/// `at` that does not change between one run and the next.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::ports::wall_clock::{FixedWallClock, WallClock};
/// use std::time::{Duration, UNIX_EPOCH};
///
/// let fixed = FixedWallClock::new(UNIX_EPOCH + Duration::from_secs(1_700_000_000));
/// assert_eq!(fixed.now(), fixed.now());
/// ```
pub struct FixedWallClock {
    at: Mutex<SystemTime>,
}

impl FixedWallClock {
    /// Builds a clock that always answers `at`, until [`FixedWallClock::set`]
    /// moves it.
    #[must_use]
    pub fn new(at: SystemTime) -> Self {
        Self { at: Mutex::new(at) }
    }

    /// Moves this clock to `at`, for a test that needs more than one
    /// distinct instant.
    pub fn set(&self, at: SystemTime) {
        *crate::ports::audit::lock(&self.at) = at;
    }
}

impl WallClock for FixedWallClock {
    fn now(&self) -> SystemTime {
        *crate::ports::audit::lock(&self.at)
    }
}

/// Formats `at` as `YYYY-MM-DDTHH:MM:SS.sssZ` — the same shape
/// `Date.prototype.toISOString()` produces, which is what every `at` and
/// `ts` this crate writes must read as on the TypeScript side of a shared
/// file. `std` carries no calendar formatter for [`SystemTime`], and this
/// workspace has no date/time crate in its dependency graph to reach for
/// instead (see this crate's own research notes for the alternatives
/// considered), so the days-since-epoch civil calendar conversion below
/// (Howard Hinnant's `civil_from_days`, public domain) is the one piece of
/// calendar arithmetic this crate hand-rolls. It is pure integer math, has
/// no leap-second handling (neither does `Date.prototype.toISOString()`),
/// and every value it can produce round-trips through this module's own
/// test against a table of known instants.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::ports::wall_clock::format_iso8601_millis;
/// use std::time::{Duration, UNIX_EPOCH};
///
/// let at = UNIX_EPOCH + Duration::from_millis(1_700_000_000_123);
/// assert_eq!(format_iso8601_millis(at), "2023-11-14T22:13:20.123Z");
/// ```
#[must_use]
pub fn format_iso8601_millis(at: SystemTime) -> String {
    let since_epoch = at
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let total_millis = since_epoch.as_millis();
    let millis = (total_millis % 1000) as u32;
    let total_seconds = (total_millis / 1000) as i64;
    let days = total_seconds.div_euclid(86_400);
    let seconds_of_day = total_seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_of_day / 3600;
    let minute = (seconds_of_day % 3600) / 60;
    let second = seconds_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// Milliseconds since the Unix epoch `at` represents — the same integer
/// `Date.now()` produces on the TypeScript side. Distinct from
/// [`format_iso8601_millis`]: a `setup.state.at`/audit `ts` is read by a
/// person and is declared a `string` in the contract, but
/// `runtime.heartbeat`'s `at` is declared an `integer` — the two are not
/// interchangeable render targets for the same instant, and using the
/// string formatter for the latter is exactly the mismatch
/// [`crate::event_check::checked_emit`] exists to catch before it reaches
/// the wire.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::ports::wall_clock::epoch_millis;
/// use std::time::{Duration, UNIX_EPOCH};
///
/// let at = UNIX_EPOCH + Duration::from_millis(1_700_000_000_123);
/// assert_eq!(epoch_millis(at), 1_700_000_000_123);
/// ```
#[must_use]
pub fn epoch_millis(at: SystemTime) -> u64 {
    let millis = at
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    u64::try_from(millis).unwrap_or(u64::MAX)
}

/// Seconds from the Unix epoch back to `0000-01-01T00:00:00Z`, the earliest instant an RFC 3339
/// `date-fullyear` (four digits) can name. [`parse_rfc3339_instant`] cannot return anything
/// earlier, so a caller that subtracts a duration from "now" uses it as the supported range.
pub(crate) const EARLIEST_RFC3339_SECONDS_BEFORE_EPOCH: u64 = 62_167_219_200;

/// Parses an RFC 3339 `date-time` (`2023-11-14T22:13:20.123+01:00`) into the instant it names.
///
/// Accepts what the `chrono` parser this replaces did, and nothing more: a four-digit year, a
/// `T`, `t` or space between date and time, any number of fractional-second digits (only the
/// first nine count), a `Z`/`z` or `±HH:MM` offset (hours up to 23, minutes up to 59), and
/// second `60` for a leap second, which reads as the first second of the next minute. The day
/// must exist in its month, leap years included. Anything else, including trailing text or a
/// missing offset, is `None`.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::ports::wall_clock::{epoch_millis, parse_rfc3339_instant};
///
/// let at = parse_rfc3339_instant("2023-11-14T23:13:20.123+01:00").unwrap();
/// assert_eq!(epoch_millis(at), 1_700_000_000_123);
/// ```
#[must_use]
pub fn parse_rfc3339_instant(raw: &str) -> Option<SystemTime> {
    let bytes = raw.as_bytes();
    // `YYYY-MM-DDTHH:MM:SS` is nineteen bytes; the offset needs at least one more.
    if bytes.len() < 20 {
        return None;
    }
    let digits = |start: usize, len: usize| -> Option<i64> {
        let slice = bytes.get(start..start + len)?;
        slice.iter().all(u8::is_ascii_digit).then(|| {
            slice
                .iter()
                .fold(0, |sum, byte| sum * 10 + i64::from(byte - b'0'))
        })
    };
    let separator =
        |index: usize, accepted: &[u8]| bytes.get(index).is_some_and(|b| accepted.contains(b));
    if !(separator(4, b"-")
        && separator(7, b"-")
        && separator(10, b"Tt ")
        && separator(13, b":")
        && separator(16, b":"))
    {
        return None;
    }
    let (year, month, day) = (digits(0, 4)?, digits(5, 2)?, digits(8, 2)?);
    let (hour, minute, second) = (digits(11, 2)?, digits(14, 2)?, digits(17, 2)?);
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month as u32) {
        return None;
    }
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }

    let mut index = 19;
    let mut nanos = 0_u32;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let fraction_start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == fraction_start {
            return None;
        }
        // Past nine digits is finer than a nanosecond: read and drop.
        let kept = &bytes[fraction_start..index.min(fraction_start + 9)];
        nanos = kept
            .iter()
            .fold(0, |sum, byte| sum * 10 + u32::from(byte - b'0'))
            * 10_u32.pow(9 - kept.len() as u32);
    }

    let offset_seconds = match bytes.get(index..)? {
        b"Z" | b"z" => 0,
        [sign @ (b'+' | b'-'), rest @ ..] if rest.len() == 5 && rest[2] == b':' => {
            let offset_hour = digits(index + 1, 2)?;
            let offset_minute = digits(index + 4, 2)?;
            if offset_hour > 23 || offset_minute > 59 {
                return None;
            }
            let magnitude = offset_hour * 3600 + offset_minute * 60;
            if *sign == b'+' { magnitude } else { -magnitude }
        }
        _ => return None,
    };

    let local_seconds = days_from_civil(year, month as u32, day as u32) * 86_400
        + hour * 3600
        + minute * 60
        + second;
    let utc_seconds = local_seconds - offset_seconds;
    let whole = Duration::from_secs(utc_seconds.unsigned_abs());
    if utc_seconds >= 0 {
        SystemTime::UNIX_EPOCH
            .checked_add(whole)?
            .checked_add(Duration::from_nanos(nanos.into()))
    } else {
        // A negative whole-second count with a fraction still moves forward by the fraction.
        SystemTime::UNIX_EPOCH
            .checked_sub(whole)?
            .checked_add(Duration::from_nanos(nanos.into()))
    }
}

fn days_in_month(year: i64, month: u32) -> i64 {
    match month {
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Howard Hinnant's `days_from_civil`: days since the Unix epoch
/// (1970-01-01 = day 0) for the proleptic Gregorian `(year, month, day)`.
/// The arithmetic inverse of `civil_from_days`. Public domain —
/// <http://howardhinnant.github.io/date_algorithms.html#days_from_civil>.
#[must_use]
pub(crate) fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64; // [0, 399]
    let month_index = if month > 2 { month - 3 } else { month + 9 } as u64;
    let doy = (153 * month_index + 2) / 5 + day as u64 - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe as i64 - 719_468
}

/// Howard Hinnant's `civil_from_days`: the proleptic Gregorian
/// (year, month, day) for `days` days since the Unix epoch
/// (1970-01-01 = day 0). Public domain —
/// <http://howardhinnant.github.io/date_algorithms.html#civil_from_days>.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    let year = if month <= 2 { year + 1 } else { year };
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use super::{
        EARLIEST_RFC3339_SECONDS_BEFORE_EPOCH, FixedWallClock, WallClock, days_from_civil,
        epoch_millis, format_iso8601_millis, parse_rfc3339_instant,
    };

    #[test]
    fn rfc3339_instants_parse_to_exact_epoch_values() {
        let cases: &[(&str, SystemTime)] = &[
            ("1970-01-01T00:00:00Z", UNIX_EPOCH),
            (
                "2023-11-14T22:13:20.123Z",
                UNIX_EPOCH + Duration::from_millis(1_700_000_000_123),
            ),
            // The same instant written with a positive, a negative and a half-hour offset.
            (
                "2023-11-14T23:13:20+01:00",
                UNIX_EPOCH + Duration::from_secs(1_700_000_000),
            ),
            (
                "2023-11-14T17:13:20-05:00",
                UNIX_EPOCH + Duration::from_secs(1_700_000_000),
            ),
            (
                "2023-11-15T03:43:20+05:30",
                UNIX_EPOCH + Duration::from_secs(1_700_000_000),
            ),
            // Lowercase `t` and `z`, and a space between date and time.
            (
                "2023-11-14t22:13:20z",
                UNIX_EPOCH + Duration::from_secs(1_700_000_000),
            ),
            (
                "2023-11-14 22:13:20Z",
                UNIX_EPOCH + Duration::from_secs(1_700_000_000),
            ),
            // Nanosecond precision is kept; digits past the ninth are dropped.
            (
                "2023-11-14T22:13:20.123456789Z",
                UNIX_EPOCH + Duration::new(1_700_000_000, 123_456_789),
            ),
            (
                "2023-11-14T22:13:20.1234567891Z",
                UNIX_EPOCH + Duration::new(1_700_000_000, 123_456_789),
            ),
            (
                "2023-11-14T22:13:20.5Z",
                UNIX_EPOCH + Duration::new(1_700_000_000, 500_000_000),
            ),
            // A leap second reads as the first second of the next minute.
            (
                "2016-12-31T23:59:60Z",
                UNIX_EPOCH + Duration::from_secs(1_483_228_800),
            ),
            // A leap day.
            (
                "2000-02-29T00:00:00Z",
                UNIX_EPOCH + Duration::from_secs(951_782_400),
            ),
            // Before the epoch, with and without a fraction.
            ("1969-12-31T23:59:59Z", UNIX_EPOCH - Duration::from_secs(1)),
            (
                "1969-12-31T23:59:59.5Z",
                UNIX_EPOCH - Duration::from_millis(500),
            ),
        ];
        for &(raw, expected) in cases {
            assert_eq!(
                parse_rfc3339_instant(raw),
                Some(expected),
                "(parse_rfc3339_instant): expected {raw:?} to parse to {expected:?}"
            );
        }
    }

    #[test]
    fn rfc3339_text_that_is_not_a_date_time_is_refused() {
        for raw in [
            "",
            "2023-11-14",
            "2023-11-14T22:13:20",
            "2023-11-14T22:13Z",
            "2023-11-14T22:13:20.Z",
            "2023-11-14T22:13:20+0100",
            "2023-11-14T22:13:20+01",
            "2023-11-14T22:13:20+24:00",
            "2023-11-14T22:13:20+01:60",
            "2023-11-14T22:13:20Zjunk",
            "2023-11-14T22:13:20Z ",
            "2023-11-14T24:00:00Z",
            "2023-11-14T22:60:00Z",
            "2023-11-14T22:13:61Z",
            "2023-13-14T22:13:20Z",
            "2023-00-14T22:13:20Z",
            "2023-11-00T22:13:20Z",
            "2023-11-31T22:13:20Z",
            "2023-02-29T00:00:00Z",
            "1900-02-29T00:00:00Z",
            "23-11-14T22:13:20Z",
            "+2023-11-14T22:13:20Z",
            "2023-11-14T22:13:2\u{e9}Z",
            "2023/11/14T22:13:20Z",
        ] {
            assert_eq!(
                parse_rfc3339_instant(raw),
                None,
                "(parse_rfc3339_instant): expected {raw:?} to be refused as not an RFC 3339 date-time"
            );
        }
    }

    #[test]
    fn rfc3339_parsing_inverts_the_millisecond_formatter() {
        for millis in [0, 1, 951_782_400_000, 1_700_000_000_123, 1_735_689_599_999] {
            let at = UNIX_EPOCH + Duration::from_millis(millis);
            assert_eq!(
                parse_rfc3339_instant(&format_iso8601_millis(at)),
                Some(at),
                "(parse_rfc3339_instant): expected {millis} ms to survive a format round trip"
            );
        }
    }

    #[test]
    fn the_earliest_rfc3339_instant_is_year_zero() {
        let earliest = parse_rfc3339_instant("0000-01-01T00:00:00Z").unwrap();
        assert_eq!(
            earliest,
            UNIX_EPOCH - Duration::from_secs(EARLIEST_RFC3339_SECONDS_BEFORE_EPOCH),
        );
        assert_eq!(days_from_civil(0, 1, 1) * 86_400, -62_167_219_200);
    }

    #[test]
    fn the_system_wall_clock_moves_forward() {
        let clock = super::SystemWallClock;
        let first = clock.now();
        let second = clock.now();
        assert!(second >= first);
    }

    #[test]
    fn a_fixed_wall_clock_never_moves_until_told_to() {
        let fixed = FixedWallClock::new(UNIX_EPOCH);
        assert_eq!(fixed.now(), UNIX_EPOCH);
        assert_eq!(fixed.now(), fixed.now());
        fixed.set(UNIX_EPOCH + Duration::from_secs(60));
        assert_eq!(fixed.now(), UNIX_EPOCH + Duration::from_secs(60));
    }

    #[test]
    fn epoch_millis_matches_javascripts_date_now_for_the_same_instant() {
        assert_eq!(epoch_millis(UNIX_EPOCH), 0);
        assert_eq!(
            epoch_millis(UNIX_EPOCH + Duration::from_millis(1_700_000_000_123)),
            1_700_000_000_123
        );
    }

    #[test]
    fn the_epoch_itself_formats_as_the_documented_instant() {
        assert_eq!(
            format_iso8601_millis(UNIX_EPOCH),
            "1970-01-01T00:00:00.000Z"
        );
    }

    /// Cross-checked against `new Date(ms).toISOString()` for the same
    /// millisecond count, for a handful of instants spanning a leap year, a
    /// month/day rollover, and a value with sub-second precision.
    #[test]
    fn known_instants_match_javascripts_own_toisostring() {
        let cases: &[(u64, &str)] = &[
            (0, "1970-01-01T00:00:00.000Z"),
            (1_700_000_000_123, "2023-11-14T22:13:20.123Z"),
            // A leap day.
            (951_782_400_000, "2000-02-29T00:00:00.000Z"),
            // A year boundary at the last millisecond of the year.
            (1_735_689_599_999, "2024-12-31T23:59:59.999Z"),
        ];
        for &(millis, expected) in cases {
            let at = UNIX_EPOCH + Duration::from_millis(millis);
            assert_eq!(
                format_iso8601_millis(at),
                expected,
                "for {millis} ms since the epoch"
            );
        }
    }
}
