/**
 * The live half of first-run setup.
 *
 * One rule holds the whole hook together: a question the machine has not
 * answered is `unknown`, never `unsatisfied`. A refused probe and a machine
 * with nothing installed on it produce the same empty list, and reading the
 * first as the second is what would march someone back through steps they
 * already finished — on a reload, on a flaky network, on a hub that restarted.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { DEFAULT_ONBOARDING_STATE, type OnboardingState } from '@mangostudio/shared/onboarding';
import { waitFor } from '@testing-library/react';
import { useOnboardingFacts } from '../../../../src/features/onboarding/use-onboarding-facts';
import { flushAsyncRender, renderHook } from '../../../support/harness/render';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

const scenario = createFetchScenario();

const CODEX_TARGET = 'codex';

const CHOSE_CODEX: OnboardingState = {
  ...DEFAULT_ONBOARDING_STATE,
  welcomeAcknowledged: true,
  runner: { kind: 'external', targetId: CODEX_TARGET },
};

/**
 * Waits for discovery to have been asked and answered.
 *
 * `waitFor` alone is not enough for an assertion that a value is `unknown`: the
 * first render is already `unknown` because nothing has answered yet, so the
 * matcher passes before the request it is about has even settled — which is how
 * a test for this rule passes against code that breaks it.
 */
async function discoverySettled(): Promise<void> {
  await waitFor(() =>
    expect(
      scenario.fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/external-agents'))
    ).toBe(true)
  );
  await flushAsyncRender();
  await flushAsyncRender();
}

/** The one descriptor these tests care about: installed, signed in, pickable. */
function codexDescriptor() {
  return {
    targetId: CODEX_TARGET,
    vendorId: 'codex',
    label: 'Codex',
    environmentId: 'local',
    installed: true,
    auth: 'authenticated',
    capabilities: { models: [], permissions: [] },
  };
}

beforeEach(() => {
  scenario.respondWithJson('GET', '/api/environments', { body: [{ id: 'local', name: 'Local' }] });
  scenario.respondWithJson('GET', '/api/environments/runtimes?environmentId=local', { body: [] });
  scenario.respondWithJson('GET', '/api/machine/status', {
    body: {
      hub: { pid: 1 },
      service: { installed: false },
      actions: { installService: { available: false, reason: 'unsupported' } },
    },
  });
  scenario.install();
});

afterEach(() => {
  scenario.restore();
});

describe('useOnboardingFacts', () => {
  it('leaves the agent step undecided when discovery itself was refused', async () => {
    scenario.respondWithJson('GET', '/api/external-agents?environmentId=local', {
      status: 500,
      body: { code: 'INTERNAL', message: 'probe failed' },
    });

    const { result } = renderHook(() => useOnboardingFacts(CHOSE_CODEX));
    await discoverySettled();

    // `unsatisfied` here is the bug: the person picked Codex, and one refused
    // request would send them back to pick it again.
    expect(result.current.agents).toBe('unknown');
  });

  it('reads a chosen agent that is still usable as satisfied', async () => {
    scenario.respondWithJson('GET', '/api/external-agents?environmentId=local', {
      body: { agents: [codexDescriptor()] },
    });

    const { result } = renderHook(() => useOnboardingFacts(CHOSE_CODEX));

    await waitFor(() => expect(result.current.agents).toBe('satisfied'));
  });

  it('reopens the agent step when the chosen agent is gone from a healthy answer', async () => {
    scenario.respondWithJson('GET', '/api/external-agents?environmentId=local', {
      body: { agents: [] },
    });

    const { result } = renderHook(() => useOnboardingFacts(CHOSE_CODEX));

    await waitFor(() => expect(result.current.agents).toBe('unsatisfied'));
  });
});
