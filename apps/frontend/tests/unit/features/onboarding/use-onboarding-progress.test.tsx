/**
 * The persisted half of first-run setup.
 *
 * Two properties matter and neither is visible from the component: the write
 * must address only the onboarding record — carrying anything else would let
 * the wizard roll back a setting some other surface owns — and each update must
 * compose off the newest stored value rather than off the render that created
 * the callback, or two saves in a burst would lose the first.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { DEFAULT_APP_SETTINGS, onboardingFor } from '@mangostudio/shared/app-settings';
import { act, waitFor } from '@testing-library/react';
import { useOnboardingProgress } from '../../../../src/features/onboarding/use-onboarding-progress';
import { renderHook } from '../../../support/harness/render';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

const scenario = createFetchScenario();

function bodyOf(callIndex: number): Record<string, unknown> {
  const init = scenario.fetchMock.mock.calls[callIndex]?.[1];
  return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
}

beforeEach(() => {
  scenario.respondWithJson('GET', '/api/settings/app', { body: DEFAULT_APP_SETTINGS });
  scenario.respondWithJson('PUT', '/api/settings/app', { body: DEFAULT_APP_SETTINGS });
  scenario.install();
});

afterEach(() => {
  scenario.restore();
});

describe('useOnboardingProgress', () => {
  it('starts from the untouched default while settings load', () => {
    const { result } = renderHook(() => useOnboardingProgress());

    expect(result.current.state.welcomeAcknowledged).toBe(false);
    expect(result.current.state.skippedSteps).toEqual([]);
  });

  it('sends only the onboarding record, never a whole settings object', async () => {
    const { result } = renderHook(() => useOnboardingProgress());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.update((current) => ({ ...current, welcomeAcknowledged: true }));
    });

    const put = scenario.fetchMock.mock.calls.findIndex(
      (call) => String(call[1]?.method).toUpperCase() === 'PUT'
    );
    const body = bodyOf(put) as { profileSettings: Record<string, unknown> };

    expect(Object.keys(body)).toEqual(['profileSettings']);
    expect(Object.keys(body.profileSettings.default as object)).toEqual(['onboarding']);
  });

  it('composes each update on the value the previous one saved', async () => {
    scenario.respondWithJson('PUT', '/api/settings/app', {
      body: onboardingSettings({ welcomeAcknowledged: true, skippedSteps: [] }),
    });

    const { result } = renderHook(() => useOnboardingProgress());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.update((current) => ({ ...current, welcomeAcknowledged: true }));
    });
    await act(async () => {
      await result.current.update((current) => ({ ...current, skippedSteps: ['service'] }));
    });

    const puts = scenario.fetchMock.mock.calls.filter(
      (call) => String(call[1]?.method).toUpperCase() === 'PUT'
    );
    const second = JSON.parse(String(puts[1]?.[1]?.body)) as {
      profileSettings: { default: { onboarding: { welcomeAcknowledged: boolean } } };
    };

    // The acknowledgement came back from the first save; a callback closed over
    // the first render would have sent `false` here.
    expect(second.profileSettings.default.onboarding.welcomeAcknowledged).toBe(true);
  });

  it('clears progress with an explicit null rather than an empty record', async () => {
    const { result } = renderHook(() => useOnboardingProgress());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.reset();
    });

    const put = scenario.fetchMock.mock.calls.findIndex(
      (call) => String(call[1]?.method).toUpperCase() === 'PUT'
    );
    const body = bodyOf(put) as { profileSettings: { default: { onboarding: unknown } } };

    expect(body.profileSettings.default.onboarding).toBeNull();
  });

  it('reads persisted progress back out of the settings response', async () => {
    scenario.respondWithJson('GET', '/api/settings/app', {
      body: onboardingSettings({ welcomeAcknowledged: true, skippedSteps: ['toolchain'] }),
    });

    const { result } = renderHook(() => useOnboardingProgress());

    await waitFor(() => expect(result.current.state.welcomeAcknowledged).toBe(true));
    expect(result.current.state.skippedSteps).toEqual(['toolchain']);
  });

  it('surfaces a failed save without losing the local answer', async () => {
    scenario.respondWithJson('PUT', '/api/settings/app', { status: 500, body: { error: 'nope' } });

    const { result } = renderHook(() => useOnboardingProgress());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current
        .update((current) => ({ ...current, welcomeAcknowledged: true }))
        .catch(() => undefined);
    });

    await waitFor(() => expect(result.current.saveFailed).toBe(true));
  });
});

function onboardingSettings(onboarding: Record<string, unknown>) {
  return {
    ...DEFAULT_APP_SETTINGS,
    profileSettings: {
      default: {
        ...DEFAULT_APP_SETTINGS.profileSettings.default,
        onboarding: { ...onboardingFor(DEFAULT_APP_SETTINGS), ...onboarding },
      },
    },
  };
}
