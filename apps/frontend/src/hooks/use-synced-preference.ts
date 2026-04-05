import { useCallback, useRef, useEffect, useSyncExternalStore } from 'react';
import { client } from '@/lib/api-client';

const SYNC_DEBOUNCE_MS = 1500;

/**
 * Reads a JSON value from localStorage.
 */
function readLocal<T>(storageKey: string, defaultValue: T): T {
  try {
    const raw = localStorage.getItem(storageKey);
    return raw ? (JSON.parse(raw) as T) : defaultValue;
  } catch {
    return defaultValue;
  }
}

function writeLocal<T>(storageKey: string, value: T): void {
  localStorage.setItem(storageKey, JSON.stringify(value));
}

// Notify subscribers when localStorage changes via this module.
const subscribers = new Set<() => void>();
function emitChange() {
  subscribers.forEach((cb) => cb());
}

/**
 * A hook that keeps a preference in localStorage (fast, offline-first)
 * and syncs it to the server in the background (debounced fire-and-forget).
 *
 * Read path: localStorage → if empty → API GET → populate localStorage.
 * Write path: localStorage immediately → debounced API PUT.
 */
export function useSyncedPreference<T>(
  key: string,
  storageKey: string,
  defaultValue: T
): [T, (updater: T | ((prev: T) => T)) => void] {
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasFetchedRef = useRef(false);

  // Subscribe to localStorage changes via useSyncExternalStore.
  const value = useSyncExternalStore<T>(
    useCallback((cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    }, []),
    () => readLocal(storageKey, defaultValue),
    () => defaultValue
  );

  // Background fetch from server on first mount (only if localStorage empty).
  useEffect(() => {
    if (hasFetchedRef.current) return;
    hasFetchedRef.current = true;

    const raw = localStorage.getItem(storageKey);
    if (raw !== null) return; // localStorage has data, no need to fetch

    void (async () => {
      try {
        const { data } = await (client as any).api.settings.preferences.get();
        if (!Array.isArray(data)) return;
        const pref = data.find((p: { key: string }) => p.key === key);
        if (pref) {
          writeLocal(storageKey, pref.value);
          emitChange();
        }
      } catch {
        // Server unavailable — localStorage is the fallback
      }
    })();
  }, [key, storageKey]);

  const setValue = useCallback(
    (updater: T | ((prev: T) => T)) => {
      const current = readLocal(storageKey, defaultValue);
      const next = typeof updater === 'function' ? (updater as (prev: T) => T)(current) : updater;

      writeLocal(storageKey, next);
      emitChange();

      // Debounced server sync
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        void (client as any).api.settings.preferences.put({ key, value: next }).catch(() => {
          // Silent fail — localStorage is authoritative
        });
      }, SYNC_DEBOUNCE_MS);
    },
    [key, storageKey, defaultValue]
  );

  return [value, setValue];
}
