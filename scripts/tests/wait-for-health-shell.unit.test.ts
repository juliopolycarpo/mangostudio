import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { FakeHealthEndpoint } from './support/fake-health-endpoint';
import { FixtureCommands } from './support/fixture-command';

const helper = join(import.meta.dir, '../release/wait-for-health.sh');
const commands = new FixtureCommands(undefined, 8_000);
const shellTest = test.skipIf(process.platform === 'win32');

afterEach(async () => {
  await commands.settle();
});

describe('scripts/release/wait-for-health.sh', () => {
  shellTest.each(['no-headers', 'streaming-json-ready'] as const)(
    'bounds %s curl I/O and closes its connection',
    async (behavior) => {
      const endpoint = new FakeHealthEndpoint(behavior);
      const url = await endpoint.listen();
      const pending = runHealth(url, ':', '1');
      try {
        const observed = await observeWithin(pending, 1_600);
        expect(endpoint.requests, 'expected curl to reach the owned health endpoint').toBe(1);
        expect(
          observed === 'pending' ? observed : observed.exitCode,
          `expected shell readiness to exit 1 within 1600ms for a 1s budget | received: ${JSON.stringify(observed)}`
        ).toBe(1);
        await endpoint.waitForNoSockets();
      } finally {
        await endpoint.stop();
        await pending;
      }
    },
    8_000
  );

  shellTest(
    'bounds a later stalled curl to the shared budget plus one clock tick',
    async () => {
      const endpoint = new FakeHealthEndpoint('delayed-unavailable-then-no-headers');
      const url = await endpoint.listen();
      const pending = runHealth(url, ':', '3', undefined, true);
      try {
        // Exclude clock alignment from the request budget.
        const startDeadline = performance.now() + 2_000;
        while (endpoint.requests === 0 && performance.now() < startDeadline) await Bun.sleep(5);
        expect(endpoint.requests, 'expected the first health request within 2000ms').toBe(1);
        // Three nominal seconds, one quantization tick, and 500ms scheduler slack.
        const observed = await observeWithin(pending, 4_500);
        expect(endpoint.requests, 'expected delayed503 followed by a real stalled request').toBe(2);
        expect(
          observed === 'pending' ? observed : observed.exitCode,
          `expected exit1 within budget + clock tick + scheduler slack | received: ${JSON.stringify(observed)}`
        ).toBe(1);
        await endpoint.waitForNoSockets();
      } finally {
        await endpoint.stop();
        await pending;
      }
    },
    9_000
  );

  shellTest(
    'rejects a complete healthy response received after the integer deadline',
    async () => {
      const endpoint = new FakeHealthEndpoint('delayed-unavailable-then-late-ready');
      const url = await endpoint.listen();
      // Start just after a shell tick so the late200 completes after the
      // integer deadline while the already-started curl still has time left.
      const pending = runHealth(url, ':', '3', undefined, true);
      try {
        const observed = await pending;
        expect(endpoint.requests).toBe(2);
        expect(endpoint.responses, 'expected both503 and late200 response bodies to finish').toBe(
          2
        );
        expect(
          observed.exitCode,
          `expected late healthy response rejected with exit1 | received: ${JSON.stringify(observed)}`
        ).toBe(1);
        await endpoint.waitForNoSockets();
      } finally {
        await endpoint.stop();
        await pending;
      }
    },
    9_000
  );

  shellTest(
    'includes a delayed unsuccessful request and final polling in the same budget',
    async () => {
      const endpoint = new FakeHealthEndpoint('delayed-unavailable');
      const url = await endpoint.listen();
      const pending = runHealth(url, ':', '2');
      try {
        const observed = await observeWithin(pending, 2_600);
        expect(
          endpoint.requests,
          'expected curl to reach the owned health endpoint'
        ).toBeGreaterThan(0);
        expect(
          observed === 'pending' ? observed : observed.exitCode,
          `expected shell readiness to exit 1 within 2600ms for a 2s budget | received: ${JSON.stringify(observed)}`
        ).toBe(1);
        expect(endpoint.requests, 'expected one bounded request before the deadline').toBe(1);
        await endpoint.waitForNoSockets();
      } finally {
        await endpoint.stop();
        await pending;
      }
    },
    8_000
  );

  shellTest.each([
    { behavior: 'ready' as const, retries: '03', override: undefined, exitCode: 0, requests: 1 },
    {
      behavior: 'ready' as const,
      retries: '2147483647',
      override: undefined,
      exitCode: 0,
      requests: 1,
    },
    {
      behavior: 'eventually-ready' as const,
      retries: '1',
      override: '3',
      exitCode: 0,
      requests: 2,
    },
    { behavior: 'unavailable' as const, retries: '3', override: '1', exitCode: 1, requests: 1 },
  ])(
    'preserves $behavior polling with retries=$retries and HEALTH_RETRIES=$override',
    async ({ behavior, retries, override, exitCode, requests }) => {
      const endpoint = new FakeHealthEndpoint(behavior);
      const url = await endpoint.listen();
      try {
        const result = await runHealth(url, ':', retries, override);
        expect(result.exitCode, result.stderr).toBe(exitCode);
        expect(endpoint.requests).toBe(requests);
        await endpoint.waitForNoSockets();
      } finally {
        await endpoint.stop();
      }
    }
  );

  shellTest.each([
    { label: 'before the first request', aliveCheck: 'false', requests: 0 },
    { label: 'between unsuccessful polls', aliveCheck: '((SECONDS < 1))', requests: 1 },
  ])('returns 2 when alive_check fails $label', async ({ aliveCheck, requests }) => {
    const endpoint = new FakeHealthEndpoint('unavailable');
    const url = await endpoint.listen();
    try {
      const result = await runHealth(url, aliveCheck, '3');
      expect(result.exitCode, result.stderr).toBe(2);
      expect(endpoint.requests).toBe(requests);
      await endpoint.waitForNoSockets();
    } finally {
      await endpoint.stop();
    }
  });

  shellTest('does not start curl after alive_check consumes the remaining budget', async () => {
    const endpoint = new FakeHealthEndpoint('ready');
    const url = await endpoint.listen();
    try {
      const result = await runHealth(url, 'sleep 1', '1');
      expect(result.exitCode, result.stderr).toBe(1);
      expect(endpoint.requests).toBe(0);
    } finally {
      await endpoint.stop();
    }
  });

  shellTest.each(['0', '-1', '1.5', 'two', '1+1', '2147483648', '999999999999999999999999'])(
    'rejects retries=%s before arithmetic or transport',
    async (retries) => {
      const endpoint = new FakeHealthEndpoint('ready');
      const url = await endpoint.listen();
      try {
        const result = await runHealth(url, ':', retries);
        expect(result.exitCode, result.stderr).toBe(2);
        expect(result.stderr).toContain(
          `expected retries: integer in 1..2147483647 | received: ${retries}`
        );
        expect(endpoint.requests).toBe(0);
      } finally {
        await endpoint.stop();
      }
    }
  );

  shellTest('preserves caller options and an existing function when sourced twice', async () => {
    const result = await commands.run(
      [
        'bash',
        '-c',
        'set -u; set +e; before="$-:$SHELLOPTS"; wait_for_health() { return 7; }; source "$1"; source "$1"; [ "$-:$SHELLOPTS" = "$before" ] || exit 99; wait_for_health',
        '--',
        helper,
      ],
      process.cwd()
    );
    expect(result.exitCode, result.stderr).toBe(7);
  });
});

function runHealth(
  url: string,
  aliveCheck: string,
  retries: string,
  override?: string,
  alignClock = false
) {
  const alignment = alignClock
    ? 'clock=$SECONDS; while [ "$SECONDS" -eq "$clock" ]; do sleep 0.01; done; '
    : '';
  return commands.run(
    [
      'bash',
      '-c',
      `set -euo pipefail; source "$1"; ${alignment}wait_for_health "$2" "$3" "$4"`,
      '--',
      helper,
      new URL(url).port,
      aliveCheck,
      retries,
    ],
    process.cwd(),
    { ...process.env, HEALTH_RETRIES: override, NO_PROXY: 'localhost,127.0.0.1' }
  );
}

async function observeWithin<T>(pending: Promise<T>, budgetMs: number): Promise<T | 'pending'> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<'pending'>((resolve) => {
        timeout = setTimeout(() => resolve('pending'), budgetMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
