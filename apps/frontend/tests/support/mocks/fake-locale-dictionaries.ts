/**
 * Test doubles for the locale dictionary loading in `src/lib/locale-dictionaries`.
 *
 * - `inMemoryLocaleDictionaries` is what the render harness hands to every
 *   `I18nProvider`: both dictionaries already in memory, deferred namespaces
 *   included, so a test that stores `pt-BR` and renders can assert
 *   synchronously, as it could when both dictionaries were bundled eagerly.
 * - `createFakeDictionaryLoader` stands in for one chunk's dynamic `import()`:
 *   each call is pending until the test settles it, like a network fetch.
 * - `englishWithoutDeferredNamespaces` is the eager English dictionary as the
 *   entry chunk ships it, and `createFakeNamespaceLoaders` the pending chunks
 *   of the namespaces it leaves out.
 */

import {
  type CoreMessages,
  type DeferredNamespace,
  en,
  type Locale,
  type Messages,
  ptBR,
} from '@mangostudio/shared/i18n';

import {
  carriesNamespaces,
  type LocaleDictionaryStore,
  type ResolvedDictionary,
} from '../../../src/lib/locale-dictionaries';

const dictionaries: Record<Locale, Messages> = { en, 'pt-BR': ptBR };

function resolvedInMemory(locale: Locale): ResolvedDictionary {
  return { locale, messages: dictionaries[locale] };
}

/** A store whose every dictionary is already loaded, deferred namespaces included. */
export const inMemoryLocaleDictionaries: LocaleDictionaryStore = {
  load: (locale) => Promise.resolve(resolvedInMemory(locale)),
  resolved: resolvedInMemory,
  namespaces: (dictionary, namespaces) =>
    carriesNamespaces(dictionary.messages, namespaces) ? dictionary.messages : null,
  loadNamespaces: (dictionary, namespaces) =>
    carriesNamespaces(dictionary.messages, namespaces)
      ? Promise.resolve(dictionary.messages)
      : Promise.reject(
          new Error(
            `expected the in-memory "${dictionary.locale}" dictionary to carry ${namespaces.join(', ')} | received a dictionary without it`
          )
        ),
};

/** The English dictionary the entry chunk ships: every namespace but the deferred ones. */
export const englishWithoutDeferredNamespaces: CoreMessages = (() => {
  const { settings: _settings, onboarding: _onboarding, ...core } = en;
  return core;
})();

interface PendingLoad<Value> {
  resolve: (value: Value) => void;
  reject: (error: unknown) => void;
}

/** One chunk's loader, settled by the test; `calls` counts the requests made. */
export interface FakeDictionaryLoader<Value = Messages> {
  load: () => Promise<Value>;
  readonly calls: number;
  /** Settles the oldest pending request with `value`. */
  resolveNext: (value: Value) => void;
  /** Fails the oldest pending request with `error`. */
  rejectNext: (error: unknown) => void;
}

/**
 * Creates a loader whose requests stay pending until `resolveNext` or
 * `rejectNext` settles them, in order.
 *
 * Usage:
 * ```ts
 * const ptLoader = createFakeDictionaryLoader();
 * const store = createLocaleDictionaryStore({ eager, loaders: { 'pt-BR': ptLoader.load }, onLoadError });
 * ptLoader.resolveNext(ptBR);
 * ```
 */
export function createFakeDictionaryLoader<Value = Messages>(): FakeDictionaryLoader<Value> {
  const pending: PendingLoad<Value>[] = [];
  let calls = 0;

  function next(): PendingLoad<Value> {
    const request = pending.shift();
    if (!request) {
      throw new Error(
        `expected a pending dictionary request | received none after ${calls} call(s)`
      );
    }
    return request;
  }

  return {
    load: () => {
      calls += 1;
      return new Promise<Value>((resolve, reject) => {
        pending.push({ resolve, reject });
      });
    },
    get calls() {
      return calls;
    },
    resolveNext: (value) => next().resolve(value),
    rejectNext: (error) => next().reject(error),
  };
}

/** The chunk loaders of every deferred namespace of the eager locale, settled by the test. */
export type FakeNamespaceLoaders = {
  [Namespace in DeferredNamespace]: FakeDictionaryLoader<Pick<Messages, Namespace>>;
};

/**
 * One pending loader per deferred namespace; hand `eagerNamespaces` to
 * `createLocaleDictionaryStore`, and settle a chunk with `settings.resolveNext({ settings: en.settings })`.
 */
export function createFakeNamespaceLoaders(): FakeNamespaceLoaders & {
  readonly eagerNamespaces: {
    [Namespace in DeferredNamespace]: () => Promise<Pick<Messages, Namespace>>;
  };
} {
  const settings = createFakeDictionaryLoader<Pick<Messages, 'settings'>>();
  const onboarding = createFakeDictionaryLoader<Pick<Messages, 'onboarding'>>();
  return {
    settings,
    onboarding,
    eagerNamespaces: { settings: settings.load, onboarding: onboarding.load },
  };
}
