/**
 * How long ago an activity row happened, in as few characters as the language
 * allows: "now", "5m", "2h", "3d".
 *
 * A feed row is one line of subject and one of time, and the time used to be the
 * full phrase ("37 minutes ago") in a column as wide as its longest value — so
 * the subject was cut at a different point on every row, and always sooner than
 * it needed to be. A short form in a fixed column cuts every subject at the
 * same place and gives it back the room.
 *
 * The units come from the dictionary rather than `Intl` because the narrow
 * `Intl` forms are not narrow in every language ("5 dias" in Portuguese) and
 * English reads a month and a minute as the same letter. The full phrase stays
 * the row's tooltip and its screen-reader text.
 *
 * // Usage: compactElapsed(event.createdAt, t.home.activity) // => '37m'
 */

import type { Messages } from '@mangostudio/shared/i18n';
import { formatMessage } from '@/lib/i18n-format';

type ActivityLabels = Messages['home']['activity'];

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

export function compactElapsed(
  timestampMs: number,
  labels: ActivityLabels,
  nowMs = Date.now()
): string {
  // A clock a little ahead of the server's would otherwise print "-1m".
  const elapsed = Math.max(0, nowMs - timestampMs);
  const [pattern, span] =
    elapsed >= YEAR_MS
      ? ([labels.timeYears, YEAR_MS] as const)
      : elapsed >= MONTH_MS
        ? ([labels.timeMonths, MONTH_MS] as const)
        : elapsed >= DAY_MS
          ? ([labels.timeDays, DAY_MS] as const)
          : elapsed >= HOUR_MS
            ? ([labels.timeHours, HOUR_MS] as const)
            : elapsed >= MINUTE_MS
              ? ([labels.timeMinutes, MINUTE_MS] as const)
              : ([null, MINUTE_MS] as const);
  if (pattern === null) return labels.timeNow;
  return formatMessage(pattern, { count: String(Math.floor(elapsed / span)) });
}
