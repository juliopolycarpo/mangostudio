/**
 * `useI18n(libraryMessages)` over a feature namespace: the English keys the
 * feature's chunk imported render at once, with no Suspense and no request, in
 * both locales, and a feature namespace that is not passed is a compile error.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { en, ptBR } from '@mangostudio/shared/i18n';
import { messages as githubMessages } from '@mangostudio/shared/i18n/en-github';
import { messages as libraryMessages } from '@mangostudio/shared/i18n/en-library';
import { act, render, screen } from '@testing-library/react';
import { Suspense } from 'react';

import { I18nProvider, useI18n } from '../../../src/hooks/use-i18n';
import {
  createLocaleDictionaryStore,
  LOCALE_STORAGE_KEY,
} from '../../../src/lib/locale-dictionaries';
import {
  createFakeNamespaceLoaders,
  englishWithoutDeferredNamespaces,
} from '../../support/mocks/fake-locale-dictionaries';

function LibraryProbe() {
  const { t } = useI18n(libraryMessages);
  return (
    <div>
      <p data-testid="feature-text">{t.library.removal.confirmDescription}</p>
      <p data-testid="eager-key-text">{t.library.targets.claude}</p>
    </div>
  );
}

function TwoNamespacesProbe() {
  const { t } = useI18n('settings', libraryMessages, githubMessages);
  return (
    <p data-testid="mixed-text">
      {[
        t.settings.tabs.general,
        t.library.removal.confirmDescription,
        t.github.createPr.pushError,
      ].join(' | ')}
    </p>
  );
}

function ReadsFeatureKeyWithoutPassingIt() {
  const { t } = useI18n();
  // @ts-expect-error `library.removal` is a Library-chunk key: `useI18n().t.library` has only the eager keys.
  return <p>{t.library.removal.confirmDescription}</p>;
}

function storeWithFakeChunks() {
  const namespaceChunks = createFakeNamespaceLoaders();
  const store = createLocaleDictionaryStore({
    eager: { locale: 'en', messages: englishWithoutDeferredNamespaces },
    eagerNamespaces: namespaceChunks.eagerNamespaces,
    loaders: { 'pt-BR': () => Promise.resolve(ptBR) },
    onLoadError: () => undefined,
  });
  return { store, namespaceChunks };
}

async function renderWithin(
  store: ReturnType<typeof storeWithFakeChunks>['store'],
  child: React.ReactNode
) {
  await act(async () => {
    render(
      <I18nProvider dictionaries={store}>
        <Suspense fallback={<p data-testid="fallback">loading</p>}>{child}</Suspense>
      </I18nProvider>
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  localStorage.removeItem(LOCALE_STORAGE_KEY);
});

describe('useI18n with a feature namespace', () => {
  it('renders the feature English keys on the first commit, with no fallback and no request', async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
    const { store, namespaceChunks } = storeWithFakeChunks();

    await renderWithin(store, <LibraryProbe />);

    expect(screen.queryByTestId('fallback')).toBeNull();
    expect(screen.getByTestId('feature-text')).toHaveTextContent(
      en.library.removal.confirmDescription
    );
    expect(screen.getByTestId('eager-key-text')).toHaveTextContent(en.library.targets.claude);
    expect(
      namespaceChunks.settings.calls + namespaceChunks.onboarding.calls,
      'expected no namespace chunk request for a feature namespace'
    ).toBe(0);
  });

  it('renders Portuguese from the one Portuguese dictionary, not the English keys', async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'pt-BR');
    const { store } = storeWithFakeChunks();

    await renderWithin(store, <LibraryProbe />);

    expect(screen.getByTestId('feature-text')).toHaveTextContent(
      ptBR.library.removal.confirmDescription
    );
  });

  it('combines a deferred namespace with several feature namespaces', async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
    const { store, namespaceChunks } = storeWithFakeChunks();
    const preloading = store.loadNamespaces(
      store.resolved('en') ?? { locale: 'en', messages: englishWithoutDeferredNamespaces },
      ['settings']
    );
    namespaceChunks.settings.resolveNext({ settings: en.settings });
    await preloading;

    await renderWithin(store, <TwoNamespacesProbe />);

    expect(screen.getByTestId('mixed-text')).toHaveTextContent(
      [
        en.settings.tabs.general,
        en.library.removal.confirmDescription,
        en.github.createPr.pushError,
      ].join(' | ')
    );
  });

  it('keeps the component readable only through the namespace it was given', () => {
    // The `@ts-expect-error` above is the assertion; referencing the probe keeps it from being dead code.
    expect(ReadsFeatureKeyWithoutPassingIt).toBeFunction();
  });
});
