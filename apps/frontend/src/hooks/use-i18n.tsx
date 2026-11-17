import type { DeferredNamespace, LoadedMessages, Locale } from '@mangostudio/shared/i18n';
import type { ReactNode } from 'react';
import {
  createContext,
  startTransition,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { StartupSpinner } from '@/components/layout/StartupSpinner';
import {
  detectLocale,
  LOCALE_STORAGE_KEY,
  localeDictionaries,
  type LocaleDictionaryStore,
  type ResolvedDictionary,
} from '@/lib/locale-dictionaries';

/** What `useI18n(...namespaces)` returns: `t` holds the eager namespaces plus the ones named. */
interface I18nContextValue<Namespaces extends DeferredNamespace = never> {
  t: LoadedMessages<Namespaces>;
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

interface I18nProviderState {
  /** The dictionary on screen; its `locale` is the rendered one, not the saved preference. */
  dictionary: ResolvedDictionary;
  /** Where the deferred namespaces of `dictionary` come from. */
  dictionaries: LocaleDictionaryStore;
  setLocale: (locale: Locale) => void;
}

const I18nContext = createContext<I18nProviderState | null>(null);

interface I18nProviderProps {
  children: ReactNode;
  /** Where dictionaries come from; tests pass an in-memory store. */
  dictionaries?: LocaleDictionaryStore;
}

/**
 * Provides the active locale and its dictionary to `useI18n()`.
 *
 * The startup locale's dictionary is normally already loaded by the time this
 * mounts: `preloadStartupLocale()` starts it before the first render, while
 * the session request is still in flight. Waiting here never delays the
 * router's own loading, which starts outside this component. Until it
 * settles, a spinner renders instead of English text that would flip to
 * Portuguese a moment later. A runtime switch keeps the current dictionary on
 * screen until the next one arrives, and a failed load renders the eager one.
 * `document.documentElement.lang` follows the dictionary on screen, not the
 * saved preference, so it is `en` after a failed load and while the startup
 * spinner shows (the `index.html` default).
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

  const renderedLocale = active?.locale;
  useLayoutEffect(() => {
    if (renderedLocale) document.documentElement.lang = renderedLocale;
  }, [renderedLocale]);
  // Routes preload namespaces for what is on screen, which can differ from the saved locale.
  useLayoutEffect(() => {
    if (active) dictionaries.show(active);
  }, [active, dictionaries]);

  const changeLocale = useCallback(
    (next: Locale) => {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
      latestSwitch.current += 1;
      const request = latestSwitch.current;
      void dictionaries.load(next).then((resolved) => {
        // A transition: when the screen reads a deferred namespace this locale has not
        // loaded yet, `useI18n` suspends, and React then keeps the current text up
        // until the namespace arrives instead of flashing the route's fallback.
        if (request === latestSwitch.current) startTransition(() => setActive(resolved));
      });
    },
    [dictionaries]
  );

  const value = useMemo(
    () => (active ? { dictionary: active, dictionaries, setLocale: changeLocale } : null),
    [active, dictionaries, changeLocale]
  );

  if (!value) return <StartupSpinner />;
  return <I18nContext value={value}>{children}</I18nContext>;
}

/**
 * The active locale, its setter and the dictionary. `t` holds the eager
 * namespaces; a deferred namespace (`settings`, `onboarding`) is in `t` only
 * when named, so `useI18n().t.settings` does not type-check and
 * `useI18n('settings').t.settings` does.
 *
 * A named namespace is normally loaded already, because the route or flow that
 * reads it loads it first (`preloadNamespaces` in the route's `loader`). When
 * it is not, the component suspends until it arrives, so a caller that can
 * render before that has to sit under a Suspense boundary that says what shows
 * meanwhile. A chunk that cannot be fetched throws to the nearest error boundary.
 *
 * Usage: `const { t } = useI18n('settings'); return <h1>{t.settings.tabs.general}</h1>;`
 */
export function useI18n<Namespaces extends DeferredNamespace = never>(
  ...namespaces: Namespaces[]
): I18nContextValue<Namespaces> {
  const ctx = use(I18nContext);
  if (!ctx) throw new Error('useI18n deve ser usado dentro de I18nProvider');
  const { dictionary, dictionaries, setLocale } = ctx;
  const t =
    dictionaries.namespaces(dictionary, namespaces) ??
    use(dictionaries.loadNamespaces(dictionary, namespaces));
  // Memoized so a caller can keep the whole result in a dependency list.
  return useMemo(
    () => ({ t, locale: dictionary.locale, setLocale }),
    [t, dictionary.locale, setLocale]
  );
}
