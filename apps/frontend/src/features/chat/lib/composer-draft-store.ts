/**
 * Unsent composer text, per chat, for as long as the tab is open.
 *
 * An external store rather than component state for two reasons. Switching
 * chats used to drop whatever was half-written, because the composer unmounts
 * its value with the conversation — that is the bug this fixes. And the
 * workspace hub's prompt starters need to *fill* the composer rather than send
 * through it, which from a sibling component is either this or a prop chain
 * threaded through `ChatPage` purely to move a string sideways.
 *
 * `sessionStorage`, not `localStorage`: a draft is a thing you were in the
 * middle of, and one restored a week later in a different window is a surprise,
 * not a convenience. Every access is guarded — a browser with storage disabled
 * loses persistence across reloads and keeps everything else.
 */

const KEY_PREFIX = 'mangostudio:composer-draft:';
/** A chat that does not exist yet still has a draft: the one being written now. */
const NEW_CHAT_KEY = 'new';

/**
 * In-memory truth, so a keystroke costs a `Map.set` and not a storage parse.
 * `sessionStorage` is the mirror this is rehydrated from, never read past the
 * first access for a given chat.
 */
const drafts = new Map<string, string>();
const listeners = new Set<() => void>();

function storageKey(chatId: string | null): string {
  return `${KEY_PREFIX}${chatId ?? NEW_CHAT_KEY}`;
}

function readStored(chatId: string | null): string {
  try {
    return sessionStorage.getItem(storageKey(chatId)) ?? '';
  } catch {
    return '';
  }
}

function writeStored(chatId: string | null, text: string): void {
  try {
    if (text) sessionStorage.setItem(storageKey(chatId), text);
    else sessionStorage.removeItem(storageKey(chatId));
  } catch {
    // Storage refused (disabled, or quota). The in-memory draft still holds
    // for this session, which is the part the user notices.
  }
}

export function getComposerDraft(chatId: string | null): string {
  const cacheKey = chatId ?? NEW_CHAT_KEY;
  const cached = drafts.get(cacheKey);
  if (cached !== undefined) return cached;
  const stored = readStored(chatId);
  drafts.set(cacheKey, stored);
  return stored;
}

export function setComposerDraft(chatId: string | null, text: string): void {
  const cacheKey = chatId ?? NEW_CHAT_KEY;
  if (drafts.get(cacheKey) === text) return;
  drafts.set(cacheKey, text);
  writeStored(chatId, text);
  for (const listener of listeners) listener();
}

export function subscribeComposerDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * "I put something in the composer, now put the cursor there."
 *
 * A separate channel from the draft itself because they are different events:
 * the hub's starters want both, and restoring a draft on a chat switch wants
 * only the first — stealing focus every time the user changes conversation
 * would fight anyone navigating with the keyboard.
 */
const focusListeners = new Set<() => void>();

export function requestComposerFocus(): void {
  for (const listener of focusListeners) listener();
}

export function onComposerFocusRequest(listener: () => void): () => void {
  focusListeners.add(listener);
  return () => {
    focusListeners.delete(listener);
  };
}

/** Test seam: the module-level cache outlives a component tree. */
export function resetComposerDraftsForTest(): void {
  drafts.clear();
  listeners.clear();
  focusListeners.clear();
}
