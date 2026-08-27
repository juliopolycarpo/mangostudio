import type { GithubContext, GithubPr } from '@mangostudio/shared/github';
import { GithubPrSchema } from '@mangostudio/shared/github';
import { readGhOutput } from '../domain/gh-output';
import {
  GhCliError,
  type GhRuntimeSelection,
  type GithubCli,
  ghCli,
} from '../infrastructure/gh-cli';
import { createGithubRepoResolver, type ResolveGithubRepo } from './github-repo-resolver';

const NO_PULL_REQUEST_PATTERN = /no pull requests found/i;

/**
 * Resolves GitHub context for a workdir *on a given machine*.
 *
 * The selection is not optional and is not defaulted here. A chat pinned to a
 * WSL, SSH, or container environment has a workdir that only exists over there,
 * and running `gh` anywhere else answers about the wrong filesystem and the
 * wrong GitHub account — so the caller that knows which environment the chat
 * belongs to has to say.
 */
export type GetGithubContext = (
  workdir: string,
  selection: GhRuntimeSelection,
  signal?: AbortSignal
) => Promise<GithubContext>;

/**
 * The header's "which repository and which pull request" read.
 *
 * The availability, authentication and remote ladder is not repeated here: it
 * is the same one every other GitHub endpoint runs, so it comes from
 * `createGithubRepoResolver` and this service is only the branch's pull request
 * on top of it.
 *
 * @example
 * const getContext = createGithubContextService(ghCli);
 * await getContext(workdir, { userId, environmentId });
 */
export function createGithubContextService(
  client: GithubCli,
  resolveRepo: ResolveGithubRepo = createGithubRepoResolver(client)
): GetGithubContext {
  return async (workdir, selection, signal) => {
    const resolution = await resolveRepo(workdir, selection, signal);
    if (resolution.state !== 'ok') return resolution;

    let pr: GithubPr | null;
    try {
      const result = await client.run('pr.view-current', {}, { cwd: workdir, selection, signal });
      pr = readGhOutput('pr.view-current', result.stdout, GithubPrSchema, (value) => value);
    } catch (error) {
      if (isNoPullRequest(error)) pr = null;
      else throw error;
    }

    return { state: 'ok', repo: resolution.repo, pr };
  };
}

export const getGithubContext = createGithubContextService(ghCli);

/** gh reports "this branch has no pull request" as exit 1 with prose on stderr. */
function isNoPullRequest(error: unknown): boolean {
  return (
    error instanceof GhCliError &&
    error.exitCode === 1 &&
    NO_PULL_REQUEST_PATTERN.test(error.stderr)
  );
}
