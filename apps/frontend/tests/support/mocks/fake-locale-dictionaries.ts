/**
 * Test doubles for the locale dictionary loading in `src/lib/locale-dictionaries`.
 *
 * - `inMemoryLocaleDictionaries` is what the render harness hands to every
 *   `I18nProvider`: both dictionaries already in memory, so a test that stores
 *   `pt-BR` and renders can assert synchronously, as it could when both
 *   dictionaries were bundled eagerly.
 * - `createFakeDictionaryLoader` stands in for one chunk's dynamic `import()`:
 *   each call is pending until the test settles it, like a network fetch.
 */

import { en, type Locale, type Messages, ptBR } from '@mangostudio/shared/i18n';
import type {
  LocaleDictionaryStore,
  ResolvedDictionary,
} from '../../../src/lib/locale-dictionaries';

const dictionaries: Record<Locale, Messages> = { en, 'pt-BR': ptBR };

function resolvedInMemory(locale: Locale): ResolvedDictionary {
  return { locale, messages: dictionaries[locale] };
}

/** A store whose every dictionary is already loaded. */
export const inMemoryLocaleDictionaries: LocaleDictionaryStore = {
  load: (locale) => Promise.resolve(resolvedInMemory(locale)),
  resolved: resolvedInMemory,
};

interface PendingLoad {
  resolve: (messages: Messages) => void;
  reject: (error: unknown) => void;
}

/** One chunk's loader, settled by the test; `calls` counts the requests made. */
export interface FakeDictionaryLoader {
  load: () => Promise<Messages>;
  readonly calls: number;
  /** Settles the oldest pending request with `messages`. */
  resolveNext: (messages: Messages) => void;
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
export function createFakeDictionaryLoader(): FakeDictionaryLoader {
  const pending: PendingLoad[] = [];
  let calls = 0;

  function next(): PendingLoad {
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
      return new Promise<Messages>((resolve, reject) => {
        pending.push({ resolve, reject });
      });
    },
    get calls() {
      return calls;
    },
    resolveNext: (messages) => next().resolve(messages),
    rejectNext: (error) => next().reject(error),
  };
}
