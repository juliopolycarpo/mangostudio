/**
 * Shell-style prompt recall for the composer: ↑ walks back through what you
 * sent in this chat, ↓ walks forward and out again.
 *
 * The navigation rules are the interesting part and they are pure, so they are
 * asserted directly rather than through a rendered textarea:
 *
 * - `index === null` means "not in history"; the composer is showing whatever
 *   the user typed.
 * - Walking back from `null` starts at the most recent entry and stashes the
 *   in-progress text, so walking all the way forward restores it rather than
 *   leaving an empty box.
 * - Walking back past the oldest entry stays there. A shell does the same, and
 *   wrapping around to the newest would silently discard where you were.
 */

const KEY_PREFIX = 'mangostudio:composer-history:';
/** Deep enough to reach yesterday's prompt, shallow enough to stay a session value. */
export const PROMPT_HISTORY_LIMIT = 50;

export interface PromptHistoryCursor {
  /** Most recent first. */
  readonly entries: readonly string[];
  /** Position in `entries`, or null while the composer shows live text. */
  readonly index: number | null;
  /** The live text ↓ restores on the way out. Empty when nothing was stashed. */
  readonly draft: string;
}

export interface PromptRecall {
  readonly index: number | null;
  readonly text: string;
}

/**
 * // Usage: recallPrevious({entries, index: null, draft: 'half typed'})
 */
export function recallPrevious(cursor: PromptHistoryCursor): PromptRecall | null {
  if (cursor.entries.length === 0) return null;
  if (cursor.index === null) return { index: 0, text: cursor.entries[0] };
  const next = cursor.index + 1;
  // Already at the oldest entry: hold, rather than wrapping to the newest.
  if (next >= cursor.entries.length) return null;
  return { index: next, text: cursor.entries[next] };
}

export function recallNext(cursor: PromptHistoryCursor): PromptRecall | null {
  if (cursor.index === null) return null;
  const next = cursor.index - 1;
  // Walking out the front restores what was being written when ↑ was pressed.
  if (next < 0) return { index: null, text: cursor.draft };
  return { index: next, text: cursor.entries[next] };
}

function storageKey(chatId: string | null): string {
  return `${KEY_PREFIX}${chatId ?? 'new'}`;
}

export function readPromptHistory(chatId: string | null): readonly string[] {
  try {
    const raw = sessionStorage.getItem(storageKey(chatId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    // Anything else in that slot is somebody else's data or a stale shape;
    // an unusable history is an empty one, never a thrown render.
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

/**
 * Records a sent prompt at the front, deduplicating against the previous entry
 * only — re-sending the same prompt twice in a row is one history item, but the
 * same prompt sent again after three others is genuinely where you left it.
 */
export function recordPrompt(chatId: string | null, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const existing = readPromptHistory(chatId);
  if (existing[0] === trimmed) return;
  const next = [trimmed, ...existing].slice(0, PROMPT_HISTORY_LIMIT);
  try {
    sessionStorage.setItem(storageKey(chatId), JSON.stringify(next));
  } catch {
    // History is a convenience; losing it to a full or disabled store is not
    // worth failing a send over.
  }
}
