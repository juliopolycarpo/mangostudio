/**
 * The client's side of the activity feed: one paginated read, nothing else.
 *
 * Every field is optional because the caller decides how far back to look —
 * "since your last visit", one workdir, or the newest page — and the wire
 * schema (`ListActivityQuerySchema`) is the same shape for all three. Optional
 * fields are only sent when set, rather than as `undefined`, so a query with
 * none of them reaches the server as a bare `GET /api/activity`.
 */

import type { ListActivityQuery, ListActivityResponse } from '@mangostudio/shared/activity';
import { client } from '@/lib/api-client';
import { ApiError } from '@/lib/utils';

export async function listActivity(query: ListActivityQuery = {}): Promise<ListActivityResponse> {
  const { data, error } = await client.api.activity.get({
    query: {
      ...(query.since !== undefined ? { since: query.since } : {}),
      ...(query.workdir ? { workdir: query.workdir } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
    },
  });
  if (error) throw new ApiError(error.value);
  return data as ListActivityResponse;
}
