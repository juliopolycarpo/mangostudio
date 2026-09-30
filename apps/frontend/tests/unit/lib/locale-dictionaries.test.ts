/**
 * The locale dictionary store: English comes from the entry chunk, every other
 * locale from its own chunk, loaded once and falling back to English on failure.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { en, type Locale, ptBR } from '@mangostudio/shared/i18n';
import {
  createLocaleDictionaryStore,
  detectLocale,
  LOCALE_STORAGE_KEY,
  localeDictionaries,
  preloadStartupLocale,
} from '../../../src/lib/locale-dictionaries';
import { createFakeDictionaryLoader } from '../../support/mocks/fake-locale-dictionaries';

const eager = { locale: 'en' as const, messages: en };

function storeWithFakePtLoader() {
  const ptLoader = createFakeDictionaryLoader();
  const failures: Array<{ locale: Locale; error: unknown }> = [];
  const store = createLocaleDictionaryStore({
    eager,
    loaders: { 'pt-BR': ptLoader.load },
    onLoadError: (locale, error) => failures.push({ locale, error }),
  });
  return { store, ptLoader, failures };
}

afterEach(() => {
  localStorage.removeItem(LOCALE_STORAGE_KEY);
});

describe('createLocaleDictionaryStore', () => {
  it('serves the eager locale without loading anything', async () => {
    const { store, ptLoader } = storeWithFakePtLoader();

    expect(store.resolved('en')).toBe(eager);
    expect(await store.load('en')).toBe(eager);
    expect(ptLoader.calls, `expected pt-BR loads: 0 | received: ${ptLoader.calls}`).toBe(0);
  });

  it('loads a lazy locale once, however many callers ask while it is in flight', async () => {
    const { store, ptLoader } = storeWithFakePtLoader();

    const first = store.load('pt-BR');
    const second = store.load('pt-BR');
    expect(
      ptLoader.calls,
      `expected pt-BR loads while in flight: 1 | received: ${ptLoader.calls}`
    ).toBe(1);
    expect(store.resolved('pt-BR')).toBeNull();
    ptLoader.resolveNext(ptBR);

    expect(await first).toEqual({ locale: 'pt-BR', messages: ptBR });
    expect(await second).toEqual({ locale: 'pt-BR', messages: ptBR });
    expect(await store.load('pt-BR')).toEqual({ locale: 'pt-BR', messages: ptBR });
    expect(store.resolved('pt-BR')).toEqual({ locale: 'pt-BR', messages: ptBR });
    expect(ptLoader.calls, `expected pt-BR loads: 1 | received: ${ptLoader.calls}`).toBe(1);
  });

  it('falls back to the eager dictionary when a load fails, and reports the failure', async () => {
    const { store, ptLoader, failures } = storeWithFakePtLoader();
    const chunkError = new Error('Failed to fetch dynamically imported module');

    const pending = store.load('pt-BR');
    ptLoader.rejectNext(chunkError);

    expect(
      await pending,
      'expected a failed pt-BR load to resolve to the eager en dictionary'
    ).toBe(eager);
    expect(store.resolved('pt-BR')).toBe(eager);
    expect(failures).toEqual([{ locale: 'pt-BR', error: chunkError }]);
  });

  it('tries a failed locale again on the next load', async () => {
    const { store, ptLoader } = storeWithFakePtLoader();

    const failed = store.load('pt-BR');
    ptLoader.rejectNext(new Error('offline'));
    await failed;
    const retried = store.load('pt-BR');
    ptLoader.resolveNext(ptBR);

    expect(await retried).toEqual({ locale: 'pt-BR', messages: ptBR });
    expect(
      ptLoader.calls,
      `expected pt-BR loads after one retry: 2 | received: ${ptLoader.calls}`
    ).toBe(2);
  });

  it('names the locale and the known loaders when a locale has no loader', async () => {
    const failures: Array<{ locale: Locale; error: unknown }> = [];
    const store = createLocaleDictionaryStore({
      eager: { locale: 'pt-BR', messages: ptBR },
      loaders: {},
      onLoadError: (locale, error) => failures.push({ locale, error }),
    });

    expect((await store.load('en')).locale).toBe('pt-BR');
    expect(String(failures[0]?.error)).toContain(
      'No dictionary loader for locale "en"; expected one of: '
    );
  });
});

describe('localeDictionaries', () => {
  it('loads the Portuguese dictionary from its own module', async () => {
    const resolved = await localeDictionaries.load('pt-BR');

    expect(resolved.locale).toBe('pt-BR');
    expect(resolved.messages.auth.loginButton).toBe(ptBR.auth.loginButton);
  });
});

describe('detectLocale', () => {
  it('prefers the stored choice', () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'pt-BR');

    expect(detectLocale()).toBe('pt-BR');
  });

  it('ignores a stored value that is not a locale', () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'fr');

    expect(detectLocale()).toBe(navigator.language.startsWith('pt') ? 'pt-BR' : 'en');
  });
});

describe('preloadStartupLocale', () => {
  it('starts loading the stored locale before anything renders', () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'pt-BR');
    const { store, ptLoader } = storeWithFakePtLoader();

    void preloadStartupLocale(store);

    expect(
      ptLoader.calls,
      `expected pt-BR loads started by the preload: 1 | received: ${ptLoader.calls}`
    ).toBe(1);
  });
});
