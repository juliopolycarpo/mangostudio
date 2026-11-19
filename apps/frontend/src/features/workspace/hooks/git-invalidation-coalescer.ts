import type { GitScope } from '@mangostudio/shared/realtime';

/** Applies one chat's merged scopes; the coalescer calls it once per chat per window. */
export type ApplyGitInvalidation = (chatId: string, scopes: ReadonlySet<GitScope>) => Promise<void>;

export interface GitInvalidationCoalescer {
  /**
   * Queues the scopes for the chat and resolves once the window they landed in
   * has been applied. Scopes queued for one chat in the same window merge, so a
   * write announced on both `git:<chatId>` and `repo:<key>` refetches that chat
   * once, not twice.
   */
  schedule: (chatId: string, scopes: readonly GitScope[]) => Promise<void>;
}

/**
 * Merges the realtime frames that describe one write.
 *
 * The hub publishes a write on the per-chat topic and on the repository topic,
 * and a repository frame names every chat in the repo. Invalidating on each
 * frame would refetch the writer's own queries twice, since a second
 * invalidation cancels the fetch the first one started, and would send one
 * badge request per chat instead of one per batch. Holding the frames for a
 * short window turns both into one invalidation per chat, and applying every
 * chat of the window in one synchronous pass lets the summary batcher send them
 * as a single request.
 *
 * The window is fixed from the first frame and never extended, so a steady
 * stream of frames cannot postpone a refresh.
 *
 * @example
 * const coalescer = createGitInvalidationCoalescer(apply, 50);
 * void coalescer.schedule('chat-a', ['state']);
 * void coalescer.schedule('chat-a', ['github']); // one apply: ['state', 'github']
 */
export function createGitInvalidationCoalescer(
  apply: ApplyGitInvalidation,
  windowMs: number
): GitInvalidationCoalescer {
  let pending = new Map<string, Set<GitScope>>();
  let settled: Promise<void> | null = null;

  const flush = async (): Promise<void> => {
    const batch = pending;
    pending = new Map();
    settled = null;
    // Started in one synchronous pass: every chat's refetch begins in the same
    // turn, which is what lets the batcher share a request between them.
    await Promise.all([...batch].map(([chatId, scopes]) => apply(chatId, scopes)));
  };

  return {
    schedule(chatId, scopes) {
      const merged = pending.get(chatId) ?? new Set<GitScope>();
      for (const scope of scopes) merged.add(scope);
      pending.set(chatId, merged);
      settled ??= new Promise<void>((resolve) => {
        setTimeout(() => {
          // A failed refetch is the query's to report; the window still ends.
          void flush().then(
            () => resolve(),
            () => resolve()
          );
        }, windowMs);
      });
      return settled;
    },
  };
}
