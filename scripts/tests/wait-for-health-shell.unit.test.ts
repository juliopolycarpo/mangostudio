import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeHealthEndpoint } from './support/fake-health-endpoint';
import { FixtureCommands } from './support/fixture-command';

const helper = join(import.meta.dir, '../release/wait-for-health.sh');
const delayedShellStartup = join(import.meta.dir, 'support/delay-health-shell-startup.bash');
const lateResponseClock = join(
  import.meta.dir,
  'support/advance-health-clock-after-ready-response.bash'
);
const commands = new FixtureCommands(undefined, 8_000);
// Allow 7s for alignment, 2s for admission, 4.5s for transport, and time to settle.
const delayedStartupCommands = new FixtureCommands(undefined, 15_000);
const shellTest = test.skipIf(process.platform === 'win32');
// Check liveness by poll order, independent of the shell clock's starting phase.
const firstPollAliveCheck =
  // eslint-disable-next-line no-template-curly-in-string -- Bash expands this literal fixture expression in the child shell.
  'health_alive_checks=${health_alive_checks:-0}; ((health_alive_checks += 1)); ((health_alive_checks < 2))';

afterEach(async () => {
  await Promise.all([commands.settle(), delayedStartupCommands.settle()]);
});

describe('scripts/release/wait-for-health.sh', () => {
  shellTest.each(['no-headers', 'streaming-json-ready'] as const)(
    'bounds %s curl I/O and closes its connection',
    async (behavior) => {
      const endpoint = new FakeHealthEndpoint(behavior);
      await withAlignedHealthFixture(endpoint, '1', async (pending) => {
        const observed = await observeWithin(pending, 1_600);
        expect(endpoint.requests, 'expected curl to reach the owned health endpoint').toBe(1);
        expect(
          observed === 'pending' ? observed : observed.exitCode,
          `expected shell readiness to exit 1 within 1600ms for a 1s budget | received: ${JSON.stringify(observed)}`
        ).toBe(1);
        await endpoint.waitForNoSockets();
      });
    },
    8_000
  );

  shellTest(
    'bounds a later stalled curl to the shared budget plus one clock tick',
    async () => {
      const endpoint = new FakeHealthEndpoint('delayed-unavailable-then-no-headers');
      await withAlignedHealthFixture(
        endpoint,
        '3',
        async (pending) => {
          // Three nominal seconds, one quantization tick, and 500ms scheduler slack.
          const observed = await observeWithin(pending, 4_500);
          expect(endpoint.requests, 'expected delayed503 followed by a real stalled request').toBe(
            2
          );
          expect(
            observed === 'pending' ? observed : observed.exitCode,
            `expected exit1 within budget + clock tick + scheduler slack | received: ${JSON.stringify(observed)}`
          ).toBe(1);
          await endpoint.waitForNoSockets();
        },
        {
          bashEnvironment: delayedShellStartup,
          alignmentBudgetMs: 7_000,
          commandOwner: delayedStartupCommands,
        }
      );
    },
    22_000
  );

  shellTest(
    'rejects a complete healthy response received after the integer deadline',
    async () => {
      const fixture = await mkdtemp(join(tmpdir(), 'mango-health-response-'));
      try {
        const endpoint = new FakeHealthEndpoint('eventually-ready');
        const url = await endpoint.listen();
        const responseMarker = join(fixture, 'response-complete');
        try {
          const observed = await runHealth(url, ':', '3', {
            bashEnvironment: lateResponseClock,
            responseMarker,
          });
          expect(endpoint.requests, 'expected a 503 request and a later ready request').toBe(2);
          expect(endpoint.responses, 'expected both response bodies to finish').toBe(2);
          expect(
            existsSync(responseMarker),
            'expected curl to receive the complete ready body'
          ).toBe(true);
          expect(
            observed.exitCode,
            `expected late healthy response rejected with exit1 | received: ${JSON.stringify(observed)}`
          ).toBe(1);
          await endpoint.waitForNoSockets();
        } finally {
          await endpoint.stop();
        }
      } finally {
        await rm(fixture, { recursive: true, force: true });
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
        const result = await runHealth(url, ':', retries, { overrideRetries: override });
        expect(result.exitCode, result.stderr).toBe(exitCode);
        expect(endpoint.requests).toBe(requests);
        await endpoint.waitForNoSockets();
      } finally {
        await endpoint.stop();
      }
    }
  );

  shellTest.each([
    {
      label: 'before the first request',
      aliveCheck: 'false',
      requests: 0,
      initialSeconds: undefined,
    },
    {
      label: 'between unsuccessful polls',
      aliveCheck: firstPollAliveCheck,
      requests: 1,
      initialSeconds: undefined,
    },
    {
      label: 'between unsuccessful polls after a clock tick',
      aliveCheck: firstPollAliveCheck,
      requests: 1,
      initialSeconds: 1,
    },
  ])(
    'returns 2 when alive_check fails $label',
    async ({ aliveCheck, requests, initialSeconds }) => {
      const endpoint = new FakeHealthEndpoint('unavailable');
      const url = await endpoint.listen();
      try {
        const result = await runHealth(url, aliveCheck, '3', { initialSeconds });
        expect(result.exitCode, result.stderr).toBe(2);
        expect(endpoint.requests).toBe(requests);
        await endpoint.waitForNoSockets();
      } finally {
        await endpoint.stop();
      }
    }
  );

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

interface HealthShellOptions {
  readonly alignClock?: boolean;
  readonly alignedClockMarker?: string;
  readonly initialSeconds?: number;
  readonly overrideRetries?: string;
  readonly bashEnvironment?: string;
  readonly commandOwner?: FixtureCommands;
  readonly responseMarker?: string;
}

async function withAlignedHealthFixture(
  endpoint: FakeHealthEndpoint,
  retries: string,
  verify: (pending: ReturnType<typeof runHealth>) => Promise<void>,
  {
    alignmentBudgetMs = 4_000,
    bashEnvironment,
    commandOwner,
  }: {
    readonly alignmentBudgetMs?: number;
    readonly bashEnvironment?: string;
    readonly commandOwner?: FixtureCommands;
  } = {}
): Promise<void> {
  const fixture = await mkdtemp(join(tmpdir(), 'mango-health-clock-'));
  const alignedClockMarker = join(fixture, 'clock-aligned');
  try {
    const url = await endpoint.listen();
    const pending = runHealth(url, ':', retries, {
      alignClock: true,
      bashEnvironment,
      commandOwner,
      alignedClockMarker,
    });
    try {
      // Bound clock setup separately from the first request and transport.
      const alignmentDeadline = performance.now() + alignmentBudgetMs;
      while (!existsSync(alignedClockMarker) && performance.now() < alignmentDeadline) {
        await Bun.sleep(5);
      }
      expect(
        existsSync(alignedClockMarker),
        `expected the shell clock to align within ${alignmentBudgetMs}ms`
      ).toBe(true);
      const startDeadline = performance.now() + 2_000;
      while (endpoint.requests === 0 && performance.now() < startDeadline) await Bun.sleep(5);
      expect(endpoint.requests, 'expected the first health request within 2000ms').toBe(1);
      await verify(pending);
    } finally {
      try {
        await endpoint.stop();
      } finally {
        await pending;
      }
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

function runHealth(
  url: string,
  aliveCheck: string,
  retries: string,
  {
    alignClock,
    alignedClockMarker,
    initialSeconds,
    overrideRetries,
    bashEnvironment,
    commandOwner = commands,
    responseMarker,
  }: HealthShellOptions = {}
) {
  const clockStart = initialSeconds === undefined ? '' : `SECONDS=${initialSeconds}; `;
  const alignment = alignClock
    ? 'clock=$SECONDS; while [ "$SECONDS" -eq "$clock" ]; do sleep 0.01; done; '
    : '';
  const markAlignedClock = alignedClockMarker ? ': > "$5"; ' : '';
  return commandOwner.run(
    [
      'bash',
      '-c',
      `set -euo pipefail; source "$1"; ${clockStart}${alignment}${markAlignedClock}wait_for_health "$2" "$3" "$4"`,
      '--',
      helper,
      new URL(url).port,
      aliveCheck,
      retries,
      alignedClockMarker ?? '',
    ],
    process.cwd(),
    {
      ...process.env,
      ...(bashEnvironment ? { BASH_ENV: bashEnvironment } : {}),
      HEALTH_RETRIES: overrideRetries,
      MANGO_TEST_HEALTH_READY_MARKER: responseMarker,
      NO_PROXY: 'localhost,127.0.0.1',
    }
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
