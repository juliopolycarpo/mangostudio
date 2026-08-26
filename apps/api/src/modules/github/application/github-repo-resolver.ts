/**
 * The four-step ladder every repository-scoped GitHub read starts with.
 *
 * Is `gh` on that machine, is it signed in, does this checkout have a remote,
 * and is that remote GitHub — asked in that order, because each answer makes
 * the next question meaningless. Nine endpoints need it and every one of them
 * carries `repo` in its `ok` payload, so it lives here rather than nine times:
 * the stderr patterns below are gh's prose, and a copy that missed a wording
 * change would report "no remote" as a 500.
 */

import type { GithubRepo, GithubUnavailableState } from '@mangostudio/shared/github';
import { GhRepoOutputSchema, readGhOutput } from '../domain/gh-output';
import { GhCliError, type GhRuntimeSelection, type GithubCli } from '../infrastructure/gh-cli';

/**
 * Both ways a folder can have no GitHub remote to talk about.
 *
 * A checkout with no remote configured says "no git remotes found". A folder
 * that is not a repository at all says "not a git repository", and that is the
 * ordinary case rather than the exotic one: a chat binds to whatever directory
 * the user picked, and most directories are not checkouts. Leaving it to fall
 * through made the panel answer 500 for the most common folder there is.
 *
 * Both map to `no-remote`, which already means "this folder has nothing to ask
 * GitHub about". A separate state for "not even a repository" would be a second
 * spelling of one condition, and the panel would owe both branches an identical
 * empty view — the day they stop matching is the day nobody notices.
 */
const NO_REMOTE_PATTERN = /no git remotes found|not a git repository/i;
const NOT_GITHUB_REMOTE_PATTERN =
  /(?:none of the git remotes.*known GitHub host|not a GitHub repository)/i;

/** Either the repository this checkout points at, or why there is not one. */
export type GithubRepoResolution = GithubUnavailableState | { state: 'ok'; repo: GithubRepo };

export type ResolveGithubRepo = (
  workdir: string,
  selection: GhRuntimeSelection,
  signal?: AbortSignal
) => Promise<GithubRepoResolution>;

/**
 * Builds the ladder over one gh facade.
 *
 * @example
 * const resolveRepo = createGithubRepoResolver(ghCli);
 * const resolution = await resolveRepo(workdir, { userId, environmentId });
 * if (resolution.state !== 'ok') return resolution;
 */
export function createGithubRepoResolver(client: GithubCli): ResolveGithubRepo {
  return async (workdir, selection, signal) => {
    if (!(await client.isAvailable(selection))) return { state: 'gh-not-installed' };
    if (!(await client.isAuthenticated(selection))) return { state: 'not-authenticated' };

    try {
      const result = await client.run('repo.view', {}, { cwd: workdir, selection, signal });
      const repo = readGhOutput('repo.view', result.stdout, GhRepoOutputSchema, (output) => ({
        nameWithOwner: output.nameWithOwner,
        defaultBranch: output.defaultBranchRef.name,
        url: output.url,
      }));
      return { state: 'ok', repo };
    } catch (error) {
      if (matchesGhError(error, NO_REMOTE_PATTERN)) return { state: 'no-remote' };
      if (matchesGhError(error, NOT_GITHUB_REMOTE_PATTERN)) return { state: 'not-a-github-remote' };
      throw error;
    }
  };
}

/**
 * Splits `owner/name` for the GraphQL document, which takes the two separately.
 *
 * @example
 * splitNameWithOwner('mango/mangostudio'); // { owner: 'mango', name: 'mangostudio' }
 */
export function splitNameWithOwner(nameWithOwner: string): { owner: string; name: string } {
  const separator = nameWithOwner.indexOf('/');
  if (separator <= 0 || separator === nameWithOwner.length - 1) {
    throw new TypeError(`Not an owner/name repository reference: "${nameWithOwner}".`);
  }
  return {
    owner: nameWithOwner.slice(0, separator),
    name: nameWithOwner.slice(separator + 1),
  };
}

/** gh reports both "no remote" cases as exit 1 with prose on stderr. */
function matchesGhError(error: unknown, pattern: RegExp): boolean {
  return error instanceof GhCliError && error.exitCode === 1 && pattern.test(error.stderr);
}
