import type { ActivityEvent, ActivityEventKind } from '@mangostudio/shared/activity';
import type { Kysely } from 'kysely';

import type { Database } from '../../../db/types';
import { publishActivityInvalidation } from '../../../services/realtime/activity-invalidation';
import { generateId } from '../../../utils/id';
import {
  ACTIVITY_RETENTION_INTERVAL_ROWS,
  type ActivityRepository,
  createActivityRepository,
} from '../infrastructure/activity-repository';

/** Nullable scoping columns. Omitted means "not applicable to this kind". */
interface ActivityScope {
  readonly chatId?: string | null;
  readonly workdir?: string | null;
  readonly environmentId?: string | null;
  readonly targetId?: string | null;
}

/**
 * A `kind` and the payload that kind requires — never another kind's.
 *
 * Distributed over the union rather than typed as `{ kind; payload: unknown }`
 * so a seam that renames a payload field fails `check` instead of writing a row
 * the list route will later have to drop.
 */
type ActivityKindAndPayload = {
  [K in ActivityEventKind]: {
    readonly kind: K;
    readonly payload: Extract<ActivityEvent, { kind: K }>['payload'];
  };
}[ActivityEventKind];

/** One row's worth of the feed, without the account it belongs to. */
export type RecordActivityEntry = ActivityScope &
  ActivityKindAndPayload & {
    /** Injectable so a test can pin the row's position in the feed. */
    readonly createdAt?: number;
  };

export type RecordActivityInput = RecordActivityEntry & {
  readonly userId: string;
};

export interface RecordActivityDeps {
  readonly repository?: ActivityRepository;
  readonly publish?: (userId: string) => void;
  readonly db?: Kysely<Database>;
}

/**
 * Appends one row to the account's activity feed and tells its tabs.
 *
 * **Never rejects, and never fails the operation that called it.** Activity is a
 * record of work that already happened; a hub that refused to commit because it
 * could not write the note about the commit would be trading the product for
 * the telemetry. Seams call this as `void recordActivity(...)` — the promise is
 * returned only so tests can await the write they are asserting on.
 */
export function recordActivity(
  input: RecordActivityInput,
  deps: RecordActivityDeps = {}
): Promise<void> {
  const { userId, ...entry } = input;
  return recordActivities(userId, [entry as RecordActivityEntry], deps);
}

/**
 * Files several rows for one account as a single write.
 *
 * One apply can land several resources, and a row each is what the reader
 * wants — but a statement, a socket frame, and a retention pass each is not.
 * Callers that produce a set at once come through here so the feed costs the
 * same whether an apply touched one resource or seven.
 */
export function recordActivities(
  userId: string,
  entries: readonly RecordActivityEntry[],
  deps: RecordActivityDeps = {}
): Promise<void> {
  return writeActivities(userId, entries, deps).catch((error: unknown) => {
    // Deliberately not the diagnostic logger: that one is gated off in the
    // integration lane, which is exactly where a swallowed write would hide.
    console.error('[activity] Could not record an activity event:', error);
  });
}

async function writeActivities(
  userId: string,
  entries: readonly RecordActivityEntry[],
  deps: RecordActivityDeps
): Promise<void> {
  if (userId.length === 0 || entries.length === 0) return;

  const repository = deps.repository ?? createActivityRepository(deps.db);
  const now = Date.now();
  const rows = entries.map((entry) => ({
    id: generateId(),
    userId,
    kind: entry.kind,
    createdAt: entry.createdAt ?? now,
    chatId: entry.chatId ?? null,
    workdir: entry.workdir ?? null,
    environmentId: entry.environmentId ?? null,
    targetId: entry.targetId ?? null,
    payloadJson: JSON.stringify(entry.payload),
  }));

  await repository.insertMany(rows);

  // Announced before retention runs, and not behind it: the rows are already
  // durable, so a prune that fails must not also cost the reader the refresh
  // that would have shown them. Retention is housekeeping; the notification is
  // the feature.
  (deps.publish ?? publishActivityInvalidation)(userId);

  if (!retentionDue(userId, rows.length)) return;

  // Pruned against the newest row written, so a batch carrying an injected
  // older `createdAt` cannot pull the retention cutoff backwards.
  const prunedAt = Math.max(...rows.map((row) => row.createdAt));
  try {
    await repository.prune(userId, prunedAt);
  } catch (error: unknown) {
    // Due again: the next write retries instead of waiting out another interval.
    rowsSinceRetention.delete(userId);
    console.error('[activity] Could not prune the activity feed:', error);
  }
}

/**
 * Rows written per account since its last retention pass, in this process.
 *
 * A pass walks the account's index to the cap boundary and, once the feed is
 * full, commits a delete of its own, so running it after every write doubled
 * the commits of the write path. It now runs once per
 * {@link ACTIVITY_RETENTION_INTERVAL_ROWS} rows and keeps that many fewer rows
 * than the cap, so the feed stays under the cap between passes. The 90-day
 * limit is applied by the same pass, so an expired row can outlive its cutoff
 * by up to that many writes.
 *
 * An account with no entry is due, so the first write after a restart trims
 * whatever the previous process left.
 */
const rowsSinceRetention = new Map<string, number>();

/**
 * Counts `written` rows and reports whether they make a pass due. A due pass
 * restarts the count before it runs, not after: writes are not awaited by
 * their callers, so a row written while the pass is still running must count
 * toward the next one. Counting a row the running pass already saw is safe; it
 * only brings the next pass forward.
 */
function retentionDue(userId: string, written: number): boolean {
  const total = (rowsSinceRetention.get(userId) ?? ACTIVITY_RETENTION_INTERVAL_ROWS) + written;
  const due = total >= ACTIVITY_RETENTION_INTERVAL_ROWS;
  rowsSinceRetention.set(userId, due ? 0 : total);
  return due;
}

/** Forgets every account's count, so the next write of each is due. For tests. */
export function resetActivityRetentionSchedule(): void {
  rowsSinceRetention.clear();
}
