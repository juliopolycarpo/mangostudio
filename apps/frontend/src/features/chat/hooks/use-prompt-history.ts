/**
 * ↑/↓ recall over this chat's sent prompts. The navigation rules live in
 * `lib/prompt-history.ts`; this holds the cursor and the stashed draft.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type PromptHistoryCursor,
  readPromptHistory,
  recallNext,
  recallPrevious,
  recordPrompt,
} from '../lib/prompt-history';

export interface PromptHistoryController {
  /** Returns the text to show, or null when the key should do its normal thing. */
  readonly recall: (direction: 'previous' | 'next', current: string) => string | null;
  /** Called when the user edits by hand: they have left history behind. */
  readonly release: () => void;
  readonly record: (text: string) => void;
  /**
   * Whether the composer is showing a recalled prompt. Decides whether ↑/↓
   * keep walking history or go back to being cursor keys.
   */
  readonly isRecalling: boolean;
}

export function usePromptHistory(chatId: string | null): PromptHistoryController {
  const [index, setIndex] = useState<number | null>(null);
  // The in-progress text ↓ restores, captured when ↑ is first pressed.
  const draftRef = useRef('');

  // A different conversation is a different history. Without this, ↑ in the
  // chat you just switched to would resume at the offset held in the last one.
  useEffect(() => {
    setIndex(null);
    draftRef.current = '';
  }, [chatId]);

  const recall = useCallback(
    (direction: 'previous' | 'next', current: string): string | null => {
      // Read at press time rather than held in state: a send inside this same
      // chat appends to the store, and a cached list would not have it.
      const cursor: PromptHistoryCursor = {
        entries: readPromptHistory(chatId),
        index,
        draft: draftRef.current,
      };
      const result = direction === 'previous' ? recallPrevious(cursor) : recallNext(cursor);
      if (!result) return null;
      // Stashed on the way in, so walking all the way back out restores what
      // was half-written rather than leaving an empty box.
      if (index === null) draftRef.current = current;
      setIndex(result.index);
      return result.text;
    },
    [chatId, index]
  );

  const release = useCallback(() => {
    setIndex(null);
    draftRef.current = '';
  }, []);

  const record = useCallback(
    (text: string) => {
      recordPrompt(chatId, text);
      setIndex(null);
      draftRef.current = '';
    },
    [chatId]
  );

  return { recall, release, record, isRecalling: index !== null };
}
