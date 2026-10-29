import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFAULT_READY_BUDGET_MS,
  POLL_INTERVAL_MS,
  resolveReadyBudgetMs,
  waitForServerReady,
  WIN32_READY_BUDGET_MS,
} from '../lib/wait-for-health';
import { erroredHealthResponse, FakeHealthEndpoint } from './support/fake-health-endpoint';
import { stubProcessPlatform } from './support/process-platform';

describe('scripts/lib/wait-for-health', () => {
  describe('budget constants', () => {
    test('default budget matches scripts/release/wait-for-health.sh nominal total seconds', () => {
      const shellPath = join(import.meta.dir, '../release/wait-for-health.sh');
      const shell = readFileSync(shellPath, 'utf8');
      const retriesMatch = shell.match(/local retries="\$\{HEALTH_RETRIES:-\$\{3:-(\d+)\}\}"/);
      if (!retriesMatch) {
        throw new Error(`Could not parse default retries from ${shellPath}`);
      }
      const defaultRetries = Number(retriesMatch[1]);
      // Retry sleeps keep their one-second cadence inside the total budget.
      // Anchored: a bare /sleep 1/ would also accept `sleep 10`.
      expect(shell).toMatch(/^\s*sleep 1$/m);
      expect(defaultRetries).toBe(30);
      expect(DEFAULT_READY_BUDGET_MS).toBe(defaultRetries * 1000);
    });

    test('Windows budget gives GitHub runners extra headroom for cold starts', () => {
      expect(WIN32_READY_BUDGET_MS).toBeGreaterThanOrEqual(DEFAULT_READY_BUDGET_MS);
      expect(WIN32_READY_BUDGET_MS).toBeGreaterThanOrEqual(45_000);
    });

    test('default budget is bounded but generous — do not "optimize" it back below 20s', () => {
      // Regression guard for issue #377: the previous 15 × 500ms = 7.5s budget
      // caused `Binary windows-x64` to flake on healthy cold starts. If a future
      // change shrinks this, the Windows GitHub runner will flake again.
      expect(DEFAULT_READY_BUDGET_MS).toBeGreaterThanOrEqual(20_000);
    });

    test('Windows budget is bounded — must still fail reasonably fast on a dead server', () => {
      expect(WIN32_READY_BUDGET_MS).toBeLessThanOrEqual(2 * 60_000);
    });
  });

  describe('resolveReadyBudgetMs', () => {
    let restorePlatform: (() => void) | undefined;

    afterEach(() => {
      restorePlatform?.();
      restorePlatform = undefined;
    });

    test('returns the Windows budget on win32', () => {
      restorePlatform = stubProcessPlatform('win32');
      expect(resolveReadyBudgetMs()).toBe(WIN32_READY_BUDGET_MS);
    });

    test.each(['linux', 'darwin'] as const)(
      'returns the shared default budget on %s',
      (platform) => {
        restorePlatform = stubProcessPlatform(platform);
        expect(resolveReadyBudgetMs()).toBe(DEFAULT_READY_BUDGET_MS);
      }
    );
  });

  describe('waitForServerReady', () => {
    let fetchSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      fetchSpy = spyOn(globalThis, 'fetch');
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    test('returns as soon as the server responds 2xx without retrying', async () => {
      fetchSpy.mockResolvedValue(new Response('{"status":"ok"}', { status: 200 }));

      await expect(
        waitForServerReady('http://localhost:1/api/health', {
          budgetMs: 1_000,
          intervalMs: 100,
        })
      ).resolves.toBeUndefined();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    test('accepts 2xx headers when the response body has already errored', async () => {
      const response = erroredHealthResponse(200);
      await expect(response.body?.cancel()).rejects.toThrow('health body failed after headers');
      fetchSpy.mockResolvedValue(response);

      await expect(
        waitForServerReady('http://localhost:1/api/health', { budgetMs: 80, intervalMs: 10 })
      ).resolves.toBeUndefined();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    test('retries non-2xx headers when the response body has already errored', async () => {
      fetchSpy
        .mockResolvedValueOnce(erroredHealthResponse(503))
        .mockResolvedValueOnce(new Response('ready', { status: 200 }));

      await waitForServerReady('http://localhost:1/api/health', {
        budgetMs: 1_000,
        intervalMs: 10,
      });

      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    test('retries through non-2xx responses until the server reports 2xx', async () => {
      fetchSpy
        .mockResolvedValueOnce(new Response('not ready', { status: 503 }))
        .mockResolvedValueOnce(new Response('still booting', { status: 500 }))
        .mockResolvedValueOnce(new Response('{"status":"ok"}', { status: 200 }));

      await waitForServerReady('http://localhost:1/api/health', {
        budgetMs: 1_000,
        intervalMs: 10,
      });

      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    test('retries through connection errors until the server reports 2xx', async () => {
      fetchSpy
        .mockRejectedValueOnce(new Error('ECONNREFUSED 127.0.0.1:1'))
        .mockResolvedValueOnce(new Response('{"status":"ok"}', { status: 200 }));

      await waitForServerReady('http://localhost:1/api/health', {
        budgetMs: 1_000,
        intervalMs: 10,
      });

      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    test('throws with the URL and elapsed budget when the server never becomes ready', async () => {
      fetchSpy.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:1'));
      const startedAt = Date.now();

      await expect(
        waitForServerReady('http://localhost:1/api/health', {
          budgetMs: 200,
          intervalMs: 50,
        })
      ).rejects.toThrow(/http:\/\/localhost:1\/api\/health.*within 200ms/);

      // Sanity: a dead server must not loop forever; allow generous slack for
      // the polling interval plus a bit of scheduler jitter.
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    });

    test('exposes POLL_INTERVAL_MS so callers can reason about probe cadence', () => {
      // 500ms keeps the TS probe cadence roughly comparable to the bash
      // helper's 1s cadence while still being responsive.
      expect(POLL_INTERVAL_MS).toBe(500);
    });
  });

  describe('real transport deadlines', () => {
    test.each([
      { behavior: 'no-headers' as const, intervalMs: 10, label: 'a request without headers' },
      { behavior: 'unavailable' as const, intervalMs: 1_500, label: 'the final poll interval' },
    ])(
      'bounds $label to the total budget',
      async ({ behavior, intervalMs }) => {
        const endpoint = new FakeHealthEndpoint(behavior);
        const url = await endpoint.listen();
        const pending = waitForServerReady(url, { budgetMs: 80, intervalMs }).then(
          () => 'unexpected-ready',
          (error: unknown) => (error instanceof Error ? error.message : String(error))
        );
        try {
          const observed = await settleBefore(pending, 300);
          expect(
            endpoint.requests,
            'expected the health request to reach the owned endpoint'
          ).toBeGreaterThan(0);
          expect(
            observed,
            `expected readiness to settle within 300ms for an 80ms budget | received: ${observed}`
          ).toBe(`Server never became ready at ${url} within 80ms`);
          if (behavior === 'no-headers') await endpoint.waitForNoSockets();
        } finally {
          await endpoint.stop();
          await pending;
        }
      },
      4_000
    );

    test('releases an unconsumed successful response body before returning', async () => {
      const endpoint = new FakeHealthEndpoint('streaming-ready');
      const url = await endpoint.listen();
      try {
        await waitForServerReady(url, { budgetMs: 1_000 });
        await endpoint.waitForNoSockets();
      } finally {
        await endpoint.stop();
      }
    });
  });
});

async function settleBefore(pending: Promise<string>, budgetMs: number): Promise<string> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<string>((resolve) => {
        timeout = setTimeout(() => resolve('still pending'), budgetMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
