/**
 * The composer's text, read from the per-chat draft store so it survives a
 * chat switch and can be written from outside the composer (the hub's prompt
 * starters). See `lib/composer-draft-store.ts` for why it is a store.
 */

import { useCallback, useSyncExternalStore } from 'react';
import {
  getComposerDraft,
  setComposerDraft,
  subscribeComposerDrafts,
} from '../lib/composer-draft-store';

export function useComposerDraft(chatId: string | null): readonly [string, (text: string) => void] {
  // Strings compare by value, so a snapshot that re-reads the map on every
  // store notification still bails out of the render when nothing changed for
  // *this* chat — which is what makes one shared listener set safe.
  const draft = useSyncExternalStore(
    subscribeComposerDrafts,
    () => getComposerDraft(chatId),
    () => ''
  );
  const setDraft = useCallback((text: string) => setComposerDraft(chatId, text), [chatId]);
  return [draft, setDraft];
}
