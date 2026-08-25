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

export type RecordActivityInput = ActivityScope &
  ActivityKindAndPayload & {
    readonly userId: string;
    /** Injectable so a test can pin the row's position in the feed. */
    readonly createdAt?: number;
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
  return writeActivity(input, deps).catch((error: unknown) => {
    // Deliberately not the diagnostic logger: that one is gated off in the
    // integration lane, which is exactly where a swallowed write would hide.
    console.error('[activity] Could not record an activity event:', error);
  });
}

async function writeActivity(input: RecordActivityInput, deps: RecordActivityDeps): Promise<void> {
  if (input.userId.length === 0) return;

  const repository = deps.repository ?? createActivityRepository(deps.db);
  const createdAt = input.createdAt ?? Date.now();

  await repository.insert({
    id: generateId(),
    userId: input.userId,
    kind: input.kind,
    createdAt,
    chatId: input.chatId ?? null,
    workdir: input.workdir ?? null,
    environmentId: input.environmentId ?? null,
    targetId: input.targetId ?? null,
    payloadJson: JSON.stringify(input.payload),
  });

  // Announced before retention runs, and not behind it: the row is already
  // durable, so a prune that fails must not also cost the reader the refresh
  // that would have shown it. Retention is housekeeping; the notification is
  // the feature.
  (deps.publish ?? publishActivityInvalidation)(input.userId);

  await repository.prune(input.userId, createdAt).catch((error: unknown) => {
    console.error('[activity] Could not prune the activity feed:', error);
  });
}
