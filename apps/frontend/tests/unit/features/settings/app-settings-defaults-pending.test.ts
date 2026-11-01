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
  appSettingsQueryOptions,
  keepLibraryDefaultsPending,
  libraryLocationDefaultsPending,
  refreshAppSettingsAfterConflict,
} from '../../../../src/features/settings/app/queries';
import { ApiError } from '../../../../src/lib/utils';
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

  it('refetches an invalidated cache instead of building a location retry on stale settings', async () => {
    queryClient.setQueryData(appSettingsKeys.current(), DEFAULT_APP_SETTINGS);
    await queryClient.invalidateQueries({
      queryKey: appSettingsKeys.current(),
      refetchType: 'none',
    });
    fetchScenario.respondWithJson('GET', '/api/settings/app', {
      body: { ...DETECTED_SETTINGS, libraryLocationDefaultsPending: false },
    });
    const settings = await appSettingsForLocationWrite(queryClient);
    expect(libraryLocationsFor(settings)).toEqual(libraryLocationsFor(DETECTED_SETTINGS));
    expect(fetchScenario.fetchMock.mock.calls).toHaveLength(1);
  });

  it('keeps the conflict invalidation while canceling an older read', async () => {
    queryClient.setQueryData(appSettingsKeys.current(), DEFAULT_APP_SETTINGS);
    const firstRead = Promise.withResolvers<Response>();
    const secondRead = Promise.withResolvers<Response>();
    const firstStarted = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    let reads = 0;
    const originalFetch = fetchScenario.fetchMock.getMockImplementation();
    if (!originalFetch) throw new Error('Expected an installed fetch scenario');
    fetchScenario.fetchMock.mockImplementation(async (_input, init) => {
      if (init?.method !== 'GET') throw new Error('Unexpected non-GET request');
      reads += 1;
      if (reads === 1) {
        firstStarted.resolve();
        return firstRead.promise;
      }
      if (reads === 2) {
        secondStarted.resolve();
        return secondRead.promise;
      }
      throw new Error('Unexpected extra settings read');
    });
    const older = queryClient
      .fetchQuery({ ...appSettingsQueryOptions(), staleTime: 0 })
      .catch(() => undefined);
    await firstStarted.promise;
    const refresh = refreshAppSettingsAfterConflict(
      queryClient,
      new ApiError({ code: 'CONFLICT' })
    );
    try {
      await secondStarted.promise;
      expect(queryClient.getQueryState(appSettingsKeys.current())?.isInvalidated).toBe(true);
    } finally {
      fetchScenario.fetchMock.mockImplementation(originalFetch);
      firstRead.resolve(Response.json(DEFAULT_APP_SETTINGS));
      secondRead.resolve(Response.json(DETECTED_SETTINGS));
      await Promise.all([older, refresh]);
    }
    expect(queryClient.getQueryData(appSettingsKeys.current())).toMatchObject(DETECTED_SETTINGS);
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
