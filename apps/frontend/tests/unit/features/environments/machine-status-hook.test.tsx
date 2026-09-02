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

/** A service-managed hub, which is the shape an uninstall takes away. */
const STATUS = {
  hub: { running: true, pid: 42, launch: 'detached' },
  service: {
    schemaVersion: 1,
    platform: 'linux',
    unitName: 'mangostudio.service',
    installed: true,
    enabled: true,
    running: true,
  },
  runtimeBinary: { path: null, present: false, version: null, versionMatches: null, error: null },
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
    scenario.respondWithJson('GET', '/api/machine/status', { body: STATUS }).install();
    const { result } = renderHook(() => useMachineStatus({ windowMs: 40 }));
    await waitFor(() => expect(result.current.data).toBeTruthy());

    // Removing the service from a service-managed hub stops the server for
    // good. A failed refetch leaves the last good document in the cache — so
    // the page went on drawing a running hub with its service installed.
    scenario.respondWithJson('GET', '/api/machine/status', {
      status: 503,
      body: { error: 'gone' },
    });
    act(() => result.current.expectChange());
    // The refetch the mutation's invalidation kicks off, which finds nothing.
    await act(async () => {
      await result.current.refetch();
    });

    await waitFor(() => expect(result.current.data).toBeUndefined(), { timeout: 3_000 });
  });

  it('drops it even when the dying process answered once more first', async () => {
    scenario.respondWithJson('GET', '/api/machine/status', { body: STATUS }).install();
    const { result } = renderHook(() => useMachineStatus({ windowMs: 400 }));
    await waitFor(() => expect(result.current.data).toBeTruthy());

    act(() => result.current.expectChange());

    // The mutation invalidates this query the moment the action is accepted,
    // and the server does not stand down for another 50 ms — so this refetch
    // succeeds, from the same pid that is about to go away. Deciding on "did
    // anything answer during the window" would call that a sign of life and
    // keep the document for good.
    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.data).toBeTruthy();

    scenario.respondWithJson('GET', '/api/machine/status', {
      status: 503,
      body: { error: 'gone' },
    });
    await act(async () => {
      await result.current.refetch();
    });

    await waitFor(() => expect(result.current.data).toBeUndefined(), { timeout: 3_000 });
  });

  it('keeps the document when the hub is still answering on the same pid', async () => {
    scenario.respondWithJson('GET', '/api/machine/status', { body: STATUS }).install();
    const { result } = renderHook(() => useMachineStatus({ windowMs: 40 }));
    await waitFor(() => expect(result.current.data).toBeTruthy());

    act(() => result.current.expectChange());
    await waitFor(() => expect(result.current.awaitingChange).toBe(false), { timeout: 2_000 });

    // Nothing failed, so nothing is stale — an action that changed no pid is
    // not a reason to blank a page whose server is right there.
    expect(result.current.data).toBeTruthy();
  });
});
