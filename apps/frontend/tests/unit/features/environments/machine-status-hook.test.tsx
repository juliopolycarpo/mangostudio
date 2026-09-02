/**
 * After an accepted action the status hook waits for a different process to
 * answer. A server that never comes back changes nothing the data-driven
 * check can see, so the wait must end on a clock as well.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { act } from '@testing-library/react';
import { useMachineStatus } from '../../../../src/features/environments/machine/queries';
import { renderHook, waitFor } from '../../../support/harness/render';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

const scenario = createFetchScenario();

afterEach(() => {
  scenario.restore();
});

describe('useMachineStatus', () => {
  it('stops waiting for a successor once the window closes', async () => {
    scenario
      .respondWithJson('GET', '/api/machine/status', { status: 503, body: { error: 'gone' } })
      .install();
    const { result } = renderHook(() => useMachineStatus({ windowMs: 40 }));
    await waitFor(() => expect(result.current.error).toBeTruthy());

    act(() => result.current.expectChange());
    expect(result.current.awaitingChange).toBe(true);

    await waitFor(() => expect(result.current.awaitingChange).toBe(false), { timeout: 2_000 });
  });
});
