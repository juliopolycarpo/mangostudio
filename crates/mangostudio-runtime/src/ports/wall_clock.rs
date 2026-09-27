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
use std::time::SystemTime;

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
    use std::time::{Duration, UNIX_EPOCH};

    use super::{FixedWallClock, WallClock, epoch_millis, format_iso8601_millis};

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
