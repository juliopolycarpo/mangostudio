/**
 * How much each harness has actually been used lately.
 *
 * The agents card names which CLIs a machine can run a turn with; on a
 * cross-workspace surface that list is more useful next to how many sessions
 * each of them answered in. Counted client-side from the chat list the shell
 * already holds — a "sessions per vendor" endpoint would be a second source of
 * truth for a number the browser can add up.
 *
 * A window rather than a lifetime total: the question is which harness the
 * week has been spent on, and a lifetime count only ever grows, so it stops
 * distinguishing anything after the first month.
 */

import type { Chat } from '@mangostudio/shared';
import { runnerKey } from '@/features/sidebar/lib/runner-badge';

/** The window the card reports over. */
export const HARNESS_SESSION_WINDOW_MS = 7 * 86_400_000;

/**
 * Sessions per harness key (`mangostudio`, or a vendor's target id) that were
 * touched at or after `sinceMs`.
 *
 * Keyed by `runnerKey` so the counts line up with the pills the agents card
 * draws from discovery, which are keyed by target id too. Harnesses with no
 * session in the window are simply absent rather than present as `0` — the
 * caller reads a missing key as "nothing this week", and a zero-filled record
 * would need the discovery list to build in the first place.
 *
 * // Usage: harnessSessionCounts(chats, Date.now() - HARNESS_SESSION_WINDOW_MS)
 */
export function harnessSessionCounts(
  chats: readonly Chat[],
  sinceMs: number
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const chat of chats) {
    if (chat.updatedAt < sinceMs) continue;
    const key = runnerKey(chat.runner);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
