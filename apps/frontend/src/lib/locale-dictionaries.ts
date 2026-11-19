import type {
  CoreMessages,
  DeferredNamespace,
  FeatureMessages,
  FeatureNamespace,
  LoadedMessages,
  Locale,
  Messages,
} from '@mangostudio/shared/i18n';
import { messages as en } from '@mangostudio/shared/i18n/en';

import { isChunkFetchFailure } from '@/lib/retryable-lazy';
import { staleBuildMonitor } from '@/lib/stale-build';

/** Where the user's language choice is persisted between visits. */
export const LOCALE_STORAGE_KEY = 'mangostudio:locale';

/**
 * A locale together with the dictionary that renders it. `messages` is the
 * eager part; a lazy locale's dictionary carries every deferred namespace too,
 * the eager locale's gets them from `LocaleDictionaryStore.loadNamespaces`.
 */
export interface ResolvedDictionary {
  locale: Locale;
  messages: CoreMessages;
}

/**
 * Fetches one locale's complete dictionary; in the bundle, a dynamic `import()`
 * of its chunk. It returns every namespace, so a lazy locale never needs a
 * second request for a deferred one.
 */
type DictionaryLoader = () => Promise<Messages>;

/** Fetches one deferred namespace of the eager locale; in the bundle, a dynamic `import()`. */
type NamespaceLoaders = {
  [Namespace in DeferredNamespace]: () => Promise<Pick<Messages, Namespace>>;
};

/**
 * Hands out locale dictionaries: the eager one synchronously, every other one
 * from its own chunk, loaded once and shared by every caller. Deferred
 * namespaces of the eager locale load the same way, one chunk each.
 */
export interface LocaleDictionaryStore {
  /**
   * Resolves the dictionary for `locale`. Never rejects: a failed load resolves
   * to the eager dictionary, whose `locale` is then the one actually rendered.
   */
  load(locale: Locale): Promise<ResolvedDictionary>;
  /** The settled dictionary for `locale`, or `null` while it is not loaded yet. */
  resolved(locale: Locale): ResolvedDictionary | null;
  /**
   * Records the dictionary the provider renders. It can differ from the stored
   * choice: a failed Portuguese load at startup renders English while `pt-BR`
   * stays saved, and a retry can make `pt-BR` loadable without the screen moving.
   */
  show(dictionary: ResolvedDictionary): void;
  /** The dictionary last passed to `show`, or `null` before the provider has rendered one. */
  shown(): ResolvedDictionary | null;
  /**
   * `dictionary` with the named deferred namespaces, or `null` while one is
   * still loading. The same arguments return the same object, so the result is
   * safe in a dependency list.
   */
  namespaces<Namespaces extends DeferredNamespace>(
    dictionary: ResolvedDictionary,
    namespaces: readonly Namespaces[]
  ): LoadedMessages<Namespaces> | null;
  /**
   * Loads the named deferred namespaces for `dictionary`, each at most once at a
   * time, and resolves with the same object `namespaces()` then returns. Unlike
   * `load`, it rejects when a chunk cannot be fetched: there is no other locale
   * to fall back to for text that exists only in this chunk. The same arguments
   * return the same promise while one is in flight, so `use()` can suspend on it,
   * and after a failure for one second, so React's re-render of the suspended
   * component meets the same rejection instead of starting another fetch.
   */
  loadNamespaces<Namespaces extends DeferredNamespace>(
    dictionary: ResolvedDictionary,
    namespaces: readonly Namespaces[]
  ): Promise<LoadedMessages<Namespaces>>;
}

interface LocaleDictionaryStoreOptions {
  /** The dictionary bundled in the entry chunk; the fallback for a failed load. */
  eager: ResolvedDictionary;
  /**
   * One loader per deferred namespace the eager dictionary leaves out. Omit it
   * when the eager dictionary already carries them all (tests do).
   */
  eagerNamespaces?: NamespaceLoaders;
  /** One loader per locale that is not the eager one. */
  loaders: Partial<Record<Locale, DictionaryLoader>>;
  /**
   * Told about each failed load. A dictionary load has already fallen back to
   * the eager one by then; a failed `namespace` rejects its `loadNamespaces`.
   */
  onLoadError: (locale: Locale, error: unknown, namespace?: DeferredNamespace) => void;
  /** Clock for the namespace retry window; tests replace it. */
  now?: () => number;
  /** How long a failed namespace request keeps rejecting; defaults to one second. */
  retryAfterMs?: number;
}

type Entry =
  | { status: 'loading'; promise: Promise<ResolvedDictionary> }
  | { status: 'ready'; value: ResolvedDictionary }
  | { status: 'failed' };

type NamespaceEntry =
  { status: 'loading'; promise: Promise<void> } | { status: 'ready'; value: Partial<Messages> };

/** One `loadNamespaces` call's promise; `failedAt` is set when it rejects. */
interface NamespaceRequest {
  promise: Promise<CoreMessages>;
  failedAt: number | null;
}

/** How long a failed namespace request keeps rejecting before the next call asks the network again. */
const NAMESPACE_RETRY_AFTER_MS = 1_000;

/**
 * Whether `messages` holds every named deferred namespace. The type predicate is
 * the one place a plain `CoreMessages` becomes a `LoadedMessages`, and it checks
 * the claim at runtime.
 */
export function carriesNamespaces<Namespaces extends DeferredNamespace>(
  messages: CoreMessages,
  namespaces: readonly Namespaces[]
): messages is LoadedMessages<Namespaces> {
  return namespaces.every((namespace) => namespace in messages);
}

/**
 * One feature's English messages: what an `en-<namespace>` module exports and a
 * `<feature>-i18n.ts` re-exports, so a union with one member per feature namespace.
 */
export type AnyFeatureMessages = { [N in FeatureNamespace]: FeatureMessages<N> }[FeatureNamespace];

/** The feature namespace a `FeatureMessages` value carries. */
type FeatureNamespaceOf<Feature extends AnyFeatureMessages> = Extract<
  keyof Feature,
  FeatureNamespace
>;

/**
 * Whether `messages` already holds every key `feature` would add. A dictionary
 * loaded for another locale is complete (its chunk carries every namespace), and
 * so is the English one in tests; only the eager English dictionary is not.
 * The type predicate is where a plain `CoreMessages` becomes a `LoadedMessages`.
 */
export function carriesFeatureKeys<Feature extends AnyFeatureMessages>(
  messages: CoreMessages,
  feature: Feature
): messages is LoadedMessages<FeatureNamespaceOf<Feature>> {
  const held: Record<string, object | undefined> = messages;
  return Object.entries<object>(feature).every(([namespace, added]) => {
    const present = held[namespace];
    return present !== undefined && Object.keys(added).every((key) => key in present);
  });
}

/** Merged dictionaries by the base object they extend and the feature messages added, so one pair keeps one identity. */
const featureMerges = new WeakMap<CoreMessages, WeakMap<object, CoreMessages>>();

/**
 * `messages` with the English keys a feature's lazy chunk carries. The chunk
 * imports its `en-<namespace>` module and passes it here (through `useI18n`), so
 * the strings arrive with the code that renders them and no request is made for
 * them. Another locale's dictionary already has the keys and comes back as is.
 * The same arguments return the same object, so the result is safe in a dependency list.
 *
 * Usage: `const t = withFeatureMessages(dictionary.messages, libraryMessages);`
 */
export function withFeatureMessages<Base extends CoreMessages, Feature extends AnyFeatureMessages>(
  messages: Base,
  feature: Feature
): Base & LoadedMessages<FeatureNamespaceOf<Feature>> {
  if (carriesFeatureKeys(messages, feature)) return messages;
  const known = featureMerges.get(messages)?.get(feature);
  // Every merge is a copy of the `messages` it came from, so it keeps all of `Base`.
  if (known && carriesFeatureKeys(known, feature)) {
    return known as Base & LoadedMessages<FeatureNamespaceOf<Feature>>;
  }

  const held: Record<string, object | undefined> = messages;
  const combined: Record<string, unknown> = { ...messages };
  for (const [namespace, added] of Object.entries<object>(feature)) {
    combined[namespace] = { ...held[namespace], ...added };
  }
  // `combined` is `messages` plus the feature keys, which the check below proves.
  const merged = combined as unknown as CoreMessages;
  if (!carriesFeatureKeys(merged, feature)) {
    throw new Error(
      `expected the English keys of ${Object.keys(feature).join(', ')} merged into the dictionary | received: keys missing after the merge`
    );
  }
  const byFeature = featureMerges.get(messages) ?? new WeakMap<object, CoreMessages>();
  byFeature.set(feature, merged);
  featureMerges.set(messages, byFeature);
  return merged as Base & LoadedMessages<FeatureNamespaceOf<Feature>>;
}

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
  const {
    eager,
    eagerNamespaces,
    loaders,
    onLoadError,
    now = () => Date.now(),
    retryAfterMs = NAMESPACE_RETRY_AFTER_MS,
  } = options;
  const entries = new Map<Locale, Entry>();
  const namespaceEntries = new Map<string, NamespaceEntry>();
  // One request per locale and namespace set. A failure stays cached for `retryAfterMs`:
  // React re-renders a suspended component with a fresh `loadNamespaces` call once the
  // promise rejects, and a forgotten failure would start a new fetch on every pass.
  const requests = new Map<string, NamespaceRequest>();
  // Merged dictionaries by the core object they extend, so one request keeps one identity.
  const merged = new WeakMap<CoreMessages, Map<string, CoreMessages>>();

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

  function namespaceKey(locale: Locale, namespace: DeferredNamespace): string {
    return `${locale}:${namespace}`;
  }

  /** Starts (or joins) the fetch of one namespace the dictionary does not carry. */
  function loadNamespace(locale: Locale, namespace: DeferredNamespace): Promise<void> {
    const key = namespaceKey(locale, namespace);
    const entry = namespaceEntries.get(key);
    if (entry?.status === 'ready') return Promise.resolve();
    if (entry?.status === 'loading') return entry.promise;
    const loader = locale === eager.locale ? eagerNamespaces?.[namespace] : undefined;
    if (!loader) {
      return Promise.reject(
        new Error(
          `No loader for the "${namespace}" namespace of locale "${locale}" | expected: a dictionary that carries it, or an eagerNamespaces loader for "${eager.locale}"`
        )
      );
    }
    const promise = loader().then(
      (value) => {
        namespaceEntries.set(key, { status: 'ready', value });
      },
      (error: unknown) => {
        // Forgotten, so the next request fetches again instead of replaying the failure.
        namespaceEntries.delete(key);
        onLoadError(locale, error, namespace);
        throw error;
      }
    );
    namespaceEntries.set(key, { status: 'loading', promise });
    return promise;
  }

  function namespaces<Namespaces extends DeferredNamespace>(
    dictionary: ResolvedDictionary,
    wanted: readonly Namespaces[]
  ): LoadedMessages<Namespaces> | null {
    if (carriesNamespaces(dictionary.messages, wanted)) return dictionary.messages;
    const mergeKey = [...wanted].sort().join(',');
    const known = merged.get(dictionary.messages)?.get(mergeKey);
    if (known && carriesNamespaces(known, wanted)) return known;

    const extra: Partial<Messages> = {};
    for (const namespace of wanted) {
      if (namespace in dictionary.messages) continue;
      const entry = namespaceEntries.get(namespaceKey(dictionary.locale, namespace));
      if (entry?.status !== 'ready') return null;
      Object.assign(extra, entry.value);
    }
    const combined = { ...dictionary.messages, ...extra };
    if (!carriesNamespaces(combined, wanted)) return null;
    const byKey = merged.get(dictionary.messages) ?? new Map<string, CoreMessages>();
    byKey.set(mergeKey, combined);
    merged.set(dictionary.messages, byKey);
    return combined;
  }

  function loadNamespaces<Namespaces extends DeferredNamespace>(
    dictionary: ResolvedDictionary,
    wanted: readonly Namespaces[]
  ): Promise<LoadedMessages<Namespaces>> {
    const ready = namespaces(dictionary, wanted);
    if (ready) return Promise.resolve(ready);

    const requestKey = `${dictionary.locale}|${[...wanted].sort().join(',')}`;
    const known = requests.get(requestKey);
    if (known && (known.failedAt === null || now() - known.failedAt < retryAfterMs)) {
      // The request key names the locale and the namespaces, so what it resolves with carries them.
      return known.promise as Promise<LoadedMessages<Namespaces>>;
    }

    const missing = wanted.filter((namespace) => !(namespace in dictionary.messages));
    const promise = Promise.all(
      missing.map((namespace) => loadNamespace(dictionary.locale, namespace))
    ).then(() => {
      const loaded = namespaces(dictionary, wanted);
      if (!loaded) {
        throw new Error(
          `expected namespaces ${wanted.join(', ')} loaded for "${dictionary.locale}" | received: not all present`
        );
      }
      return loaded;
    });
    const request: NamespaceRequest = { promise, failedAt: null };
    requests.set(requestKey, request);
    promise.then(
      () => {
        // Settled for good: `namespaces()` answers from now on.
        if (requests.get(requestKey) === request) requests.delete(requestKey);
      },
      () => {
        request.failedAt = now();
      }
    );
    return promise;
  }

  let shownDictionary: ResolvedDictionary | null = null;
  function show(dictionary: ResolvedDictionary): void {
    shownDictionary = dictionary;
  }
  function shown(): ResolvedDictionary | null {
    return shownDictionary;
  }

  return { load, resolved, show, shown, namespaces, loadNamespaces };
}

/**
 * The app's store: English is in the entry chunk except for the deferred
 * namespaces, which are one chunk each; Portuguese is one chunk with every
 * namespace in it.
 *
 * Usage: `const { messages } = await localeDictionaries.load('pt-BR');`
 */
export const localeDictionaries: LocaleDictionaryStore = createLocaleDictionaryStore({
  eager: { locale: 'en', messages: en },
  eagerNamespaces: {
    settings: () =>
      import('@mangostudio/shared/i18n/en-settings').then((module) => module.messages),
    onboarding: () =>
      import('@mangostudio/shared/i18n/en-onboarding').then((module) => module.messages),
  },
  loaders: {
    'pt-BR': () => import('@mangostudio/shared/i18n/pt-BR').then((module) => module.messages),
  },
  onLoadError: (locale, error, namespace) => {
    console.warn(
      namespace
        ? `[i18n] Could not load the "${namespace}" namespace of "${locale}".`
        : `[i18n] Could not load the "${locale}" dictionary; rendering "en".`,
      error
    );
    // A dictionary chunk the hub no longer has is the same upgrade-under-an-open-tab case.
    if (isChunkFetchFailure(error)) void staleBuildMonitor.check();
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

/**
 * Loads deferred namespaces for the locale on screen, so a route or flow that
 * reads them renders its text on the first commit instead of suspending. Run it
 * from the route's `loader`: TanStack fetches the route's lazy component
 * alongside, so the namespace arrives with the chunk that reads it.
 *
 * It covers two dictionaries: the one the provider renders, and the stored
 * choice (a switch writes it before the provider moves). They differ after a
 * Portuguese chunk failed at startup: English is on screen while `pt-BR` stays
 * saved and may load fine on a later call. Loading only the stored locale would
 * leave the English namespace unloaded and suspend the route that just finished
 * its loader. When they are the same dictionary, it is one load.
 *
 * Rejects when a namespace chunk cannot be fetched, which reaches the route's
 * error component like any route chunk.
 *
 * Usage (in a route file): `loader: () => preloadNamespaces(['settings'])`
 */
export async function preloadNamespaces(
  namespaces: readonly DeferredNamespace[],
  store: LocaleDictionaryStore = localeDictionaries
): Promise<void> {
  const stored = await store.load(detectLocale());
  const shown = store.shown();
  const targets = shown && shown.messages !== stored.messages ? [shown, stored] : [stored];
  await Promise.all(targets.map((dictionary) => store.loadNamespaces(dictionary, namespaces)));
}
