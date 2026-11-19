/**
 * What the pull request list says about writing to the chat's machine.
 *
 * One reading of `canMutate`, shared by the GitHub panel and the command
 * palette so the two cannot disagree about whether a write is offered.
 */

import type { GithubPrsResponse } from '@mangostudio/shared/github';
import type { UseQueryResult } from '@tanstack/react-query';

/**
 *  - `pending`: the first read is still in flight, so nothing is known;
 *  - `unanswered`: the read failed and no earlier answer survives, so nothing is
 *    known either, but the user is looking at a failure and not at a spinner;
 *  - `allowed`: the list answered and the machine accepts `gh` writes;
 *  - `refused`: the list answered and the machine refuses them, or the
 *    repository cannot be read at all (no write control is shown then).
 *
 * An earlier answer outlives a failed refetch (`data` stays), so a refetch error
 * after a good read does not turn a known answer back into an unknown one.
 */
export type WriteAccess = 'pending' | 'unanswered' | 'allowed' | 'refused';

/**
 * @example
 * const writeAccess = writeAccessOf(useQuery(githubPrsQueryOptions(chatId, 'open')));
 */
export function writeAccessOf(query: UseQueryResult<GithubPrsResponse, Error>): WriteAccess {
  const { data } = query;
  if (data === undefined) return query.isError ? 'unanswered' : 'pending';
  return data.state === 'ok' && data.canMutate ? 'allowed' : 'refused';
}
