import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { DEFAULT_APP_SETTINGS, withOnboarding } from '@mangostudio/shared/app-settings';
import { useQueryClient } from '@tanstack/react-query';

import { useLocationSettings } from '../../../../src/features/library/hooks/use-location-settings';
import { useOnboardingProgress } from '../../../../src/features/onboarding/use-onboarding-progress';
import {
  appSettingsKeys,
  appSettingsRevision,
} from '../../../../src/features/settings/app/queries';
import { useToggleSkillSource } from '../../../../src/features/settings/skills/hooks/use-skill-settings';
import { useGlobalSettings } from '../../../../src/hooks/use-global-settings';
import { act, renderHook, waitFor } from '../../../support/harness/render';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

const scenario = createFetchScenario();
const initial = {
  ...DEFAULT_APP_SETTINGS,
  revision: '"r1"',
  libraryLocationDefaultsPending: false,
};
const saved = { ...initial, revision: '"r2"' };

type ScenarioFetch = NonNullable<ReturnType<typeof scenario.fetchMock.getMockImplementation>>;
class HeldFirstSettingsWrite {
  private resolveWrite: ((response: Response) => void) | undefined;
  readonly firstWrite = new Promise<Response>((resolve) => {
    this.resolveWrite = resolve;
  });
  private writes = 0;
  constructor(private readonly delegate: ScenarioFetch) {}
  fetch: ScenarioFetch = (input, init) => {
    if (init?.method === 'PUT' && ++this.writes === 1) return this.firstWrite;
    return this.delegate(input, init);
  };
  release(body: unknown): void {
    this.resolveWrite?.(
      new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
    );
  }
}

function sentRevisions(): Array<string | null> {
  return scenario.fetchMock.mock.calls
    .filter((call) => call[1]?.method === 'PUT')
    .map((call) => new Headers(call[1]?.headers).get('if-match'));
}

beforeEach(() => {
  scenario.respondWithJson('GET', '/api/settings/app', { body: initial });
  scenario.respondWithJson('PUT', '/api/settings/app', { body: saved });
  scenario.respondWithJson('GET', '/api/library/locations', { body: [] });
  scenario.install();
});

afterEach(() => scenario.restore());

describe('app settings mutation revision owners', () => {
  it('keeps another mutation owner newer confirmed cache when an older response arrives', async () => {
    const delegate = scenario.fetchMock.getMockImplementation();
    if (!delegate) throw new Error('expected the named fetch scenario implementation');
    const writer = new HeldFirstSettingsWrite(delegate);
    scenario.fetchMock.mockImplementation(writer.fetch);
    const { result } = renderHook(() => ({
      global: useGlobalSettings(),
      onboarding: useOnboardingProgress(),
      queryClient: useQueryClient(),
    }));
    await waitFor(() => expect(result.current.global.isLoading).toBe(false));
    let first: Promise<void> | undefined;
    act(() => {
      first = result.current.global.updateExternalAgentSettings({});
    });
    await waitFor(() => expect(sentRevisions()).toHaveLength(1));
    // The global write committed r2 but its response is still in transit.
    scenario.respondWithJson('PUT', '/api/settings/app', {
      status: 409,
      body: { error: 'Settings changed', code: 'CONFLICT' },
    });
    scenario.respondWithJson('GET', '/api/settings/app', { body: saved });
    await act(async () => {
      await expect(
        result.current.onboarding.update((state) => ({ ...state, welcomeAcknowledged: true }))
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    });
    const winner = {
      ...withOnboarding(DEFAULT_APP_SETTINGS, { welcomeAcknowledged: true, skippedSteps: [] }),
      revision: '"r3"',
      libraryLocationDefaultsPending: false,
    };
    scenario.respondWithJson('PUT', '/api/settings/app', { body: winner });
    await act(async () => {
      await result.current.onboarding.update((state) => ({ ...state, welcomeAcknowledged: true }));
    });
    expect(result.current.onboarding.state.welcomeAcknowledged).toBe(true);
    await act(async () => {
      writer.release(saved);
      await first;
    });
    expect(result.current.onboarding.state.welcomeAcknowledged).toBe(true);
    expect(
      appSettingsRevision(result.current.queryClient.getQueryData(appSettingsKeys.current()))
    ).toBe('"r3"');
    expect(sentRevisions()).toEqual(['"r1"', '"r1"', '"r2"']);
  });

  it('onboarding carries the snapshot token through a confirmed save and reset', async () => {
    const { result } = renderHook(() => ({
      hook: useOnboardingProgress(),
      queryClient: useQueryClient(),
    }));
    await waitFor(() => expect(result.current.hook.isLoading).toBe(false));
    await act(async () => {
      await result.current.hook.update((current) => ({ ...current, welcomeAcknowledged: true }));
    });
    await act(async () => {
      await result.current.hook.reset();
    });
    expect(sentRevisions()).toEqual(['"r1"', '"r2"']);
    expect(
      appSettingsRevision(result.current.queryClient.getQueryData(appSettingsKeys.current()))
    ).toBe('"r2"');
  });

  it('location toggles carry the snapshot token and preserve the confirmed token', async () => {
    const { result } = renderHook(() => ({
      hook: useLocationSettings(),
      queryClient: useQueryClient(),
    }));
    await waitFor(() => expect(result.current.hook.isPending).toBe(false));
    act(() => result.current.hook.setEnabled('claude-skills', true));
    await waitFor(() => expect(sentRevisions()).toHaveLength(1));
    await waitFor(() => expect(result.current.hook.isSaving).toBe(false));
    expect(sentRevisions()).toEqual(['"r1"']);
    expect(
      appSettingsRevision(result.current.queryClient.getQueryData(appSettingsKeys.current()))
    ).toBe('"r2"');
  });

  it('skill sources use the refreshed revision after a stale save conflicts', async () => {
    const { result } = renderHook(() => ({
      hook: useToggleSkillSource(),
      queryClient: useQueryClient(),
    }));
    result.current.queryClient.setQueryData(appSettingsKeys.current(), initial);
    scenario.respondWithJson('PUT', '/api/settings/app', {
      status: 409,
      body: { error: 'Settings changed', code: 'CONFLICT' },
    });
    scenario.respondWithJson('GET', '/api/settings/app', {
      body: { ...initial, revision: '"winner"' },
    });
    await act(async () => {
      await expect(
        result.current.hook.mutateAsync({ source: 'agents', enabled: true })
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    });
    scenario.respondWithJson('PUT', '/api/settings/app', { body: saved });
    await act(async () => {
      await result.current.hook.mutateAsync({ source: 'agents', enabled: true });
    });
    expect(sentRevisions()).toEqual(['"r1"', '"winner"']);
    expect(
      appSettingsRevision(result.current.queryClient.getQueryData(appSettingsKeys.current()))
    ).toBe('"r2"');
  });
});
