import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFAULT_READY_BUDGET_MS,
  POLL_INTERVAL_MS,
  resolveReadyBudgetMs,
  WIN32_READY_BUDGET_MS,
  waitForServerReady,
} from '../lib/wait-for-health';

function stubProcessPlatform(platform: NodeJS.Platform): () => void {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  return () => {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  };
}

describe('scripts/lib/wait-for-health', () => {
  describe('budget constants', () => {
    test('default budget matches scripts/release/wait-for-health.sh default retries × 1s sleep', () => {
      const shellPath = join(import.meta.dir, '../release/wait-for-health.sh');
      const shell = readFileSync(shellPath, 'utf8');
      const retriesMatch = shell.match(/local retries="\$\{HEALTH_RETRIES:-\$\{3:-(\d+)\}\}"/);
      if (!retriesMatch) {
        throw new Error(`Could not parse default retries from ${shellPath}`);
      }
      const defaultRetries = Number(retriesMatch[1]);
      expect(shell).toMatch(/sleep 1/);
      expect(DEFAULT_READY_BUDGET_MS).toBe(defaultRetries * 1000);
    });

    test('default budget matches scripts/release/wait-for-health.sh (30 × 1s = 30s)', () => {
      expect(DEFAULT_READY_BUDGET_MS).toBe(30_000);
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

    test.each([
      'linux',
      'darwin',
    ] as const)('returns the shared default budget on %s', (platform) => {
      restorePlatform = stubProcessPlatform(platform);
      expect(resolveReadyBudgetMs()).toBe(DEFAULT_READY_BUDGET_MS);
    });
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
});
