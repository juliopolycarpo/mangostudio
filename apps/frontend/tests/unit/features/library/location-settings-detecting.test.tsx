/**
 * Right after a hub start, the app-settings read answers before the hub has
 * detected which agent CLIs are installed, flagged `libraryLocationDefaultsPending`.
 * Every location enablement in that answer is a placeholder, so the library
 * screens must say "detecting" instead of rendering it — and converge on their
 * own once the hub publishes its `app` settings invalidation, because the
 * settings layout's subscription is not mounted here.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import {
  type AppSettingsResponse,
  DEFAULT_APP_SETTINGS,
  DEFAULT_LIBRARY_LOCATION_SETTINGS,
  withLibraryLocations,
} from '@mangostudio/shared/app-settings';
import { en } from '@mangostudio/shared/i18n';
import { DEFAULT_PROFILE_ID } from '@mangostudio/shared/profiles';
import { SETTINGS_TOPIC } from '@mangostudio/shared/realtime';

import { resetRealtimeInvalidations } from '@/lib/realtime/use-realtime-invalidation';
import { getTabWriterId } from '@/lib/realtime/writer-id';

import { act, renderHook, screen, waitFor } from '../../../support/harness/render';
import { renderWithRouter } from '../../../support/harness/render-with-router';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';
import { FakeRealtimeClient } from '../../../support/mocks/fake-realtime-client';
import { setTestSession } from '../../../support/setup/auth-client-stub';
import { location } from './fixtures';

const realtime = new FakeRealtimeClient();

void mock.module('@/lib/realtime/realtime-client', () => ({
  bindRealtimeClientToUser: () => undefined,
  resetRealtimeClient: () => undefined,
  getRealtimeClient: () => realtime,
}));

// Imported after the mock so the hooks bind the fake socket, not a real one.
const { LocationSettings } =
  await import('../../../../src/features/library/components/LocationSettings');
const { useCandidateLocations } =
  await import('../../../../src/features/library/hooks/use-candidate-locations');
const { useEnabledLocationIds } =
  await import('../../../../src/features/library/hooks/use-enabled-location-ids');

const l = en.library.locationSettings;

/** What the hub answers before detection: the placeholder defaults, flagged. */
const PENDING_ANSWER: AppSettingsResponse = {
  ...DEFAULT_APP_SETTINGS,
  libraryLocationDefaultsPending: true,
  revision: '"initial"',
};

/** What it answers after: Claude detected, so its skills directory is on. */
const DETECTED_ANSWER: AppSettingsResponse = {
  ...withLibraryLocations(DEFAULT_APP_SETTINGS, DEFAULT_PROFILE_ID, {
    ...DEFAULT_LIBRARY_LOCATION_SETTINGS,
    home: { ...DEFAULT_LIBRARY_LOCATION_SETTINGS.home, 'claude-skills': true },
  }),
  libraryLocationDefaultsPending: false,
  revision: '"detected"',
} satisfies AppSettingsResponse;

const LOCATIONS = [
  location({ id: 'mango-skills', path: '/home/dev/.mango/skills', targetIds: ['mangostudio'] }),
  location({ id: 'claude-skills', path: '/home/dev/.claude/skills', targetIds: ['claude'] }),
];

function publishAppInvalidation(writerId?: string): Promise<void> {
  return act(() =>
    realtime.invalidate({
      type: 'invalidate',
      topic: SETTINGS_TOPIC,
      scopes: ['app'],
      ...(writerId === undefined ? {} : { writerId }),
    })
  );
}

describe('library location defaults while the hub is detecting agents', () => {
  const fetchScenario = createFetchScenario();

  beforeEach(() => {
    setTestSession({ user: { id: 'user-test' } });
    resetRealtimeInvalidations();
    fetchScenario.install();
    fetchScenario.respondWithJson('GET', '/api/environments', { body: [] });
    fetchScenario.respondWithJson('GET', '/api/library/locations', { body: LOCATIONS });
  });

  afterEach(() => {
    fetchScenario.restore();
  });

  it('shows the detecting state instead of placeholder switches, then the detected rows', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/app', { body: PENDING_ANSWER });

    await renderWithRouter(<LocationSettings />);

    await waitFor(() =>
      expect(
        screen.queryByText(l.detecting) !== null,
        `expected the "${l.detecting}" state while pending | received: not shown`
      ).toBe(true)
    );
    expect(
      document.getElementById('library-location-claude-skills'),
      'expected no location switch while detecting | received: a switch showing the placeholder'
    ).toBeNull();
    await waitFor(() =>
      expect(
        realtime.isSubscribed(SETTINGS_TOPIC),
        'expected a settings subscription while detecting | received: none'
      ).toBe(true)
    );

    fetchScenario.respondWithJson('GET', '/api/settings/app', { body: DETECTED_ANSWER });
    await publishAppInvalidation();

    await screen.findByText('/home/dev/.claude/skills');
    const toggle = document.getElementById('library-location-claude-skills') as HTMLInputElement;
    expect(toggle, 'expected claude-skills: on, as detected').toBeChecked();
    expect(screen.queryByText(l.detecting)).not.toBeInTheDocument();
    expect(
      realtime.isSubscribed(SETTINGS_TOPIC),
      'expected the detection listener to unsubscribe once the defaults are real'
    ).toBe(false);
  });

  it('skips the echo of this tab own write but refetches for any other writer', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/app', { body: PENDING_ANSWER });
    const settingsReads = () =>
      fetchScenario.fetchMock.mock.calls.filter(
        ([input]) =>
          new URL(input instanceof Request ? input.url : String(input), 'http://localhost')
            .pathname === '/api/settings/app'
      ).length;

    renderHook(() => useEnabledLocationIds());
    await waitFor(() => expect(realtime.isSubscribed(SETTINGS_TOPIC)).toBe(true));
    const readsBeforeEvents = settingsReads();

    // This tab's own write already answered after detection, so its echo has
    // nothing new to fetch.
    await publishAppInvalidation(getTabWriterId());
    expect(
      settingsReads(),
      `expected no app-settings read after this tab's own echo | received: ${settingsReads() - readsBeforeEvents} more`
    ).toBe(readsBeforeEvents);

    // Another tab's write (or the hub's detection event, which names nobody)
    // is applied at once, with no window to wait out.
    await publishAppInvalidation('other-tab-writer');
    await waitFor(() => expect(settingsReads()).toBe(readsBeforeEvents + 1));
    await publishAppInvalidation();
    await waitFor(() => expect(settingsReads()).toBe(readsBeforeEvents + 2));
  });

  it('never subscribes when the defaults were already detected', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/app', { body: DETECTED_ANSWER });

    await renderWithRouter(<LocationSettings />);
    await screen.findByText('/home/dev/.claude/skills');

    expect(realtime.isSubscribed(SETTINGS_TOPIC)).toBe(false);
  });

  it('keeps propagation candidates unresolved and flagged detecting until detection lands', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/app', { body: PENDING_ANSWER });

    const { result } = renderHook(() => useCandidateLocations(LOCATIONS, 'skill'));

    await waitFor(() =>
      expect(
        result.current.isDetecting,
        'expected candidates while pending: detecting | received: not detecting'
      ).toBe(true)
    );
    expect(result.current).toEqual({ locationIds: [], isResolved: false, isDetecting: true });

    fetchScenario.respondWithJson('GET', '/api/settings/app', { body: DETECTED_ANSWER });
    await waitFor(() =>
      expect(
        realtime.isSubscribed(SETTINGS_TOPIC),
        'expected a settings subscription while detecting | received: none'
      ).toBe(true)
    );
    await publishAppInvalidation();

    await waitFor(() =>
      expect(result.current).toEqual({
        locationIds: ['mango-skills', 'claude-skills'],
        isResolved: true,
        isDetecting: false,
      })
    );
  });

  it('leaves the enabled-location set unknown while pending, then names only the enabled ones', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/app', { body: PENDING_ANSWER });

    const { result } = renderHook(() => useEnabledLocationIds());

    await waitFor(() =>
      expect(
        realtime.isSubscribed(SETTINGS_TOPIC),
        'expected a settings subscription while detecting | received: none'
      ).toBe(true)
    );
    expect(
      result.current,
      'expected enabled ids: undefined while pending | received: a set of placeholder defaults'
    ).toBeUndefined();

    fetchScenario.respondWithJson('GET', '/api/settings/app', { body: DETECTED_ANSWER });
    await publishAppInvalidation();

    await waitFor(() => expect(result.current).toBeDefined());
    expect(result.current?.has('claude-skills')).toBe(true);
    expect(result.current?.has('mango-skills')).toBe(true);
    // Not in DETECTED_ANSWER, so it was never turned on.
    expect(
      result.current?.has('agents-skills'),
      'expected agents-skills to be absent from the enabled set'
    ).toBe(false);
  });
});
