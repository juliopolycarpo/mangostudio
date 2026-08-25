import {
  ACTIVITY_PAGE_LIMIT_DEFAULT,
  ACTIVITY_PAGE_LIMIT_MAX,
  type ActivityEvent,
  ActivityEventSchema,
  type ListActivityQuery,
  type ListActivityResponse,
} from '@mangostudio/shared/activity';
import type { Kysely } from 'kysely';
import Value from 'typebox/value';
import type { ActivityEventSelect, Database } from '../../../db/types';
import { decodeActivityCursor, encodeActivityCursor } from '../domain/activity-cursor';
import {
  type ActivityRepository,
  createActivityRepository,
} from '../infrastructure/activity-repository';

export interface ListActivityDeps {
  readonly repository?: ActivityRepository;
  readonly db?: Kysely<Database>;
}

/**
 * Reads one page of the account's feed, newest first.
 *
 * A row this build cannot re-validate is dropped rather than raised. `kind` is
 * stored as text on purpose — a downgrade must not lose the rows a newer build
 * wrote — and Elysia validates the whole response, so one unreadable row would
 * otherwise take the entire feed down with it. The page can therefore come back
 * shorter than `limit`; `nextCursor` still tracks the last row *scanned*, so
 * paging never stalls on a run of unreadable rows.
 */
export async function listActivity(
  userId: string,
  query: ListActivityQuery,
  deps: ListActivityDeps = {}
): Promise<ListActivityResponse> {
  const repository = deps.repository ?? createActivityRepository(deps.db);
  const limit = clampLimit(query.limit);
  const cursor = query.cursor === undefined ? undefined : decodeActivityCursor(query.cursor);

  const page = await repository.list({
    userId,
    limit,
    ...(query.since === undefined ? {} : { since: query.since }),
    ...(query.workdir === undefined ? {} : { workdir: query.workdir }),
    ...(cursor === undefined ? {} : { cursor }),
  });

  const events = page.rows
    .map(toActivityEvent)
    .filter((event): event is ActivityEvent => event !== null);
  const last = page.rows.at(-1);

  return {
    events,
    ...(page.hasMore && last
      ? { nextCursor: encodeActivityCursor({ createdAt: last.createdAt, id: last.id }) }
      : {}),
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return ACTIVITY_PAGE_LIMIT_DEFAULT;
  return Math.max(1, Math.min(ACTIVITY_PAGE_LIMIT_MAX, Math.trunc(limit)));
}

function toActivityEvent(row: ActivityEventSelect): ActivityEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payloadJson);
  } catch {
    return null;
  }

  const candidate = {
    id: row.id,
    createdAt: row.createdAt,
    chatId: row.chatId,
    workdir: row.workdir,
    environmentId: row.environmentId,
    targetId: row.targetId,
    kind: row.kind,
    payload,
  };

  return Value.Check(ActivityEventSchema, candidate) ? (candidate as ActivityEvent) : null;
}
