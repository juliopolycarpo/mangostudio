import type { Locale, Messages } from '@mangostudio/shared/i18n';
import { messages as en } from '@mangostudio/shared/i18n/en';

/** Where the user's language choice is persisted between visits. */
export const LOCALE_STORAGE_KEY = 'mangostudio:locale';

/** A locale together with the dictionary that renders it. */
export interface ResolvedDictionary {
  locale: Locale;
  messages: Messages;
}

/** Fetches one locale's dictionary; in the bundle, a dynamic `import()` of its chunk. */
type DictionaryLoader = () => Promise<Messages>;

/**
 * Hands out locale dictionaries: the eager one synchronously, every other one
 * from its own chunk, loaded once and shared by every caller.
 */
export interface LocaleDictionaryStore {
  /**
   * Resolves the dictionary for `locale`. Never rejects: a failed load resolves
   * to the eager dictionary, whose `locale` is then the one actually rendered.
   */
  load(locale: Locale): Promise<ResolvedDictionary>;
  /** The settled dictionary for `locale`, or `null` while it is not loaded yet. */
  resolved(locale: Locale): ResolvedDictionary | null;
}

interface LocaleDictionaryStoreOptions {
  /** The dictionary bundled in the entry chunk; the fallback for a failed load. */
  eager: ResolvedDictionary;
  /** One loader per locale that is not the eager one. */
  loaders: Partial<Record<Locale, DictionaryLoader>>;
  /** Told about each failed load, after the fallback is in place. */
  onLoadError: (locale: Locale, error: unknown) => void;
}

type Entry =
  | { status: 'loading'; promise: Promise<ResolvedDictionary> }
  | { status: 'ready'; value: ResolvedDictionary }
  | { status: 'failed' };

/**
 * Creates a store that loads each non-eager locale at most once at a time, and
 * again only after a failure.
 *
 * Usage:
 * ```ts
 * const store = createLocaleDictionaryStore({
 *   eager: { locale: 'en', messages: en },
 *   loaders: { 'pt-BR': () => import('@mangostudio/shared/i18n/pt-BR').then((m) => m.messages) },
 *   onLoadError: (locale, error) => console.warn(locale, error),
 * });
 * const { locale, messages } = await store.load('pt-BR');
 * ```
 */
export function createLocaleDictionaryStore(
  options: LocaleDictionaryStoreOptions
): LocaleDictionaryStore {
  const { eager, loaders, onLoadError } = options;
  const entries = new Map<Locale, Entry>();

  function start(locale: Locale): Promise<ResolvedDictionary> {
    const loader = loaders[locale];
    const loaded = loader
      ? loader()
      : Promise.reject(
          new Error(
            `No dictionary loader for locale "${locale}"; expected one of: ${Object.keys(loaders).join(', ')}`
          )
        );
    const promise = loaded.then(
      (messages) => {
        const value = { locale, messages };
        entries.set(locale, { status: 'ready', value });
        return value;
      },
      (error: unknown) => {
        entries.set(locale, { status: 'failed' });
        onLoadError(locale, error);
        return eager;
      }
    );
    entries.set(locale, { status: 'loading', promise });
    return promise;
  }

  function load(locale: Locale): Promise<ResolvedDictionary> {
    if (locale === eager.locale) return Promise.resolve(eager);
    const entry = entries.get(locale);
    if (entry?.status === 'ready') return Promise.resolve(entry.value);
    if (entry?.status === 'loading') return entry.promise;
    return start(locale);
  }

  function resolved(locale: Locale): ResolvedDictionary | null {
    if (locale === eager.locale) return eager;
    const entry = entries.get(locale);
    if (entry?.status === 'ready') return entry.value;
    if (entry?.status === 'failed') return eager;
    return null;
  }

  return { load, resolved };
}

/**
 * The app's store: English is in the entry chunk, Portuguese is its own chunk.
 *
 * Usage: `const { messages } = await localeDictionaries.load('pt-BR');`
 */
export const localeDictionaries: LocaleDictionaryStore = createLocaleDictionaryStore({
  eager: { locale: 'en', messages: en },
  loaders: {
    'pt-BR': () => import('@mangostudio/shared/i18n/pt-BR').then((module) => module.messages),
  },
  onLoadError: (locale, error) => {
    console.warn(`[i18n] Could not load the "${locale}" dictionary; rendering "en".`, error);
  },
});

/**
 * The locale to start in: the stored choice, else the browser language.
 *
 * Usage: `const locale = detectLocale(); // 'pt-BR' for navigator.language 'pt-PT'`
 */
export function detectLocale(): Locale {
  const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
  if (stored === 'pt-BR' || stored === 'en') return stored;
  if (navigator.language.startsWith('pt')) return 'pt-BR';
  return 'en';
}

/**
 * Starts loading the startup locale's dictionary. Call it once at boot, before
 * the first render, so the chunk downloads alongside the session request
 * instead of after it.
 *
 * Usage (in `main.tsx`): `preloadStartupLocale();`
 */
export function preloadStartupLocale(
  store: LocaleDictionaryStore = localeDictionaries
): Promise<ResolvedDictionary> {
  return store.load(detectLocale());
}
