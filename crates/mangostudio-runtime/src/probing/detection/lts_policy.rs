//! Node LTS classification, mirroring
//! `apps/shared/src/environments/detection/lts-policy.ts`'s
//! `classifyNodeLtsStatus`: a date-driven read of a Node version against a
//! release schedule, with staleness rules for when the schedule itself is
//! too old to trust.
//!
//! # Every "unknown" here is load-bearing
//!
//! This function's whole job is to never let "I could not tell" collapse
//! into a false claim. A stale bundled schedule (older than
//! [`NODE_RELEASE_DATA_STALE_AFTER_MS`]) answers [`LtsStatus::Unknown`]
//! rather than reusing possibly-obsolete dates; a major the schedule has
//! never heard of answers [`LtsStatus::Unknown`] rather than assuming it is
//! current; and a release-line `latest` this port could not parse (a
//! malformed schedule entry) answers [`LtsStatus::Unknown`] rather than
//! guessing whether the caller's version is behind it. See each branch
//! below for which of these it guards.
//!
//! # Date arithmetic
//!
//! This module works in whole milliseconds since the Unix epoch, at UTC
//! midnight boundaries — the same domain `Date.parse(\`${value}T00:00:00.000Z\`)`
//! computes in TypeScript. This workspace carries no date/time crate
//! ([`crate::ports::wall_clock`] already made the same call for formatting
//! an instant), so [`days_from_civil`] is the arithmetic inverse of that
//! module's `civil_from_days`: Howard Hinnant's `days_from_civil`, also
//! public domain —
//! <http://howardhinnant.github.io/date_algorithms.html#days_from_civil>.

use std::time::{SystemTime, UNIX_EPOCH};

use super::types::LtsStatus;

const DAY_MS: i64 = 24 * 60 * 60 * 1_000;

/// How old the bundled release schedule may be before this policy stops
/// trusting its dates outright (183 days — see
/// [`classify_node_lts_status`]'s staleness check).
pub const NODE_RELEASE_DATA_STALE_AFTER_MS: i64 = 183 * DAY_MS;

/// How old live release metadata may be before it can no longer stand in
/// for a stale bundled schedule.
///
/// Live metadata only refreshes latest patches, so it may stand in for
/// bundled data while it is itself recent. A stale live cache must not keep
/// an equally stale bundled schedule alive, hence a far tighter bound than
/// [`NODE_RELEASE_DATA_STALE_AFTER_MS`].
pub const NODE_RELEASE_LIVE_DATA_STALE_AFTER_MS: i64 = 14 * DAY_MS;

/// One Node major's release schedule entry.
#[derive(Debug, Clone, Copy)]
pub struct NodeReleaseLine {
    /// The major version this line is about.
    pub major: u32,
    /// `YYYY-MM-DD` — when this line's initial release shipped.
    pub start: &'static str,
    /// `YYYY-MM-DD` — when this line was promoted to LTS, if it ever was.
    pub lts: Option<&'static str>,
    /// `YYYY-MM-DD` — when this line entered maintenance, if it ever did.
    pub maintenance: Option<&'static str>,
    /// `YYYY-MM-DD` — when this line reaches (or reached) end of life.
    pub end: &'static str,
    /// This line's LTS codename, when it has one.
    pub codename: Option<&'static str>,
    /// The newest known patch on this line, at the time the schedule was
    /// generated.
    pub latest: Option<&'static str>,
}

/// A bundled or live Node release schedule.
#[derive(Debug, Clone, Copy)]
pub struct NodeReleaseSchedule {
    /// `YYYY-MM-DD` — when this schedule was generated.
    pub generated_at: &'static str,
    /// Every release line this schedule tracks.
    pub lines: &'static [NodeReleaseLine],
}

/// Inputs [`classify_node_lts_status`] and
/// [`crate::probing::detection::version_manager_support::to_managed_versions`]
/// need beyond the version and schedule themselves.
#[derive(Debug, Clone)]
pub struct LtsPolicyOptions {
    /// The instant to classify against.
    pub now: SystemTime,
    /// The newest known patch per major, from a live probe — merged against
    /// (never replacing) the bundled schedule's own `latest` fields.
    pub latest_by_major: std::collections::BTreeMap<u32, String>,
    /// Whether [`LtsPolicyOptions::latest_by_major`] came from a live probe
    /// recent enough to excuse a stale bundled schedule.
    pub live_data_available: Option<bool>,
}

/// A bare version string, fully anchored — distinct from
/// [`crate::probing::detection::runtime_definitions::parse_node_version`],
/// which reads `node --version` output and tolerates trailing content; a
/// release-index entry with trailing anything is not a version this policy
/// should reason about.
#[must_use]
pub fn parse_exact_node_version(value: &str) -> Option<super::types::SemVer> {
    let trimmed = value.trim();
    let without_v = trimmed.strip_prefix('v').unwrap_or(trimmed);
    let mut parts = without_v.split('.');
    let major = parts.next()?;
    let minor = parts.next()?;
    let patch = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    if !is_ascii_digits(major) || !is_ascii_digits(minor) || !is_ascii_digits(patch) {
        return None;
    }
    Some(super::types::SemVer {
        major: major.parse().ok()?,
        minor: minor.parse().ok()?,
        patch: patch.parse().ok()?,
    })
}

fn is_ascii_digits(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

/// Normalizes a version string to `major.minor.patch`, or `None` when it
/// does not parse as an exact version.
#[must_use]
pub fn normalize_node_version(value: &str) -> Option<String> {
    parse_exact_node_version(value)
        .map(|version| format!("{}.{}.{}", version.major, version.minor, version.patch))
}

fn compare_versions(left: super::types::SemVer, right: super::types::SemVer) -> std::cmp::Ordering {
    left.cmp(&right)
}

/// Howard Hinnant's `days_from_civil`: days since the Unix epoch
/// (1970-01-01 = day 0) for the proleptic Gregorian `(year, month, day)`.
/// The arithmetic inverse of [`crate::ports::wall_clock`]'s
/// `civil_from_days`. Public domain —
/// <http://howardhinnant.github.io/date_algorithms.html#days_from_civil>.
#[must_use]
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64; // [0, 399]
    let month_index = if month > 2 { month - 3 } else { month + 9 } as u64;
    let doy = (153 * month_index + 2) / 5 + day as u64 - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe as i64 - 719_468
}

/// Parses a strict `YYYY-MM-DD` date into milliseconds since the Unix
/// epoch at UTC midnight — the same value
/// `Date.parse(\`${value}T00:00:00.000Z\`)` computes for a well-formed
/// input, and `None` (TypeScript's `NaN`, `!Number.isFinite`) for anything
/// else.
#[must_use]
fn start_of_day_ms(value: &str) -> Option<i64> {
    let mut parts = value.split('-');
    let year = parts.next()?;
    let month = parts.next()?;
    let day = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    if year.len() != 4 || month.len() != 2 || day.len() != 2 {
        return None;
    }
    let year: i64 = year.parse().ok()?;
    let month: u32 = month.parse().ok()?;
    let day: u32 = day.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some(days_from_civil(year, month, day) * DAY_MS)
}

/// One day after [`start_of_day_ms`] — the exclusive upper bound a
/// `nowMs < endOfDay(line.end)` comparison needs.
fn end_of_day_ms(value: &str) -> Option<i64> {
    start_of_day_ms(value).map(|ms| ms + DAY_MS)
}

fn now_ms(now: SystemTime) -> i64 {
    now.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// Whether `schedule` is too old to trust its own dates, unless
/// `options.live_data_available` says a live refresh stands in for it.
///
/// An unparseable `generated_at` (this schedule's own equivalent of
/// TypeScript's `NaN`) always counts as stale — a schedule this port
/// cannot even date is never "recent enough".
fn is_node_release_schedule_stale(schedule: &NodeReleaseSchedule, now: SystemTime) -> bool {
    match start_of_day_ms(schedule.generated_at) {
        Some(generated_at) => now_ms(now) - generated_at > NODE_RELEASE_DATA_STALE_AFTER_MS,
        None => true,
    }
}

/// The release line `version`'s major belongs to, when the schedule tracks
/// it.
#[must_use]
pub fn find_node_release_line<'a>(
    schedule: &'a NodeReleaseSchedule,
    version: &str,
) -> Option<&'a NodeReleaseLine> {
    let parsed = parse_exact_node_version(version)?;
    schedule
        .lines
        .iter()
        .find(|line| line.major == parsed.major)
}

/// The newest major among lines that are LTS *right now* — i.e. their own
/// `lts` date has arrived and their `end` date has not.
fn newest_active_lts_major(schedule: &NodeReleaseSchedule, now_ms_value: i64) -> Option<u32> {
    schedule
        .lines
        .iter()
        .filter(|line| {
            line.lts
                .and_then(start_of_day_ms)
                .is_some_and(|lts_start| now_ms_value >= lts_start)
                && end_of_day_ms(line.end).is_some_and(|end| now_ms_value < end)
        })
        .map(|line| line.major)
        .max()
}

/// Whether `major` sits below every line the bundled schedule still tracks,
/// and that oldest tracked line has itself already ended.
///
/// The bundled schedule is trimmed to still-relevant majors. Anything older
/// than its oldest tracked line is definitively past end of life once that
/// line has ended, so it must not be reported as merely unknown.
fn is_below_oldest_ended_line(
    schedule: &NodeReleaseSchedule,
    major: u32,
    now_ms_value: i64,
) -> bool {
    let Some(oldest) = schedule.lines.iter().min_by_key(|line| line.major) else {
        return false;
    };
    major < oldest.major && end_of_day_ms(oldest.end).is_some_and(|end| now_ms_value >= end)
}

/// The newest known patch for `line`, comparing the schedule's own bundled
/// `latest` against `latest_by_major`'s live-probed value and keeping
/// whichever parses to the higher version. `None` only when neither source
/// gives this line a parseable version at all.
fn latest_version_for_line(
    line: &NodeReleaseLine,
    latest_by_major: &std::collections::BTreeMap<u32, String>,
) -> Option<super::types::SemVer> {
    let bundled = line.latest.and_then(parse_exact_node_version);
    let supplemental = latest_by_major
        .get(&line.major)
        .and_then(|value| parse_exact_node_version(value));
    match (bundled, supplemental) {
        (Some(bundled), Some(supplemental)) => {
            Some(if compare_versions(supplemental, bundled).is_gt() {
                supplemental
            } else {
                bundled
            })
        }
        (Some(bundled), None) => Some(bundled),
        (None, supplemental) => supplemental,
    }
}

/// Classifies `version_value` against `schedule`, never collapsing an
/// unreachable answer into a false negative. See the module docs for the
/// truthfulness invariant every [`LtsStatus::Unknown`] branch below
/// preserves.
#[must_use]
pub fn classify_node_lts_status(
    version_value: &str,
    schedule: &NodeReleaseSchedule,
    options: &LtsPolicyOptions,
) -> LtsStatus {
    if is_node_release_schedule_stale(schedule, options.now)
        && options.live_data_available != Some(true)
    {
        return LtsStatus::Unknown;
    }

    let Some(version) = parse_exact_node_version(version_value) else {
        return LtsStatus::Unknown;
    };

    let now_ms_value = now_ms(options.now);
    let Some(line) = schedule
        .lines
        .iter()
        .find(|candidate| candidate.major == version.major)
    else {
        return if is_below_oldest_ended_line(schedule, version.major, now_ms_value) {
            LtsStatus::EndOfLife
        } else {
            LtsStatus::Unknown
        };
    };

    let Some(start) = start_of_day_ms(line.start) else {
        return LtsStatus::Unknown;
    };
    if now_ms_value < start {
        return LtsStatus::Unknown;
    }
    let Some(end) = end_of_day_ms(line.end) else {
        return LtsStatus::Unknown;
    };
    if now_ms_value >= end {
        return LtsStatus::EndOfLife;
    }

    let lts_start = line.lts.and_then(start_of_day_ms);
    if lts_start.is_none_or(|lts_start| now_ms_value < lts_start) {
        return LtsStatus::CurrentRelease;
    }

    if Some(version.major) != newest_active_lts_major(schedule, now_ms_value) {
        return LtsStatus::LtsSuperseded;
    }

    match latest_version_for_line(line, &options.latest_by_major) {
        None => LtsStatus::Unknown,
        Some(latest) => {
            if compare_versions(version, latest).is_lt() {
                LtsStatus::LtsOutdatedPatch
            } else {
                LtsStatus::CurrentLts
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, UNIX_EPOCH};

    use super::*;

    /// A tiny two-line schedule so tests do not drift as the real bundled
    /// schedule's staleness window passes: one closed pre-LTS line, one
    /// active LTS line with a known `latest`.
    fn schedule() -> NodeReleaseSchedule {
        NodeReleaseSchedule {
            generated_at: "2026-07-26",
            lines: &[
                NodeReleaseLine {
                    major: 22,
                    start: "2024-04-24",
                    lts: Some("2024-10-29"),
                    maintenance: Some("2025-10-21"),
                    end: "2027-04-30",
                    codename: Some("jod"),
                    latest: Some("22.23.1"),
                },
                NodeReleaseLine {
                    major: 24,
                    start: "2025-05-06",
                    lts: Some("2025-10-28"),
                    maintenance: Some("2026-10-20"),
                    end: "2028-04-30",
                    codename: Some("krypton"),
                    latest: Some("24.18.0"),
                },
            ],
        }
    }

    fn at(days_after_generated: i64) -> SystemTime {
        // `generated_at` above is 2026-07-26 — reuse this module's own day
        // arithmetic rather than a hand-computed magic constant.
        let generated_days = days_from_civil(2026, 7, 26);
        UNIX_EPOCH + Duration::from_secs(((generated_days + days_after_generated) * 86_400) as u64)
    }

    fn options(now: SystemTime) -> LtsPolicyOptions {
        LtsPolicyOptions {
            now,
            latest_by_major: std::collections::BTreeMap::new(),
            live_data_available: None,
        }
    }

    #[test]
    fn an_early_patch_of_the_active_lts_line_is_outdated_not_current() {
        // At `generated_at` (2026-07-26), line 24 is already past its LTS
        // date (2025-10-28) and is the newest active LTS major, so an early
        // patch reads as behind `latest` (24.18.0): lts-outdated-patch.
        let status = classify_node_lts_status("24.0.0", &schedule(), &options(at(0)));
        assert_eq!(status, LtsStatus::LtsOutdatedPatch);
    }

    #[test]
    fn a_line_not_yet_promoted_to_lts_is_current_release() {
        // Major 25 has no `lts` date at all: it must read as
        // current-release for any `now` between its own `start` and `end`.
        // `at(-100)` (about 2026-04-17) sits in that window and is close
        // enough to `generated_at` to stay non-stale.
        const LINES: &[NodeReleaseLine] = &[NodeReleaseLine {
            major: 25,
            start: "2025-10-15",
            lts: None,
            maintenance: Some("2026-04-01"),
            end: "2026-06-01",
            codename: None,
            latest: Some("25.9.0"),
        }];
        let with_unpromoted_line = NodeReleaseSchedule {
            generated_at: "2026-07-26",
            lines: LINES,
        };
        let status = classify_node_lts_status("25.0.0", &with_unpromoted_line, &options(at(-100)));
        assert_eq!(status, LtsStatus::CurrentRelease);
    }

    #[test]
    fn the_newest_patch_of_the_active_lts_line_is_current_lts() {
        let status = classify_node_lts_status("24.18.0", &schedule(), &options(at(0)));
        assert_eq!(status, LtsStatus::CurrentLts);
    }

    #[test]
    fn an_older_lts_major_once_superseded_is_lts_superseded() {
        // Major 22's own `lts` and `end` still bracket `at(0)`, but major 24
        // is now the newest active LTS.
        let status = classify_node_lts_status("22.23.1", &schedule(), &options(at(0)));
        assert_eq!(status, LtsStatus::LtsSuperseded);
    }

    #[test]
    fn a_version_before_its_lines_start_is_unknown() {
        let status = classify_node_lts_status("24.0.0", &schedule(), &options(at(-500)));
        assert_eq!(status, LtsStatus::Unknown);
    }

    #[test]
    fn a_version_past_its_lines_end_is_end_of_life() {
        // `schedule()`'s lines both end well over 183 days after
        // `generated_at`, so "past end" and "schedule now stale" would be
        // the same instant there. This dedicated fixture's line ends only
        // 20 days after `generated_at`, so `at(25)` is past `end` while
        // still inside the non-stale window.
        let ends_soon = NodeReleaseSchedule {
            generated_at: "2026-07-26",
            lines: &[NodeReleaseLine {
                major: 22,
                start: "2024-04-24",
                lts: Some("2024-10-29"),
                maintenance: Some("2025-10-21"),
                end: "2026-08-15",
                codename: Some("jod"),
                latest: Some("22.23.1"),
            }],
        };
        let status = classify_node_lts_status("22.23.1", &ends_soon, &options(at(25)));
        assert_eq!(status, LtsStatus::EndOfLife);
    }

    #[test]
    fn a_major_the_schedule_never_tracked_is_unknown() {
        let status = classify_node_lts_status("30.0.0", &schedule(), &options(at(0)));
        assert_eq!(status, LtsStatus::Unknown);
    }

    #[test]
    fn a_major_below_the_oldest_ended_line_is_end_of_life_not_unknown() {
        // Major 20 is the oldest tracked line here and has already ended by
        // `generated_at` itself, so `at(0)` stays non-stale while still
        // proving the below-oldest-ended-line branch: anything older than
        // the oldest tracked major, once that major has ended, is
        // definitively past end of life rather than merely unknown.
        let with_an_already_ended_oldest_line = NodeReleaseSchedule {
            generated_at: "2026-07-26",
            lines: &[
                NodeReleaseLine {
                    major: 20,
                    start: "2023-04-18",
                    lts: Some("2023-10-24"),
                    maintenance: Some("2024-10-22"),
                    end: "2026-04-30",
                    codename: Some("iron"),
                    latest: Some("20.20.2"),
                },
                NodeReleaseLine {
                    major: 24,
                    start: "2025-05-06",
                    lts: Some("2025-10-28"),
                    maintenance: Some("2026-10-20"),
                    end: "2028-04-30",
                    codename: Some("krypton"),
                    latest: Some("24.18.0"),
                },
            ],
        };
        let status = classify_node_lts_status(
            "18.0.0",
            &with_an_already_ended_oldest_line,
            &options(at(0)),
        );
        assert_eq!(status, LtsStatus::EndOfLife);
    }

    #[test]
    fn an_unparseable_version_is_unknown() {
        let status = classify_node_lts_status("not-a-version", &schedule(), &options(at(0)));
        assert_eq!(status, LtsStatus::Unknown);
    }

    #[test]
    fn a_stale_schedule_with_no_live_data_is_unknown() {
        let far_future = at(NODE_RELEASE_DATA_STALE_AFTER_MS / DAY_MS + 10);
        let status = classify_node_lts_status("24.18.0", &schedule(), &options(far_future));
        assert_eq!(status, LtsStatus::Unknown);
    }

    #[test]
    fn a_stale_schedule_with_live_data_available_still_classifies() {
        let far_future = at(NODE_RELEASE_DATA_STALE_AFTER_MS / DAY_MS + 10);
        let mut opts = options(far_future);
        opts.live_data_available = Some(true);
        let status = classify_node_lts_status("24.18.0", &schedule(), &opts);
        assert_ne!(status, LtsStatus::Unknown);
    }

    #[test]
    fn an_unparseable_generated_at_is_always_stale() {
        let mut bad_schedule = schedule();
        bad_schedule.generated_at = "not-a-date";
        let status = classify_node_lts_status("24.18.0", &bad_schedule, &options(at(0)));
        assert_eq!(status, LtsStatus::Unknown);
    }

    #[test]
    fn a_live_probed_latest_can_move_current_lts_to_outdated_patch() {
        let mut opts = options(at(0));
        opts.latest_by_major.insert(24, "24.99.0".to_string());
        let status = classify_node_lts_status("24.18.0", &schedule(), &opts);
        assert_eq!(status, LtsStatus::LtsOutdatedPatch);
    }

    #[test]
    fn parse_exact_node_version_rejects_trailing_content() {
        assert!(parse_exact_node_version("24.18.0-rc.1").is_none());
        assert_eq!(
            parse_exact_node_version("v24.18.0"),
            Some(super::super::types::SemVer {
                major: 24,
                minor: 18,
                patch: 0
            })
        );
    }

    #[test]
    fn normalize_node_version_strips_a_v_prefix() {
        assert_eq!(
            normalize_node_version("v24.18.0"),
            Some("24.18.0".to_string())
        );
        assert_eq!(normalize_node_version("garbage"), None);
    }

    /// Mutation test 1: break the `lts-outdated-patch` vs `current-lts`
    /// split by comparing in the wrong direction. With the comparison
    /// flipped to `.is_gt()`, this test's second assertion goes red — the
    /// pre-fix failure, pasted verbatim from a local run:
    ///
    /// ```text
    /// thread 'probing::detection::lts_policy::tests::mutation_guard_current_lts_vs_outdated_patch_is_a_strict_less_than' panicked at crates/mangostudio-runtime/src/probing/detection/lts_policy.rs:591:9:
    /// assertion `left == right` failed
    ///   left: CurrentLts
    ///  right: LtsOutdatedPatch
    /// ```
    ///
    /// The same mutation also turns two other tests red for the same
    /// reason: `an_early_patch_of_the_active_lts_line_is_outdated_not_current`
    /// and `a_live_probed_latest_can_move_current_lts_to_outdated_patch`.
    #[test]
    fn mutation_guard_current_lts_vs_outdated_patch_is_a_strict_less_than() {
        // 24.18.0 is schedule()'s own `latest` for major 24: exactly equal,
        // so it must be `current-lts`, never `lts-outdated-patch`.
        assert_eq!(
            classify_node_lts_status("24.18.0", &schedule(), &options(at(0))),
            LtsStatus::CurrentLts
        );
        // One patch behind must flip to `lts-outdated-patch`.
        assert_eq!(
            classify_node_lts_status("24.17.0", &schedule(), &options(at(0))),
            LtsStatus::LtsOutdatedPatch
        );
    }
}
