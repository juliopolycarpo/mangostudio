/**
 * The routes that read a deferred i18n namespace load it in their `loader`, which
 * TanStack runs alongside the route's lazy component, so the namespace has
 * arrived by the time the component commits and its text never renders missing.
 *
 * Driven by calling each route's own `loader`, as the first-run gate's test
 * drives `beforeLoad`, against the app's real dictionary store.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import type { QueryClient } from '@tanstack/react-query';

import {
  detectLocale,
  LOCALE_STORAGE_KEY,
  localeDictionaries,
} from '../../../src/lib/locale-dictionaries';
import { Route as SettingsRoute } from '../../../src/routes/_authenticated/settings';
import { Route as GeneralSettingsRoute } from '../../../src/routes/_authenticated/settings/general';
import { Route as WelcomeRoute } from '../../../src/routes/welcome';

type Loader = (ctx: { context: { queryClient: QueryClient } }) => Promise<unknown>;

function loaderOf(route: unknown): Loader {
  return (route as { options: { loader: Loader } }).options.loader;
}

/** A query client that answers `ensureQueryData` with a marker instead of calling the hub. */
function queryClientAnswering(record: unknown): QueryClient {
  return { ensureQueryData: () => Promise.resolve(record) } as unknown as QueryClient;
}

/** Whether `namespace` is readable right now for the locale on screen, with nothing left to fetch. */
async function isLoaded(namespace: 'settings' | 'onboarding'): Promise<boolean> {
  const dictionary = await localeDictionaries.load(detectLocale());
  return localeDictionaries.namespaces(dictionary, [namespace]) !== null;
}

afterEach(() => {
  localStorage.removeItem(LOCALE_STORAGE_KEY);
});

describe.each(['en', 'pt-BR'] as const)('route loaders in %s', (locale) => {
  it('loads the settings namespace for every page under /settings', async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);

    await loaderOf(SettingsRoute)({ context: { queryClient: queryClientAnswering(null) } });

    expect(
      await isLoaded('settings'),
      `expected the settings namespace loaded after the /settings loader (${locale}) | received: not loaded`
    ).toBe(true);
  });

  it('loads the onboarding namespace for the card on the general settings page', async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);

    await loaderOf(GeneralSettingsRoute)({ context: { queryClient: queryClientAnswering(null) } });

    expect(await isLoaded('onboarding')).toBe(true);
  });

  it('loads the onboarding namespace next to the settings record on /welcome, keeping its data', async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    const record = { marker: 'app settings record' };

    const data = await loaderOf(WelcomeRoute)({
      context: { queryClient: queryClientAnswering(record) },
    });

    expect(data, 'expected the loader to keep returning the settings record').toBe(record);
    expect(await isLoaded('onboarding')).toBe(true);
  });
});
