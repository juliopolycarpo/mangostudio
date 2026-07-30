/**
 * Tool identity query keys and options.
 *
 * One map for the whole app: overrides are few, and every surface that draws an
 * avatar needs the same data, so a single cached query beats a request per card.
 */

import type { ToolIdentityListResponse } from '@mangostudio/shared/tool-identity';
import { queryOptions } from '@tanstack/react-query';
import { client } from '@/lib/api-client';
import { throwApiError } from '@/lib/utils';

/** Overrides change only when the user edits one, and the socket says when. */
const STALE_TIME_MS = 5 * 60_000;

export const toolIdentityKeys = {
  all: ['tool-identities'] as const,
  list: () => [...toolIdentityKeys.all, 'list'] as const,
};

export function toolIdentitiesQueryOptions() {
  return queryOptions({
    queryKey: toolIdentityKeys.list(),
    staleTime: STALE_TIME_MS,
    queryFn: async () => {
      const { data, error } = await client.api['tool-identities'].get();
      if (error) throwApiError(error);
      return data as ToolIdentityListResponse;
    },
  });
}
