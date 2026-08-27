/**
 * GitHub panel mutations.
 *
 * Every one of these is a `gh` subprocess that changes something on GitHub, so
 * each is a plain function a mutation calls rather than a hook: the panel, the
 * palette and the branch list all reach for the same three writes, and only the
 * caller knows what to invalidate afterwards.
 */

import type {
  GithubCreatePrBody,
  GithubCreatePrResponse,
  GithubPrActionBody,
  GithubPrActionResponse,
} from '@mangostudio/shared/github';
import { client } from '@/lib/api-client';
import { ApiError } from '@/lib/utils';

/**
 * Opens a pull request for the chat's current branch.
 *
 * The response is a union, not a throw, for the four not-connected states — a
 * user can lose GitHub between opening the panel and pressing the button, and
 * that is a state to render, not an exception.
 *
 * @example
 * const result = await createPullRequest({ chatId, title: 'Fix the rail' });
 */
export async function createPullRequest(body: GithubCreatePrBody): Promise<GithubCreatePrResponse> {
  const { data, error } = await client.api.github.pr.post(body);
  if (error) throw new ApiError(error.value);
  return data as GithubCreatePrResponse;
}

/**
 * Takes a draft pull request out of draft.
 *
 * @example
 * await markPullRequestReady({ chatId, number: 942 });
 */
export async function markPullRequestReady(
  body: GithubPrActionBody
): Promise<GithubPrActionResponse> {
  const { data, error } = await client.api.github.pr.ready.post(body);
  if (error) throw new ApiError(error.value);
  return data as GithubPrActionResponse;
}

/**
 * Checks the pull request's head branch out in the chat's working directory.
 *
 * @example
 * await checkoutPullRequest({ chatId, number: 942 });
 */
export async function checkoutPullRequest(
  body: GithubPrActionBody
): Promise<GithubPrActionResponse> {
  const { data, error } = await client.api.github.pr.checkout.post(body);
  if (error) throw new ApiError(error.value);
  return data as GithubPrActionResponse;
}

/**
 * Publishes the current branch, setting upstream when it has none.
 *
 * Lives here rather than in the Git feature because its only caller is the
 * panel's combined push-then-create action: `gh pr create` on an unpushed
 * branch prompts for where to push, prompts are disabled on the runtime, and so
 * creating a pull request fails on exactly the branch you most want it on.
 * `POST /git/push` already picks `--set-upstream` when there is no upstream.
 *
 * @example
 * await pushCurrentBranch(chatId);
 */
export async function pushCurrentBranch(chatId: string): Promise<void> {
  const { error } = await client.api.git.push.post({ chatId });
  if (error) throw new ApiError(error.value);
}
