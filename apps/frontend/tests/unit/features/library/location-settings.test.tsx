/**
 * LocationSettings: every directory the scanner can read, grouped by kind, and
 * the one switch that decides whether it is walked.
 *
 * `mango-skills`/`mango-agents` render locked because `normalizeLibraryLocationSettings`
 * force-sets them on — a row that could be switched off there would be a lie
 * next to the enforcement app-settings actually does. Every toggle writes the
 * *whole* `AppSettings` back through `withLibraryLocations`, so the save tests
 * inspect the PUT body rather than trusting a green request count: a toggle
 * that clobbered a sibling's enablement would still "succeed".
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  type AppSettings,
  DEFAULT_APP_SETTINGS,
  DEFAULT_LIBRARY_LOCATION_SETTINGS,
  withLibraryLocations,
} from '@mangostudio/shared/app-settings';
import { en } from '@mangostudio/shared/i18n';
import { DEFAULT_PROFILE_ID } from '@mangostudio/shared/profiles';
import userEvent from '@testing-library/user-event';
import { LocationSettings } from '../../../../src/features/library/components/LocationSettings';
import { screen, waitFor, within } from '../../../support/harness/render';
import { renderWithRouter } from '../../../support/harness/render-with-router';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';
import { location } from './fixtures';

const l = en.library.locationSettings;
const kinds = en.library.kinds;
const targets = en.library.targets;

type FetchCall = [RequestInfo | URL, (RequestInit | undefined)?];

/**
 * Finds the call matching a method and pathname among a fetch mock's calls.
 * The client's fetcher always passes a string URL and a plain `init` (see
 * `src/lib/api-client.ts`), but a `Request` instance is accepted too so this
 * helper matches the shape other suites already rely on.
 */
function findRequest(calls: FetchCall[], method: string, path: string): FetchCall | undefined {
  return calls.find(([input, init]) => {
    const requestMethod = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const url = input instanceof Request ? input.url : String(input);
    return (
      requestMethod.toUpperCase() === method.toUpperCase() &&
      new URL(url, 'http://localhost').pathname === path
    );
  });
}

/** Reads a PUT body back out of a captured call as the `AppSettings` it carried. */
async function readAppSettingsBody(call: FetchCall): Promise<AppSettings> {
  const [input, init] = call;
  const body = input instanceof Request ? await input.clone().text() : init?.body;
  return JSON.parse(typeof body === 'string' ? body : String(body));
}

/** An `AppSettings` whose home library locations are exactly the defaults plus `home`. */
function settingsWithHome(home: Record<string, boolean>): AppSettings {
  return withLibraryLocations(DEFAULT_APP_SETTINGS, DEFAULT_PROFILE_ID, {
    ...DEFAULT_LIBRARY_LOCATION_SETTINGS,
    home: { ...DEFAULT_LIBRARY_LOCATION_SETTINGS.home, ...home },
  });
}

describe('LocationSettings', () => {
  const fetchScenario = createFetchScenario();

  beforeEach(() => {
    fetchScenario.install();
    // useEnvironmentScope() reads the environment list even though this page
    // never scopes to a remote machine in these tests; an empty roster keeps
    // it on the local default without a picker.
    fetchScenario.respondWithJson('GET', '/api/environments', { body: [] });
  });

  afterEach(() => {
    fetchScenario.restore();
  });

  it("groups rows by kind and shows each row's resolved path", async () => {
    fetchScenario.respondWithJson('GET', '/api/library/locations', {
      body: [
        location({ id: 'agents-skills', kind: 'skill', path: '/home/dev/.agents/skills' }),
        location({
          id: 'claude-skills',
          kind: 'skill',
          path: '/home/dev/.claude/skills',
          targetIds: ['claude'],
        }),
        location({
          id: 'claude-commands',
          kind: 'command',
          path: '/home/dev/.claude/commands',
          targetIds: ['claude'],
        }),
      ],
    });
    fetchScenario.respondWithJson('GET', '/api/settings/app', { body: DEFAULT_APP_SETTINGS });

    await renderWithRouter(<LocationSettings />);

    const skillGroup = (await screen.findByText(kinds.skill)).closest('section');
    const commandGroup = screen.getByText(kinds.command).closest('section');
    if (!skillGroup || !commandGroup) throw new Error('Expected both kind sections to render.');

    expect(within(skillGroup).getByText('/home/dev/.agents/skills')).toBeInTheDocument();
    expect(within(skillGroup).getByText('/home/dev/.claude/skills')).toBeInTheDocument();
    expect(within(skillGroup).queryByText('/home/dev/.claude/commands')).not.toBeInTheDocument();
    expect(within(commandGroup).getByText('/home/dev/.claude/commands')).toBeInTheDocument();
  });

  it('enabling a location PUTs true for it and preserves the rest of the enabled set', async () => {
    const user = userEvent.setup();
    fetchScenario.respondWithJson('GET', '/api/library/locations', {
      body: [
        location({ id: 'agents-skills', kind: 'skill', path: '/home/dev/.agents/skills' }),
        location({
          id: 'claude-skills',
          kind: 'skill',
          path: '/home/dev/.claude/skills',
          targetIds: ['claude'],
        }),
      ],
    });
    fetchScenario.respondWithJson('GET', '/api/settings/app', {
      body: settingsWithHome({ 'agents-skills': true, 'claude-skills': false }),
    });
    fetchScenario.respondWithJson('PUT', '/api/settings/app', {
      body: settingsWithHome({ 'agents-skills': true, 'claude-skills': true }),
    });

    await renderWithRouter(<LocationSettings />);
    await screen.findByText('/home/dev/.claude/skills');

    const toggle = document.getElementById('library-location-claude-skills') as HTMLInputElement;
    expect(toggle).not.toBeChecked();
    await user.click(toggle);

    await waitFor(() => {
      expect(
        findRequest(fetchScenario.fetchMock.mock.calls, 'PUT', '/api/settings/app')
      ).toBeDefined();
    });

    const call = findRequest(fetchScenario.fetchMock.mock.calls, 'PUT', '/api/settings/app');
    const body = await readAppSettingsBody(call as FetchCall);
    const home = body.profileSettings[DEFAULT_PROFILE_ID]?.libraryLocations.home;
    expect(home?.['claude-skills']).toBe(true);
    // The other location the user had already enabled must survive the write.
    expect(home?.['agents-skills']).toBe(true);
  });

  it('disabling an enabled location PUTs false for that id only', async () => {
    const user = userEvent.setup();
    fetchScenario.respondWithJson('GET', '/api/library/locations', {
      body: [
        location({ id: 'agents-skills', kind: 'skill', path: '/home/dev/.agents/skills' }),
        location({
          id: 'claude-skills',
          kind: 'skill',
          path: '/home/dev/.claude/skills',
          targetIds: ['claude'],
        }),
      ],
    });
    fetchScenario.respondWithJson('GET', '/api/settings/app', {
      body: settingsWithHome({ 'agents-skills': true, 'claude-skills': true }),
    });
    fetchScenario.respondWithJson('PUT', '/api/settings/app', {
      body: settingsWithHome({ 'agents-skills': true, 'claude-skills': false }),
    });

    await renderWithRouter(<LocationSettings />);
    await screen.findByText('/home/dev/.claude/skills');

    const toggle = document.getElementById('library-location-claude-skills') as HTMLInputElement;
    expect(toggle).toBeChecked();
    await user.click(toggle);

    await waitFor(() => {
      expect(
        findRequest(fetchScenario.fetchMock.mock.calls, 'PUT', '/api/settings/app')
      ).toBeDefined();
    });

    const call = findRequest(fetchScenario.fetchMock.mock.calls, 'PUT', '/api/settings/app');
    const body = await readAppSettingsBody(call as FetchCall);
    const home = body.profileSettings[DEFAULT_PROFILE_ID]?.libraryLocations.home;
    expect(home?.['claude-skills']).toBe(false);
    expect(home?.['agents-skills']).toBe(true);
  });

  it('renders mango-skills as a locked "always scanned" row with no switch', async () => {
    fetchScenario.respondWithJson('GET', '/api/library/locations', {
      body: [
        location({
          id: 'mango-skills',
          kind: 'skill',
          path: '/home/dev/.mango/skills',
          targetIds: ['mangostudio'],
        }),
      ],
    });
    fetchScenario.respondWithJson('GET', '/api/settings/app', { body: DEFAULT_APP_SETTINGS });

    await renderWithRouter(<LocationSettings />);
    await screen.findByText('/home/dev/.mango/skills');

    expect(screen.getByText(l.alwaysOn)).toBeInTheDocument();
    expect(screen.getByTitle(l.alwaysOnHint)).toBeInTheDocument();
    expect(document.getElementById('library-location-mango-skills')).toBeNull();
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
  });

  it('disables the switch and explains why when a location has no path on this platform', async () => {
    fetchScenario.respondWithJson('GET', '/api/library/locations', {
      body: [
        location({
          id: 'codex-prompts',
          kind: 'command',
          path: null,
          exists: false,
          readable: false,
          writable: false,
          targetIds: ['codex'],
        }),
      ],
    });
    fetchScenario.respondWithJson('GET', '/api/settings/app', { body: DEFAULT_APP_SETTINGS });

    await renderWithRouter(<LocationSettings />);

    // The mono path line falls back to the id when the location has no path.
    await screen.findByText('codex-prompts');
    expect(screen.getByText(`${targets.codex} · ${l.unsupported}`)).toBeInTheDocument();

    const toggle = document.getElementById('library-location-codex-prompts') as HTMLInputElement;
    expect(toggle).toBeDisabled();
  });

  it('invalidates the library cache after a save, so the locations list is refetched', async () => {
    const user = userEvent.setup();
    fetchScenario.respondWithJson('GET', '/api/library/locations', {
      body: [location({ id: 'agents-skills', kind: 'skill', path: '/home/dev/.agents/skills' })],
    });
    fetchScenario.respondWithJson('GET', '/api/settings/app', {
      body: settingsWithHome({ 'agents-skills': false }),
    });
    fetchScenario.respondWithJson('PUT', '/api/settings/app', {
      body: settingsWithHome({ 'agents-skills': true }),
    });

    await renderWithRouter(<LocationSettings />);
    await screen.findByText('/home/dev/.agents/skills');

    const toggle = document.getElementById('library-location-agents-skills') as HTMLInputElement;
    await user.click(toggle);

    // `onSuccess` invalidates `libraryKeys.all`, which the locations query this
    // very page reads sits under — so the scan answer being stale is provable
    // by watching this page re-request its own list, not just a mock's intent.
    await waitFor(() => {
      const locationsCalls = fetchScenario.fetchMock.mock.calls.filter(
        (call) => findRequest([call as FetchCall], 'GET', '/api/library/locations') !== undefined
      );
      expect(locationsCalls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
