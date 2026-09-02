/**
 * After an accepted action the status hook waits for a different process to
 * answer. A server that never comes back changes nothing the data-driven
 * check can see, so the wait must end on a clock as well — and when it ends
 * with the server still gone, the status it was showing has to go with it.
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

  it('drops the status it was showing when the server never comes back', async () => {
    const status = {
      hub: { running: true, pid: 42, launch: 'detached' },
      service: {
        schemaVersion: 1,
        platform: 'linux',
        unitName: 'mangostudio.service',
        installed: true,
        enabled: true,
        running: true,
      },
      runtimeBinary: {
        path: null,
        present: false,
        version: null,
        versionMatches: null,
        error: null,
      },
      hostSlot: { present: false, profile: 'full', directory: '/h', error: null },
      platform: 'linux',
      standalone: false,
      container: false,
      homeDir: '/h',
      logsDir: '/h/logs',
      configFile: null,
      actions: {
        guard: { allowed: true, reasons: [] },
        restart: { available: true, command: 'mangostudio restart' },
        installService: { available: false, command: 'x', reason: 'already-installed' },
        uninstallService: { available: true, command: 'mangostudio service uninstall' },
      },
    };
    scenario.respondWithJson('GET', '/api/machine/status', { body: status }).install();
    const { result } = renderHook(() => useMachineStatus({ windowMs: 40 }));
    await waitFor(() => expect(result.current.data).toBeTruthy());

    // Removing the service from a service-managed hub stops the server for
    // good. Every later poll fails, and a failed refetch leaves the last good
    // document in the cache — so the page went on drawing a running hub with
    // its service installed.
    scenario.respondWithJson('GET', '/api/machine/status', {
      status: 503,
      body: { error: 'gone' },
    });
    act(() => result.current.expectChange());

    await waitFor(() => expect(result.current.data).toBeUndefined(), { timeout: 3_000 });
  });
});
