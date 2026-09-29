/**
 * A library-location write sends the whole location map as explicit values,
 * so building it on the "defaults pending" placeholder would store that
 * placeholder for good. These pin the guard both location writers share.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  type AppSettingsResponse,
  DEFAULT_APP_SETTINGS,
  DEFAULT_LIBRARY_LOCATION_SETTINGS,
  libraryLocationsFor,
  withLibraryLocations,
} from '@mangostudio/shared/app-settings';
import { DEFAULT_PROFILE_ID } from '@mangostudio/shared/profiles';
import { QueryClient } from '@tanstack/react-query';
import {
  appSettingsForLocationWrite,
  appSettingsKeys,
  keepLibraryDefaultsPending,
  libraryLocationDefaultsPending,
} from '../../../../src/features/settings/app/queries';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

const PENDING_ANSWER: AppSettingsResponse = {
  ...DEFAULT_APP_SETTINGS,
  libraryLocationDefaultsPending: true,
};

const DETECTED_SETTINGS = withLibraryLocations(DEFAULT_APP_SETTINGS, DEFAULT_PROFILE_ID, {
  ...DEFAULT_LIBRARY_LOCATION_SETTINGS,
  home: { ...DEFAULT_LIBRARY_LOCATION_SETTINGS.home, 'claude-skills': true },
});

describe('libraryLocationDefaultsPending', () => {
  it('is true only for an answer flagged pending', () => {
    expect(libraryLocationDefaultsPending(PENDING_ANSWER)).toBe(true);
    expect(
      libraryLocationDefaultsPending({
        ...DEFAULT_APP_SETTINGS,
        libraryLocationDefaultsPending: false,
      })
    ).toBe(false);
  });

  it('treats settings a write produced, which carry no flag, as detected', () => {
    expect(libraryLocationDefaultsPending(DEFAULT_APP_SETTINGS)).toBe(false);
    expect(libraryLocationDefaultsPending(undefined)).toBe(false);
  });
});

describe('appSettingsForLocationWrite', () => {
  const fetchScenario = createFetchScenario();
  let queryClient: QueryClient;

  beforeEach(() => {
    fetchScenario.install();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    fetchScenario.restore();
    queryClient.clear();
  });

  it('uses detected cached settings without a request', async () => {
    queryClient.setQueryData(appSettingsKeys.current(), DETECTED_SETTINGS);

    const settings = await appSettingsForLocationWrite(queryClient);

    expect(libraryLocationsFor(settings)).toEqual(libraryLocationsFor(DETECTED_SETTINGS));
    expect(fetchScenario.fetchMock).not.toHaveBeenCalled();
  });

  it('refetches a pending cache and builds on the detected answer', async () => {
    queryClient.setQueryData(appSettingsKeys.current(), PENDING_ANSWER);
    fetchScenario.respondWithJson('GET', '/api/settings/app', {
      body: { ...DETECTED_SETTINGS, libraryLocationDefaultsPending: false },
    });

    const settings = await appSettingsForLocationWrite(queryClient);

    expect(
      libraryLocationsFor(settings),
      'expected the refetched detected locations | received: the cached placeholder'
    ).toEqual(libraryLocationsFor(DETECTED_SETTINGS));
  });

  it('refuses while the hub is still detecting, naming the state', async () => {
    queryClient.setQueryData(appSettingsKeys.current(), PENDING_ANSWER);
    fetchScenario.respondWithJson('GET', '/api/settings/app', { body: PENDING_ANSWER });

    await expect(appSettingsForLocationWrite(queryClient)).rejects.toThrow(
      'expected app settings with detected library-location defaults | received: libraryLocationDefaultsPending: true'
    );
  });
});

describe('keepLibraryDefaultsPending', () => {
  it('re-applies the flag a normalizer dropped when the source was pending', () => {
    expect(keepLibraryDefaultsPending(PENDING_ANSWER, DETECTED_SETTINGS)).toEqual({
      ...DETECTED_SETTINGS,
      libraryLocationDefaultsPending: true,
    });
  });

  it('leaves settings untouched when the source was detected or absent', () => {
    expect(keepLibraryDefaultsPending(DEFAULT_APP_SETTINGS, DETECTED_SETTINGS)).toBe(
      DETECTED_SETTINGS
    );
    expect(keepLibraryDefaultsPending(undefined, DETECTED_SETTINGS)).toBe(DETECTED_SETTINGS);
  });
});
