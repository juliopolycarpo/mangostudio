/**
 * After an accepted action the status hook waits for a different process to
 * answer. A server that never comes back changes nothing the data-driven
 * check can see, so the wait must end on a clock as well — and when it ends
 * with the server still gone, the status it was showing has to go with it.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { useQueryClient } from '@tanstack/react-query';
import { act } from '@testing-library/react';
import { useMachineStatus } from '../../../../src/features/environments/machine/queries';
import { renderHook, waitFor } from '../../../support/harness/render';
import {
  advanceTimersByTimeAsync,
  useFakeTimers as installFakeTimers,
} from '../../../support/harness/timers';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

const scenario = createFetchScenario();
const scenarioFetch = scenario.fetchMock.getMockImplementation();
if (!scenarioFetch)
  throw new Error('expected the named fetch scenario implementation | received undefined');
const gates: GatedMachineStatusFetch[] = [];

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
  for (const gate of gates.splice(0)) gate.release(503, { error: 'gone' });
  scenario.fetchMock.mockImplementation(scenarioFetch);
  scenario.restore();
});

describe('useMachineStatus', () => {
  it('stops waiting for a successor once the window closes', async () => {
    scenario
      .respondWithJson('GET', '/api/machine/status', { status: 503, body: { error: 'gone' } })
      .install();
    const { result } = renderHook(() => useMachineStatus({ windowMs: 40 }));
    await waitFor(() => expect(result.current.error).toBeTruthy());

    installFakeTimers();
    act(() => result.current.expectChange());
    expect(result.current.awaitingChange).toBe(true);

    await advanceTimersByTimeAsync(40);
    expect(result.current.awaitingChange).toBe(false);
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
    installFakeTimers();
    act(() => result.current.expectChange());
    // The refetch the mutation's invalidation kicks off, which finds nothing.
    await act(async () => {
      await result.current.refetch();
    });

    await advanceTimersByTimeAsync(40);
    expect(result.current.data).toBeUndefined();
  });

  it('drops it even when the dying process answered once more first', async () => {
    scenario.respondWithJson('GET', '/api/machine/status', { body: STATUS }).install();
    const { result } = renderHook(() => useMachineStatus({ windowMs: 400 }));
    await waitFor(() => expect(result.current.data).toBeTruthy());

    installFakeTimers();
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

    await advanceTimersByTimeAsync(400);
    expect(result.current.data).toBeUndefined();
  });

  it('keeps the document when the hub is still answering on the same pid', async () => {
    scenario.respondWithJson('GET', '/api/machine/status', { body: STATUS }).install();
    const { result } = renderHook(() => useMachineStatus({ windowMs: 40 }));
    await waitFor(() => expect(result.current.data).toBeTruthy());

    installFakeTimers();
    act(() => result.current.expectChange());
    await advanceTimersByTimeAsync(40);
    expect(result.current.awaitingChange).toBe(false);

    // Nothing failed, so nothing is stale — an action that changed no pid is
    // not a reason to blank a page whose server is right there.
    expect(result.current.data).toBeTruthy();
  });
});

/** A named status transport whose owned response is released independently of the clock. */
class GatedMachineStatusFetch {
  private releaseResponse!: (response: Response) => void;
  private announceStarted!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.announceStarted = resolve;
  });
  private readonly response = new Promise<Response>((resolve) => {
    this.releaseResponse = resolve;
  });

  readonly fetch = (input: RequestInfo | URL): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.includes('/api/machine/status'))
      throw new Error(`expected machine status request | received ${url}`);
    this.announceStarted();
    return this.response;
  };

  /** Complete the held request; later cleanup releases are harmless. */
  release(status: number, body: unknown): void {
    this.releaseResponse(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  }
}

/** Open one action window with a pending owned request. Usage: await startGatedAction(). */
async function startGatedAction() {
  scenario.respondWithJson('GET', '/api/machine/status', { body: STATUS }).install();
  const rendered = renderHook(() => ({
    ...useMachineStatus({ windowMs: 40 }),
    queryClient: useQueryClient(),
  }));
  await waitFor(() => expect(rendered.result.current.data?.hub.pid).toBe(42));
  const gate = new GatedMachineStatusFetch();
  gates.push(gate);
  scenario.fetchMock.mockImplementation(gate.fetch);
  installFakeTimers();
  act(() => rendered.result.current.expectChange());
  let pending!: ReturnType<typeof rendered.result.current.refetch>;
  act(() => {
    pending = rendered.result.current.refetch();
  });
  await gate.started;
  return { ...rendered, gate, pending };
}

describe('machine status expiry with an owned request', () => {
  it('drops stale data when the failure settles after the window', async () => {
    const { result, gate, pending } = await startGatedAction();
    await advanceTimersByTimeAsync(40);
    expect(result.current.awaitingChange).toBe(false);
    await act(async () => {
      gate.release(503, { error: 'gone' });
      expect((await pending).error).toBeTruthy();
    });
    await advanceTimersByTimeAsync(0);
    expect(
      result.current.data,
      'expired machine status: expected no document after owned late failure | received prior hub pid 42'
    ).toBeUndefined();
  });

  it.each([42, 43])('keeps a successful response from pid %i after expiry', async (pid) => {
    const { result, gate, pending } = await startGatedAction();
    await advanceTimersByTimeAsync(40);
    expect(result.current.awaitingChange).toBe(false);
    await act(async () => {
      gate.release(200, { ...STATUS, hub: { ...STATUS.hub, pid } });
      await pending;
    });
    await advanceTimersByTimeAsync(0);
    expect(result.current.data?.hub.pid).toBe(pid);

    const later = new GatedMachineStatusFetch();
    gates.push(later);
    scenario.fetchMock.mockImplementation(later.fetch);
    await act(async () => {
      const refetch = result.current.refetch();
      await later.started;
      later.release(503, { error: 'unrelated later failure' });
      expect((await refetch).error).toBeTruthy();
    });
    await advanceTimersByTimeAsync(0);
    expect(result.current.data?.hub.pid).toBe(pid);
  });

  it.each([20, 40])('gives a replacement action at %ims its own window', async (elapsed) => {
    const { result, gate, pending } = await startGatedAction();
    await advanceTimersByTimeAsync(elapsed);
    act(() => result.current.expectChange());
    await advanceTimersByTimeAsync(20);
    expect(result.current.awaitingChange).toBe(true);
    await act(async () => {
      gate.release(503, { error: 'gone' });
      await pending;
    });
    await advanceTimersByTimeAsync(20);
    expect(result.current.awaitingChange).toBe(false);
    expect(result.current.data).toBeUndefined();
  });

  it('retires expiry when the observer unmounts', async () => {
    const { result, gate, pending, unmount } = await startGatedAction();
    await act(async () => {
      gate.release(503, { error: 'gone' });
      await pending;
    });
    const client = result.current.queryClient;
    unmount();
    await advanceTimersByTimeAsync(40);
    expect(client.getQueryData<typeof STATUS>(['machine', 'status'])?.hub.pid).toBe(42);
  });
  it('retires the owned success before a later failure even without an observer flush', async () => {
    const { result, gate, pending } = await startGatedAction();
    await advanceTimersByTimeAsync(40);
    const later = new GatedMachineStatusFetch();
    gates.push(later);
    scenario.fetchMock.mockImplementation(later.fetch);
    await act(async () => {
      gate.release(200, STATUS);
      await pending;
      const refetch = result.current.refetch();
      await later.started;
      later.release(503, { error: 'unrelated before observer notification' });
      expect((await refetch).error).toBeTruthy();
    });
    await advanceTimersByTimeAsync(0);
    expect(
      result.current.data?.hub.pid,
      'settled owned success: expected pid 42 despite a later unrelated failure before observer delivery'
    ).toBe(42);
  });

  it('keeps a successful response whose timestamp ties the previous error', async () => {
    const { result, gate, pending } = await startGatedAction();
    await act(async () => {
      gate.release(503, { error: 'first failure' });
      await pending;
    });
    const recovery = new GatedMachineStatusFetch();
    gates.push(recovery);
    scenario.fetchMock.mockImplementation(recovery.fetch);
    await act(async () => {
      const refetch = result.current.refetch();
      await recovery.started;
      recovery.release(200, STATUS);
      await refetch;
    });
    const state = result.current.queryClient.getQueryState(['machine', 'status']);
    expect(state?.status).toBe('success');
    expect(state?.errorUpdatedAt).toBe(state?.dataUpdatedAt);
    await advanceTimersByTimeAsync(40);
    expect(
      result.current.data?.hub.pid,
      'latest cache status success: expected pid 42 when error and data timestamps tie'
    ).toBe(42);
  });
});
