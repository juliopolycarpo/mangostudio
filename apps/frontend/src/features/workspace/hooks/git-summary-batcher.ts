import type { GitSummary } from '@mangostudio/shared/git';
import { GIT_BATCH_STATE_MAX_CHAT_IDS } from '@mangostudio/shared/git/limits';

/** One request to `POST /git/state/batch`; resolves with the answers it got. */
export type FetchGitSummaryChunk = (
  chatIds: readonly string[]
) => Promise<Record<string, GitSummary>>;

interface PendingRead {
  readonly resolve: (summary: GitSummary | null) => void;
  readonly reject: (error: unknown) => void;
}

export interface GitSummaryBatcher {
  /**
   * Resolves with the chat's summary, or `null` when the server has no answer
   * for it. Rejects only when the request carrying it failed.
   */
  load: (chatId: string) => Promise<GitSummary | null>;
}

/**
 * Coalesces per-chat reads that start in the same turn into batched requests.
 *
 * The sidebar caches one query per chat, so rows scrolled out of view keep their
 * badge and only the rows that newly enter the window cost a request. Each of
 * those queries still wants the batched endpoint rather than an N+1 fan-out, so
 * the reads that start together (a scroll step reveals several rows at once;
 * window focus refetches every mounted badge) leave as one request per
 * {@link GIT_BATCH_STATE_MAX_CHAT_IDS} ids, the most the endpoint accepts.
 *
 * `flushDelayMs` is how long a read waits for company. Zero is a macrotask: late
 * enough for every query a single commit starts, early enough not to be felt.
 *
 * @example
 * const batcher = createGitSummaryBatcher(fetchChunk);
 * const [a, b] = await Promise.all([batcher.load('chat-a'), batcher.load('chat-b')]); // one request
 */
export function createGitSummaryBatcher(
  fetchChunk: FetchGitSummaryChunk,
  flushDelayMs = 0
): GitSummaryBatcher {
  const waiting = new Map<string, PendingRead[]>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    flushTimer = null;
    // Sorted so the request body does not depend on the order rows were read.
    const chatIds = [...waiting.keys()].sort();
    const reads = new Map(waiting);
    waiting.clear();

    for (let start = 0; start < chatIds.length; start += GIT_BATCH_STATE_MAX_CHAT_IDS) {
      const chunk = chatIds.slice(start, start + GIT_BATCH_STATE_MAX_CHAT_IDS);
      fetchChunk(chunk).then(
        (states) => {
          for (const chatId of chunk) {
            for (const read of reads.get(chatId) ?? []) read.resolve(states[chatId] ?? null);
          }
        },
        (error: unknown) => {
          for (const chatId of chunk) {
            for (const read of reads.get(chatId) ?? []) read.reject(error);
          }
        }
      );
    }
  };

  return {
    load: (chatId) =>
      new Promise<GitSummary | null>((resolve, reject) => {
        const readers = waiting.get(chatId);
        if (readers) readers.push({ resolve, reject });
        else waiting.set(chatId, [{ resolve, reject }]);
        flushTimer ??= setTimeout(flush, flushDelayMs);
      }),
  };
}
