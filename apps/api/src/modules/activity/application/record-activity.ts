import type { ActivityEvent, ActivityEventKind } from '@mangostudio/shared/activity';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { publishActivityInvalidation } from '../../../services/realtime/activity-invalidation';
import { generateId } from '../../../utils/id';
import {
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

  // Pruned against the newest row written, so a batch carrying an injected
  // older `createdAt` cannot pull the retention cutoff backwards.
  const prunedAt = Math.max(...rows.map((row) => row.createdAt));
  await repository.prune(userId, prunedAt).catch((error: unknown) => {
    console.error('[activity] Could not prune the activity feed:', error);
  });
}
