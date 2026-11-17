/**
 * `useI18n('settings')` over the deferred English namespaces: a named namespace
 * renders in both locales, a screen that can render before its chunk arrives
 * shows its own Suspense fallback (never missing text), a locale switch keeps
 * the current text until the new locale's namespace is in, and a namespace
 * that is not named is a compile error.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { en, ptBR } from '@mangostudio/shared/i18n';
import { act, render, screen } from '@testing-library/react';
import { Component, type ReactNode, Suspense, useState } from 'react';

import { I18nProvider, useI18n } from '../../../src/hooks/use-i18n';
import {
  createLocaleDictionaryStore,
  LOCALE_STORAGE_KEY,
  type LocaleDictionaryStore,
  preloadNamespaces,
} from '../../../src/lib/locale-dictionaries';
import {
  createFakeDictionaryLoader,
  createFakeNamespaceLoaders,
  englishWithoutDeferredNamespaces,
} from '../../support/mocks/fake-locale-dictionaries';

function SettingsProbe() {
  const { t, locale, setLocale } = useI18n('settings');
  return (
    <div>
      <p data-testid="settings-text">{t.settings.tabs.general}</p>
      <p data-testid="settings-locale">{locale}</p>
      <p data-testid="core-text">{t.auth.loginButton}</p>
      <button type="button" onClick={() => setLocale('pt-BR')}>
        to-pt
      </button>
      <button type="button" onClick={() => setLocale('en')}>
        to-en
      </button>
    </div>
  );
}

/** What a screen shows while its namespace is in flight: the fallback is a stated choice. */
function SettingsFallback() {
  return <p data-testid="settings-fallback">loading settings</p>;
}

function ReadsDeferredWithoutNamingIt() {
  const { t } = useI18n();
  // @ts-expect-error `settings` is deferred: `useI18n().t` has no such key, `useI18n('settings')` does.
  return <p>{t.settings.tabs.general}</p>;
}

class ErrorCatcher extends Component<{ children: ReactNode }, { message: string | null }> {
  override state = { message: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : String(error) };
  }
  override render() {
    return this.state.message === null ? (
      this.props.children
    ) : (
      <p data-testid="caught-error">{this.state.message}</p>
    );
  }
}

function storeWithFakeChunks() {
  const namespaceChunks = createFakeNamespaceLoaders();
  const ptLoader = createFakeDictionaryLoader();
  const store = createLocaleDictionaryStore({
    eager: { locale: 'en', messages: englishWithoutDeferredNamespaces },
    eagerNamespaces: namespaceChunks.eagerNamespaces,
    loaders: { 'pt-BR': ptLoader.load },
    onLoadError: () => undefined,
  });
  return { store, namespaceChunks, ptLoader };
}

async function renderSettingsProbe(store: LocaleDictionaryStore) {
  // Awaited act: the component may suspend on its first render, which React requires be awaited.
  await act(async () => {
    render(
      <I18nProvider dictionaries={store}>
        <ErrorCatcher>
          <Suspense fallback={<SettingsFallback />}>
            <SettingsProbe />
          </Suspense>
        </ErrorCatcher>
      </I18nProvider>
    );
    // Yield once so the act scope is async, which lets a suspended first render settle inside it.
    await Promise.resolve();
  });
}

/** The eager English dictionary the store was built with. */
function eagerEnglish(store: LocaleDictionaryStore) {
  const dictionary = store.resolved('en');
  if (!dictionary) throw new Error('expected the eager English dictionary | received: none');
  return dictionary;
}

function shown() {
  return {
    text: screen.queryByTestId('settings-text')?.textContent ?? null,
    locale: screen.queryByTestId('settings-locale')?.textContent ?? null,
    fallback: screen.queryByTestId('settings-fallback') !== null,
  };
}

/** Lets a settled chunk promise reach React state. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  document.documentElement.lang = 'en';
});

afterEach(() => {
  localStorage.removeItem(LOCALE_STORAGE_KEY);
  document.documentElement.lang = 'en';
});

describe('useI18n with a deferred namespace', () => {
  it('renders the namespace on the first commit when its route loaded it, in English', async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
    const { store, namespaceChunks } = storeWithFakeChunks();
    const preloading = store.loadNamespaces(eagerEnglish(store), ['settings']);
    namespaceChunks.settings.resolveNext({ settings: en.settings });
    await preloading;

    await renderSettingsProbe(store);

    expect(shown()).toEqual({ text: en.settings.tabs.general, locale: 'en', fallback: false });
    expect(screen.getByTestId('core-text')).toHaveTextContent(en.auth.loginButton);
  });

  it('renders the namespace in Portuguese from the one Portuguese dictionary, with no extra request', async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'pt-BR');
    const { store, namespaceChunks, ptLoader } = storeWithFakeChunks();

    await renderSettingsProbe(store);
    ptLoader.resolveNext(ptBR);
    await settle();

    expect(shown()).toEqual({
      text: ptBR.settings.tabs.general,
      locale: 'pt-BR',
      fallback: false,
    });
    expect(
      namespaceChunks.settings.calls,
      `expected settings chunk requests for pt-BR: 0 | received: ${namespaceChunks.settings.calls}`
    ).toBe(0);
  });

  it('shows the screen own fallback, never missing text, while the chunk is in flight', async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
    const { store, namespaceChunks } = storeWithFakeChunks();

    await renderSettingsProbe(store);
    expect(shown(), 'expected the Suspense fallback while the settings chunk loads').toEqual({
      text: null,
      locale: null,
      fallback: true,
    });

    namespaceChunks.settings.resolveNext({ settings: en.settings });
    await settle();

    expect(shown()).toEqual({ text: en.settings.tabs.general, locale: 'en', fallback: false });
    expect(namespaceChunks.settings.calls).toBe(1);
  });

  it('throws a chunk that cannot be fetched to the nearest error boundary', async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
    const { store, namespaceChunks } = storeWithFakeChunks();

    // React logs a caught render error; the test asserts the boundary instead.
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      await renderSettingsProbe(store);
      namespaceChunks.settings.rejectNext(new Error('settings chunk 404'));
      await settle();
    } finally {
      console.error = originalConsoleError;
    }

    expect(screen.getByTestId('caught-error')).toHaveTextContent('settings chunk 404');
    expect(shown().text).toBeNull();
    expect(
      namespaceChunks.settings.calls,
      `expected settings chunk requests across the failed render passes: 1 | received: ${namespaceChunks.settings.calls}`
    ).toBe(1);
  });
});

describe('switching locale on a screen that reads a deferred namespace', () => {
  it('goes from English to Portuguese, keeping English until the dictionary arrives', async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
    const { store, namespaceChunks, ptLoader } = storeWithFakeChunks();
    const preloading = store.loadNamespaces(eagerEnglish(store), ['settings']);
    namespaceChunks.settings.resolveNext({ settings: en.settings });
    await preloading;
    await renderSettingsProbe(store);

    act(() => screen.getByRole('button', { name: 'to-pt' }).click());
    expect(shown(), 'expected English settings text while the pt-BR dictionary loads').toEqual({
      text: en.settings.tabs.general,
      locale: 'en',
      fallback: false,
    });
    ptLoader.resolveNext(ptBR);
    await settle();

    expect(shown()).toEqual({
      text: ptBR.settings.tabs.general,
      locale: 'pt-BR',
      fallback: false,
    });
  });

  it('goes from Portuguese to English that was never loaded, without flashing the fallback', async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'pt-BR');
    const { store, namespaceChunks, ptLoader } = storeWithFakeChunks();
    await renderSettingsProbe(store);
    ptLoader.resolveNext(ptBR);
    await settle();
    expect(shown().text).toBe(ptBR.settings.tabs.general);

    act(() => screen.getByRole('button', { name: 'to-en' }).click());
    await settle();
    expect(
      shown(),
      'expected Portuguese to stay on screen, with no fallback, while the English settings chunk loads'
    ).toEqual({ text: ptBR.settings.tabs.general, locale: 'pt-BR', fallback: false });
    expect(namespaceChunks.settings.calls).toBe(1);

    namespaceChunks.settings.resolveNext({ settings: en.settings });
    await settle();

    expect(shown()).toEqual({ text: en.settings.tabs.general, locale: 'en', fallback: false });
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en');
  });
});

describe('a saved locale whose chunk failed at startup', () => {
  /** A shell that mounts the settings screen on demand, like navigating to /settings. */
  function ShellWithSettingsRoute() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          open-settings
        </button>
        {open ? (
          <Suspense fallback={<SettingsFallback />}>
            <SettingsProbe />
          </Suspense>
        ) : null}
      </>
    );
  }

  it('preloads the English namespace the provider shows, so opening /settings does not suspend', async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'pt-BR');
    const { store, namespaceChunks, ptLoader } = storeWithFakeChunks();
    await act(async () => {
      render(
        <I18nProvider dictionaries={store}>
          <ShellWithSettingsRoute />
        </I18nProvider>
      );
      await Promise.resolve();
    });
    // The Portuguese chunk fails: English renders while `pt-BR` stays saved.
    ptLoader.rejectNext(new Error('pt-BR chunk 404'));
    await settle();
    expect(document.documentElement.lang).toBe('en');
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('pt-BR');

    // Opening /settings later: the route's loader runs, and now the Portuguese chunk loads.
    const preloading = preloadNamespaces(['settings'], store);
    ptLoader.resolveNext(ptBR);
    await settle();
    namespaceChunks.settings.resolveNext({ settings: en.settings });
    await preloading;
    await act(async () => {
      screen.getByRole('button', { name: 'open-settings' }).click();
      await Promise.resolve();
    });

    expect(
      shown(),
      'expected the English settings text on the first commit after the loader, with no Suspense fallback'
    ).toEqual({ text: en.settings.tabs.general, locale: 'en', fallback: false });
  });

  it('loads one dictionary, not two, when the screen and the saved locale agree', async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'pt-BR');
    const { store, namespaceChunks, ptLoader } = storeWithFakeChunks();
    await act(async () => {
      render(
        <I18nProvider dictionaries={store}>
          <ShellWithSettingsRoute />
        </I18nProvider>
      );
      await Promise.resolve();
    });
    ptLoader.resolveNext(ptBR);
    await settle();

    await preloadNamespaces(['settings'], store);

    expect(
      namespaceChunks.settings.calls,
      `expected English settings chunk requests while pt-BR is shown and saved: 0 | received: ${namespaceChunks.settings.calls}`
    ).toBe(0);
  });
});

describe('reading a deferred namespace that was not named', () => {
  it('does not compile: `useI18n().t.settings` carries a ts-expect-error above', () => {
    // The assertion is the `@ts-expect-error` in `ReadsDeferredWithoutNamingIt`: it fails
    // the type check the moment `useI18n()` exposes a deferred namespace again.
    const componentsThatMustNotCompile = [ReadsDeferredWithoutNamingIt];

    expect(componentsThatMustNotCompile).toHaveLength(1);
  });
});
