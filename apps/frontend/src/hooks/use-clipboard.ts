import { useCallback, useEffect, useRef, useState } from 'react';

const DEFAULT_RESET_MS = 2000;

interface UseClipboardOptions {
  /** How long the `copied` flag stays true after a successful write. */
  readonly resetAfterMs?: number;
}

interface UseClipboardResult {
  readonly copy: (text: string) => Promise<boolean>;
  readonly copied: boolean;
  readonly failed: boolean;
}

/**
 * Clipboard write with transient success/failure state for copy buttons.
 *
 * Usage: const { copy, copied, failed } = useClipboard();
 */
export function useClipboard(options: UseClipboardOptions = {}): UseClipboardResult {
  const resetAfterMs = options.resetAfterMs ?? DEFAULT_RESET_MS;
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearResetTimer = useCallback(() => {
    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearResetTimer, [clearResetTimer]);

  const copy = useCallback(
    async (text: string): Promise<boolean> => {
      clearResetTimer();
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setFailed(false);
        resetTimerRef.current = setTimeout(() => {
          setCopied(false);
          resetTimerRef.current = null;
        }, resetAfterMs);
        return true;
      } catch {
        setCopied(false);
        setFailed(true);
        return false;
      }
    },
    [clearResetTimer, resetAfterMs]
  );

  return { copy, copied, failed };
}
