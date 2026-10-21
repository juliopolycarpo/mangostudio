import type { GithubInboxResponse, GithubUnavailableState } from '@mangostudio/shared/github';

/**
 * The two states that are about the machine `gh` runs on rather than the
 * repository being read: the CLI is missing or signed out wherever the chat
 * runs, so every read on the panel — the inbox and the repository alike — is
 * going to say the same thing.
 */
type MachineUnavailableState = Extract<
  GithubUnavailableState['state'],
  'gh-not-installed' | 'not-authenticated'
>;

/**
 * The machine-level state an inbox answer carries, or null for everything else
 * (still loading, a failed read, a repository-scoped state, an `ok` payload).
 *
 * Read off the inbox because it is the one query that never depends on the
 * repository: `no-remote` and `not-a-github-remote` can only come from the
 * repository reads while the inbox is `ok`, so a panel-wide check built from
 * any other query would hide a working half behind a state that is not its own.
 *
 * @example
 * const machine = machineUnavailableState(inbox.data);
 * if (machine) return <GithubNotConnected state={machine} />;
 */
export function machineUnavailableState(
  data: GithubInboxResponse | undefined
): MachineUnavailableState | null {
  const state = data?.state;
  return state === 'gh-not-installed' || state === 'not-authenticated' ? state : null;
}
