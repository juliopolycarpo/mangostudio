/**
 * Deferred namespaces in the locale dictionary store: the eager English
 * dictionary leaves `settings` and `onboarding` out, each loads as its own
 * chunk at most once at a time, a lazy locale already carries them, and a chunk
 * that cannot be fetched rejects instead of resolving to missing text.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { type DeferredNamespace, en, type Locale, ptBR } from '@mangostudio/shared/i18n';

import {
  carriesNamespaces,
  createLocaleDictionaryStore,
  LOCALE_STORAGE_KEY,
  localeDictionaries,
  preloadNamespaces,
} from '../../../src/lib/locale-dictionaries';
import {
  createFakeDictionaryLoader,
  createFakeNamespaceLoaders,
  englishWithoutDeferredNamespaces,
} from '../../support/mocks/fake-locale-dictionaries';

const eager = { locale: 'en' as const, messages: englishWithoutDeferredNamespaces };

function storeWithFakeChunks(clock: { now?: () => number; retryAfterMs?: number } = {}) {
  const namespaceChunks = createFakeNamespaceLoaders();
  const ptLoader = createFakeDictionaryLoader();
  const failures: Array<{ locale: Locale; error: unknown; namespace?: DeferredNamespace }> = [];
  const store = createLocaleDictionaryStore({
    eager,
    eagerNamespaces: namespaceChunks.eagerNamespaces,
    loaders: { 'pt-BR': ptLoader.load },
    onLoadError: (locale, error, namespace) => failures.push({ locale, error, namespace }),
    ...clock,
  });
  return { store, namespaceChunks, ptLoader, failures };
}

afterEach(() => {
  localStorage.removeItem(LOCALE_STORAGE_KEY);
});

describe('the eager English dictionary', () => {
  it('has no deferred namespace, so reading one is not a runtime fallback', () => {
    expect(carriesNamespaces(eager.messages, ['settings'])).toBe(false);
    expect(carriesNamespaces(eager.messages, ['onboarding'])).toBe(false);
    expect(carriesNamespaces(eager.messages, [])).toBe(true);
  });
});

describe('namespaces', () => {
  it('answers null until the chunk arrives, then the dictionary with the namespace', async () => {
    const { store, namespaceChunks } = storeWithFakeChunks();

    expect(store.namespaces(eager, ['settings'])).toBeNull();
    const loading = store.loadNamespaces(eager, ['settings']);
    expect(store.namespaces(eager, ['settings'])).toBeNull();
    namespaceChunks.settings.resolveNext({ settings: en.settings });
    const loaded = await loading;

    expect(loaded.settings.tabs.general).toBe(en.settings.tabs.general);
    expect(loaded.auth.loginButton).toBe(en.auth.loginButton);
    expect(store.namespaces(eager, ['settings'])).toBe(loaded);
  });

  it('returns the same object for the same request, so it is safe in a dependency list', async () => {
    const { store, namespaceChunks } = storeWithFakeChunks();
    const loading = store.loadNamespaces(eager, ['settings', 'onboarding']);
    namespaceChunks.settings.resolveNext({ settings: en.settings });
    namespaceChunks.onboarding.resolveNext({ onboarding: en.onboarding });
    await loading;

    // Argument order does not matter, and neither does asking again.
    expect(store.namespaces(eager, ['onboarding', 'settings'])).toBe(
      store.namespaces(eager, ['settings', 'onboarding'])
    );
  });

  it('serves a namespace a lazy locale already carries without a request', async () => {
    const { store, namespaceChunks, ptLoader } = storeWithFakeChunks();
    const pending = store.load('pt-BR');
    ptLoader.resolveNext(ptBR);
    const portuguese = await pending;

    const carried = store.namespaces(portuguese, ['settings', 'onboarding']);

    expect(carried?.settings).toBe(ptBR.settings);
    expect(carried?.onboarding).toBe(ptBR.onboarding);
    expect(namespaceChunks.settings.calls).toBe(0);
    expect(namespaceChunks.onboarding.calls).toBe(0);
  });
});

describe('loadNamespaces', () => {
  it('fetches one chunk per namespace however many callers ask while it is in flight', async () => {
    const { store, namespaceChunks } = storeWithFakeChunks();

    const first = store.loadNamespaces(eager, ['settings']);
    const second = store.loadNamespaces(eager, ['settings']);
    expect(second, 'expected the in-flight request to be shared').toBe(first);
    const withOnboarding = store.loadNamespaces(eager, ['settings', 'onboarding']);
    namespaceChunks.settings.resolveNext({ settings: en.settings });
    namespaceChunks.onboarding.resolveNext({ onboarding: en.onboarding });
    await Promise.all([first, withOnboarding]);

    expect(
      namespaceChunks.settings.calls,
      `expected settings chunk requests: 1 | received: ${namespaceChunks.settings.calls}`
    ).toBe(1);
    expect(
      namespaceChunks.onboarding.calls,
      `expected onboarding chunk requests: 1 | received: ${namespaceChunks.onboarding.calls}`
    ).toBe(1);
  });

  it('rejects when a chunk cannot be fetched and reports which namespace', async () => {
    const { store, namespaceChunks, failures } = storeWithFakeChunks();
    const chunkError = new TypeError('Failed to fetch dynamically imported module: /settings.js');

    const loading = store.loadNamespaces(eager, ['settings']);
    namespaceChunks.settings.rejectNext(chunkError);

    await expect(loading).rejects.toBe(chunkError);
    expect(failures).toEqual([{ locale: 'en', error: chunkError, namespace: 'settings' }]);
    expect(store.namespaces(eager, ['settings'])).toBeNull();
  });

  it('replays a failure for the retry window, then asks the network again', async () => {
    let clock = 0;
    const { store, namespaceChunks } = storeWithFakeChunks({
      now: () => clock,
      retryAfterMs: 1_000,
    });
    const failed = store.loadNamespaces(eager, ['settings']);
    namespaceChunks.settings.rejectNext(new Error('offline'));
    await failed.catch(() => undefined);

    // React re-renders a suspended component by calling again: that must meet the same
    // rejection, or every pass would start another fetch.
    clock = 999;
    expect(store.loadNamespaces(eager, ['settings'])).toBe(failed);
    expect(namespaceChunks.settings.calls).toBe(1);

    clock = 1_000;
    const retried = store.loadNamespaces(eager, ['settings']);
    namespaceChunks.settings.resolveNext({ settings: en.settings });

    expect((await retried).settings.tabs.general).toBe(en.settings.tabs.general);
    expect(namespaceChunks.settings.calls).toBe(2);
  });

  it('names the namespace and the locale when nothing can supply it', async () => {
    const store = createLocaleDictionaryStore({
      eager,
      loaders: {},
      onLoadError: () => undefined,
    });

    await expect(store.loadNamespaces(eager, ['settings'])).rejects.toThrow(
      'No loader for the "settings" namespace of locale "en" | expected: a dictionary that carries it, or an eagerNamespaces loader for "en"'
    );
  });
});

describe('preloadNamespaces', () => {
  it('loads the namespace for the locale the provider renders (the stored choice)', async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
    const { store, namespaceChunks } = storeWithFakeChunks();

    const preloading = preloadNamespaces(['settings'], store);
    await new Promise((resolve) => setTimeout(resolve, 0));
    namespaceChunks.settings.resolveNext({ settings: en.settings });
    await preloading;

    expect(store.namespaces(eager, ['settings'])?.settings.tabs.general).toBe(
      en.settings.tabs.general
    );
  });

  it('needs no namespace request for Portuguese, which carries them', async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'pt-BR');
    const { store, namespaceChunks, ptLoader } = storeWithFakeChunks();

    const preloading = preloadNamespaces(['settings', 'onboarding'], store);
    await new Promise((resolve) => setTimeout(resolve, 0));
    ptLoader.resolveNext(ptBR);
    await preloading;

    expect(namespaceChunks.settings.calls + namespaceChunks.onboarding.calls).toBe(0);
  });
});

describe('localeDictionaries', () => {
  it('loads each English namespace from its own module', async () => {
    const english = await localeDictionaries.load('en');

    const loaded = await localeDictionaries.loadNamespaces(english, ['settings', 'onboarding']);

    expect(loaded.settings.tabs.general).toBe(en.settings.tabs.general);
    expect(loaded.onboarding.progress).toBe(en.onboarding.progress);
  });

  it('serves the Portuguese namespaces from the one Portuguese dictionary', async () => {
    const portuguese = await localeDictionaries.load('pt-BR');

    const loaded = await localeDictionaries.loadNamespaces(portuguese, ['settings']);

    expect(loaded.settings.tabs.general).toBe(ptBR.settings.tabs.general);
  });
});
