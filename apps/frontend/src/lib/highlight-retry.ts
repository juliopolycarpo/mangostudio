import { scheduleIdle } from '@/features/chat/transcript-read-ahead';

/**
 * The longest a retry waits for an idle moment. A page that is never idle still colours its
 * stopped blocks after this, because the compile that stopped them is already paid.
 */
export const HIGHLIGHT_RETRY_IDLE_TIMEOUT_MS = 1_000;

/**
 * Asks again for blocks the highlighter stopped on its time limit, one per idle callback so a
 * run of them never holds the main thread longer than one capped tokenize. Each `retries` entry
 * tokenizes its block again and returns whether it is now coloured; `onRecovered` runs once,
 * after the last, when any was, so the caller renders once and not once per block.
 *
 * @returns a function that cancels what has not run yet. Call it on unmount and when the content
 *   changes: the blocks it was asked about are no longer the ones on screen.
 */
// Usage: const cancel = retryStoppedHighlights([() => highlightCode(code, 'ts', theme) !== null], redraw);
export function retryStoppedHighlights(
  retries: readonly (() => boolean)[],
  onRecovered: () => void
): () => void {
  let cancelPending: (() => void) | undefined;
  let recovered = false;

  const runFrom = (index: number): void => {
    const retry = retries[index];
    if (retry === undefined) {
      if (recovered) onRecovered();
      return;
    }
    cancelPending = scheduleIdle(() => {
      recovered = retry() || recovered;
      runFrom(index + 1);
    }, HIGHLIGHT_RETRY_IDLE_TIMEOUT_MS);
  };
  runFrom(0);

  return () => cancelPending?.();
}
