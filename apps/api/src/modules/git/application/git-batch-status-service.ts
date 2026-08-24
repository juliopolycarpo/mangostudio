import type { GitStatus, GitSummary } from '@mangostudio/shared/git';
import { GitCliError, type GitRuntimeSelection, isGitAvailable } from '../infrastructure/git-cli';
import { getRepoRoot, getRepoStatus } from './git-status-service';

/**
 * Each unique workdir shells out to git (possibly over a runtime connection),
 * so a full 50-chat batch spanning many repositories is throttled rather than
 * spawned all at once. Bounds one request; nothing bounds a user (see #935).
 *
 * Exported so the test that guards the bound names it instead of restating the
 * number, which would otherwise have to be edited in lockstep to move it.
 */
export const WORKDIR_CONCURRENCY = 4;

/** The columns the batch needs; callers pass ownership-filtered rows. */
export interface GitSummaryChat {
  readonly id: string;
  readonly workdir: string | null;
  readonly environmentId: string;
}

export interface BatchGitSummariesInput {
  /** Every id the caller asked about; ids without an owned chat answer `null`. */
  readonly chatIds: readonly string[];
  /** The requester's chats for those ids — foreign/unknown ids must be absent. */
  readonly chats: readonly GitSummaryChat[];
  readonly userId: string;
  readonly signal?: AbortSignal;
  /** Test seams; production callers leave these unset. */
  readonly computeSummary?: typeof computeGitSummary;
  readonly checkGitAvailable?: (selection: GitRuntimeSelection) => Promise<boolean>;
}

/** The slim status read behind one batch entry: repo root probe + porcelain status. */
export async function computeGitSummary(
  workdir: string,
  selection: GitRuntimeSelection,
  signal?: AbortSignal
): Promise<GitSummary | null> {
  const root = await getRepoRoot(workdir, signal, selection);
  if (!root) return null;
  return toGitSummary(workdir, await getRepoStatus(root, signal, selection));
}

function toGitSummary(workdir: string, status: GitStatus): GitSummary {
  // A path can sit in both the index and the worktree; a badge counts files,
  // not entries.
  const changedPaths = new Set<string>();
  for (const bucket of [status.staged, status.unstaged, status.untracked, status.conflicted]) {
    for (const change of bucket) changedPaths.add(change.path);
  }
  return {
    branch: status.branch.name,
    ...(status.branch.detachedAt === undefined ? {} : { detachedAt: status.branch.detachedAt }),
    ahead: status.branch.ahead,
    behind: status.branch.behind,
    changedFileCount: changedPaths.size,
    workdir,
  };
}

interface WorkdirGroup {
  readonly selection: GitRuntimeSelection;
  readonly workdir: string;
  readonly chatIds: string[];
}

/**
 * Answers "git state for these N chats" with one status read per unique
 * workdir. Grouping keys on environment *and* workdir: git runs through the
 * per-environment runtime client, so the same path on two environments is two
 * different repositories. (Two workdirs inside one repository still read
 * twice — resolving the shared root would itself cost the `rev-parse` this
 * would save.)
 *
 * A chat without an answer is absent from the result rather than failing the
 * batch; the wire contract keeps absence indistinguishable across the causes.
 */
export async function getBatchGitSummaries(
  input: BatchGitSummariesInput
): Promise<Record<string, GitSummary>> {
  const computeSummary = input.computeSummary ?? computeGitSummary;
  const checkGitAvailable = input.checkGitAvailable ?? isGitAvailable;

  const requested = new Set(input.chatIds);
  const summaries: Record<string, GitSummary> = {};

  const groups = new Map<string, WorkdirGroup>();
  for (const chat of input.chats) {
    if (!chat.workdir || !requested.has(chat.id)) continue;
    const key = `${chat.environmentId}\0${chat.workdir}`;
    const group = groups.get(key);
    if (group) {
      group.chatIds.push(chat.id);
    } else {
      groups.set(key, {
        selection: { userId: input.userId, environmentId: chat.environmentId },
        workdir: chat.workdir,
        chatIds: [chat.id],
      });
    }
  }

  // One availability probe per environment, shared across its workdir groups.
  const availability = new Map<string, Promise<boolean>>();
  const gitAvailable = (selection: GitRuntimeSelection): Promise<boolean> => {
    let available = availability.get(selection.environmentId);
    if (!available) {
      available = checkGitAvailable(selection);
      availability.set(selection.environmentId, available);
    }
    return available;
  };

  await mapWithConcurrency([...groups.values()], WORKDIR_CONCURRENCY, async (group) => {
    // The signal only reaches Git once a command is already running, so
    // without this the worker loop keeps pulling the remaining groups and
    // spawning Git for a response the disconnected client will never read.
    if (input.signal?.aborted) return;
    try {
      if (!(await gitAvailable(group.selection))) return;
      const summary = await computeSummary(group.workdir, group.selection, input.signal);
      if (!summary) return;
      for (const chatId of group.chatIds) summaries[chatId] = summary;
    } catch (error) {
      // A cancelled request is the client hanging up; anything else leaves its
      // chats unanswered without taking the rest of the batch down.
      if (!(error instanceof GitCliError && error.aborted)) {
        console.warn('[git] batch summary failed', { workdir: group.workdir, error });
      }
    }
  });

  return summaries;
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      if (item !== undefined) await run(item);
    }
  });
  await Promise.all(workers);
}
