import type { GithubContext, GithubPr, GithubRepo } from '@mangostudio/shared/github';
import { GithubPrSchema } from '@mangostudio/shared/github';
import { type Static, type TSchema, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { GhCliError, type GithubCli, ghCli } from '../infrastructure/gh-cli';

const GhRepoOutputSchema = Type.Object({
  nameWithOwner: Type.String(),
  defaultBranchRef: Type.Object({ name: Type.String() }),
  url: Type.String(),
});

const NO_REMOTE_PATTERN = /no git remotes found/i;
const NOT_GITHUB_REMOTE_PATTERN =
  /(?:none of the git remotes.*known GitHub host|not a GitHub repository)/i;
const NO_PULL_REQUEST_PATTERN = /no pull requests found/i;

export class GithubContextError extends Error {
  readonly code = 'GH_OUTPUT_INVALID';

  constructor(readonly command: 'repo view' | 'pr view') {
    super(`GitHub CLI returned invalid JSON for ${command}.`);
    this.name = 'GithubContextError';
  }
}

export type GetGithubContext = (workdir: string, signal?: AbortSignal) => Promise<GithubContext>;

export function createGithubContextService(client: GithubCli): GetGithubContext {
  return async (workdir, signal) => {
    if (!(await client.isAvailable(workdir))) return { state: 'gh-not-installed' };
    if (!(await client.isAuthenticated(workdir))) return { state: 'not-authenticated' };

    let repo: GithubRepo;
    try {
      const result = await client.viewRepo(workdir, signal);
      const output = parseGhOutput(result.stdout, GhRepoOutputSchema, 'repo view');
      repo = {
        nameWithOwner: output.nameWithOwner,
        defaultBranch: output.defaultBranchRef.name,
        url: output.url,
      };
    } catch (error) {
      if (matchesGhError(error, NO_REMOTE_PATTERN)) return { state: 'no-remote' };
      if (matchesGhError(error, NOT_GITHUB_REMOTE_PATTERN)) {
        return { state: 'not-a-github-remote' };
      }
      throw error;
    }

    let pr: GithubPr | null;
    try {
      const result = await client.viewCurrentPr(workdir, signal);
      pr = parseGhOutput(result.stdout, GithubPrSchema, 'pr view');
    } catch (error) {
      if (matchesGhError(error, NO_PULL_REQUEST_PATTERN)) pr = null;
      else throw error;
    }

    return { state: 'ok', repo, pr };
  };
}

export const getGithubContext = createGithubContextService(ghCli);

function matchesGhError(error: unknown, pattern: RegExp): boolean {
  return error instanceof GhCliError && error.exitCode === 1 && pattern.test(error.stderr);
}

function parseGhOutput<T extends TSchema>(
  stdout: string,
  schema: T,
  command: 'repo view' | 'pr view'
): Static<T> {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new GithubContextError(command);
  }
  if (!Value.Check(schema, value)) throw new GithubContextError(command);
  return value as Static<T>;
}
