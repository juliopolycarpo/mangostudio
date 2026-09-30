import type { Locale, Messages } from '@mangostudio/shared/i18n';
import type { ReactNode } from 'react';
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StartupSpinner } from '@/components/layout/StartupSpinner';
import {
  detectLocale,
  LOCALE_STORAGE_KEY,
  type LocaleDictionaryStore,
  localeDictionaries,
  type ResolvedDictionary,
} from '@/lib/locale-dictionaries';

interface I18nContextValue {
  t: Messages;
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

const I18nContext = createContext<I18nContextValue | null>(null);

interface I18nProviderProps {
  children: ReactNode;
  /** Where dictionaries come from; tests pass an in-memory store. */
  dictionaries?: LocaleDictionaryStore;
}

/**
 * Provides the active locale and its dictionary to `useI18n()`.
 *
 * The startup locale's dictionary is normally already loaded by the time this
 * mounts (`preloadStartupLocale()` starts it before the first render, and the
 * router runs its loaders before this root component renders). Until it
 * settles, a spinner renders instead of English text that would flip to
 * Portuguese a moment later. A runtime switch keeps the current dictionary on
 * screen until the next one arrives, and a failed load renders the eager one.
 *
 * Usage: `<I18nProvider><App /></I18nProvider>`
 */
export function I18nProvider({ children, dictionaries = localeDictionaries }: I18nProviderProps) {
  const [startupLocale] = useState(detectLocale);
  const [active, setActive] = useState<ResolvedDictionary | null>(() =>
    dictionaries.resolved(startupLocale)
  );
  const latestSwitch = useRef(0);

  useEffect(() => {
    if (active) return;
    let cancelled = false;
    void dictionaries.load(startupLocale).then((resolved) => {
      if (!cancelled) setActive(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [active, dictionaries, startupLocale]);

  const changeLocale = useCallback(
    (next: Locale) => {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
      latestSwitch.current += 1;
      const request = latestSwitch.current;
      void dictionaries.load(next).then((resolved) => {
        if (request === latestSwitch.current) setActive(resolved);
      });
    },
    [dictionaries]
  );

  const value = useMemo(
    () => (active ? { t: active.messages, locale: active.locale, setLocale: changeLocale } : null),
    [active, changeLocale]
  );

  if (!value) return <StartupSpinner />;
  return <I18nContext value={value}>{children}</I18nContext>;
}

export function useI18n(): I18nContextValue {
  const ctx = use(I18nContext);
  if (!ctx) throw new Error('useI18n deve ser usado dentro de I18nProvider');
  return ctx;
}
