/**
 * I18nProvider over a lazily loaded dictionary: the startup locale renders in
 * either language, a runtime switch keeps the current text until the next
 * dictionary arrives, and a failed load renders English.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { en, ptBR } from '@mangostudio/shared/i18n';
import { act, render, screen } from '@testing-library/react';
import { I18nProvider, useI18n } from '../../../src/hooks/use-i18n';
import {
  createLocaleDictionaryStore,
  LOCALE_STORAGE_KEY,
  type LocaleDictionaryStore,
  preloadStartupLocale,
} from '../../../src/lib/locale-dictionaries';
import { createFakeDictionaryLoader } from '../../support/mocks/fake-locale-dictionaries';

function Probe() {
  const { t, locale, setLocale } = useI18n();
  return (
    <div>
      <p data-testid="probe-text">{t.auth.loginButton}</p>
      <p data-testid="probe-locale">{locale}</p>
      <button type="button" onClick={() => setLocale('pt-BR')}>
        to-pt
      </button>
      <button type="button" onClick={() => setLocale('en')}>
        to-en
      </button>
    </div>
  );
}

function storeWithFakePtLoader() {
  const ptLoader = createFakeDictionaryLoader();
  const store = createLocaleDictionaryStore({
    eager: { locale: 'en', messages: en },
    loaders: { 'pt-BR': ptLoader.load },
    onLoadError: () => undefined,
  });
  return { store, ptLoader };
}

function renderProbe(store: LocaleDictionaryStore) {
  return render(
    <I18nProvider dictionaries={store}>
      <Probe />
    </I18nProvider>
  );
}

function shown(): { text: string | null; locale: string | null } {
  return {
    text: screen.queryByTestId('probe-text')?.textContent ?? null,
    locale: screen.queryByTestId('probe-locale')?.textContent ?? null,
  };
}

/** Lets a settled dictionary promise reach React state. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  localStorage.removeItem(LOCALE_STORAGE_KEY);
});

describe('I18nProvider', () => {
  it('renders English at startup from the eager dictionary, with no load', () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
    const { store, ptLoader } = storeWithFakePtLoader();

    renderProbe(store);

    expect(shown()).toEqual({ text: en.auth.loginButton, locale: 'en' });
    expect(ptLoader.calls, `expected pt-BR loads: 0 | received: ${ptLoader.calls}`).toBe(0);
  });

  it('renders Portuguese at startup once its dictionary arrives, never English first', async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'pt-BR');
    const { store, ptLoader } = storeWithFakePtLoader();

    renderProbe(store);
    expect(
      shown().text,
      `expected no text before the pt-BR dictionary arrives | received: ${shown().text}`
    ).toBeNull();
    expect(screen.getByTestId('startup-spinner')).toBeInTheDocument();

    ptLoader.resolveNext(ptBR);
    await settle();

    expect(shown()).toEqual({ text: ptBR.auth.loginButton, locale: 'pt-BR' });
  });

  it('renders Portuguese on the first render when the preload already finished', async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'pt-BR');
    const { store, ptLoader } = storeWithFakePtLoader();
    const preload = preloadStartupLocale(store);
    ptLoader.resolveNext(ptBR);
    await preload;

    renderProbe(store);

    expect(shown()).toEqual({ text: ptBR.auth.loginButton, locale: 'pt-BR' });
    expect(
      ptLoader.calls,
      `expected pt-BR loads, preload included: 1 | received: ${ptLoader.calls}`
    ).toBe(1);
  });

  it('reuses the preload that is still in flight instead of starting a second load', async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'pt-BR');
    const { store, ptLoader } = storeWithFakePtLoader();
    void preloadStartupLocale(store);

    renderProbe(store);
    await settle();
    expect(
      ptLoader.calls,
      `expected pt-BR loads, preload included: 1 | received: ${ptLoader.calls}`
    ).toBe(1);
    ptLoader.resolveNext(ptBR);
    await settle();

    expect(shown().text).toBe(ptBR.auth.loginButton);
  });

  it('renders English when the startup dictionary fails to load, and keeps the stored choice', async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'pt-BR');
    const { store, ptLoader } = storeWithFakePtLoader();

    renderProbe(store);
    ptLoader.rejectNext(new Error('Failed to fetch dynamically imported module'));
    await settle();

    expect(shown(), 'expected a failed pt-BR load to render the eager en dictionary').toEqual({
      text: en.auth.loginButton,
      locale: 'en',
    });
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('pt-BR');
  });

  it('switches at runtime, keeping the current text until the next dictionary arrives', async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
    const { store, ptLoader } = storeWithFakePtLoader();
    renderProbe(store);

    act(() => screen.getByRole('button', { name: 'to-pt' }).click());
    expect(shown(), 'expected English to stay on screen while the pt-BR dictionary loads').toEqual({
      text: en.auth.loginButton,
      locale: 'en',
    });
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('pt-BR');

    ptLoader.resolveNext(ptBR);
    await settle();
    expect(shown()).toEqual({ text: ptBR.auth.loginButton, locale: 'pt-BR' });

    act(() => screen.getByRole('button', { name: 'to-en' }).click());
    await settle();
    expect(shown()).toEqual({ text: en.auth.loginButton, locale: 'en' });
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en');
  });

  it('applies only the latest switch when an earlier one resolves after it', async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
    const { store, ptLoader } = storeWithFakePtLoader();
    renderProbe(store);

    act(() => screen.getByRole('button', { name: 'to-pt' }).click());
    act(() => screen.getByRole('button', { name: 'to-en' }).click());
    await settle();
    ptLoader.resolveNext(ptBR);
    await settle();

    expect(shown(), 'expected the later switch to en to win over the slower pt-BR load').toEqual({
      text: en.auth.loginButton,
      locale: 'en',
    });
  });

  it('stays in English when a runtime switch fails to load', async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
    const { store, ptLoader } = storeWithFakePtLoader();
    renderProbe(store);

    act(() => screen.getByRole('button', { name: 'to-pt' }).click());
    ptLoader.rejectNext(new Error('offline'));
    await settle();

    expect(shown()).toEqual({ text: en.auth.loginButton, locale: 'en' });
  });
});
