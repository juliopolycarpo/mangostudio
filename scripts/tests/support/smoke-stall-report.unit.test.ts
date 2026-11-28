import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ROOT_DIR } from '../../lib/config';
import { readText } from './read-text';
import {
  classifySmokeStage,
  describePortHolder,
  describeSmokeStall,
  readTimedText,
  type SmokeEvent,
  type SmokeStage,
  type SmokeStallEvidence,
} from './smoke-stall-report';

const scratchRoots: string[] = [];

afterEach(() => {
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const boot: SmokeEvent = { event: 'boot', pid: 7, at: 1_000 };
const startup: SmokeEvent = { event: 'startup', pid: 7, at: 1_010 };

describe('classifySmokeStage', () => {
  test.each([
    ['no output and no events', '', [], 'script-printed-nothing'],
    [
      'the smoke banner only',
      '\n🚀 Starting binary on port 1\n',
      [],
      'smoke-started-hub-not-spawned',
    ],
    [
      'the readiness wait without a boot event',
      'Starting binary on port 1\n   Waiting for server to be ready...\n',
      [],
      'hub-spawned-never-booted',
    ],
    ['a boot event only', 'Waiting for server to be ready', [boot], 'hub-booted-never-listened'],
    [
      'a bind failure',
      'Waiting for server to be ready',
      [boot, { event: 'bind-failed', pid: 7, detail: 'EADDRINUSE' }],
      'hub-booted-bind-failed',
    ],
    ['a startup event', 'Waiting for server to be ready', [boot, startup], 'hub-listening'],
  ] satisfies [string, string, SmokeEvent[], SmokeStage][])(
    'names the stage after %s',
    (_label, stdout, events, expected) => {
      expect(classifySmokeStage(stdout, events)).toBe(expected);
    }
  );
});

describe('the lines the stage classifier reads', () => {
  test('scripts/test-build.ts still prints the banner and the readiness wait in that order', () => {
    const source = readText('scripts/test-build.ts');
    const banner = source.indexOf('Starting binary on port');
    const wait = source.indexOf('Waiting for server to be ready');
    expect(
      banner,
      "expected scripts/test-build.ts to print 'Starting binary on port'"
    ).toBeGreaterThan(-1);
    expect(
      wait,
      "expected scripts/test-build.ts to print 'Waiting for server to be ready' after the banner"
    ).toBeGreaterThan(banner);
  });
});

describe('describeSmokeStall', () => {
  const evidence: SmokeStallEvidence = {
    code: null,
    signal: 'SIGTERM',
    elapsedMs: 10_014.4,
    firstOutputMs: null,
    stdout: '',
    stderr: '',
    events: [],
    port: 43123,
    portState: 'free now',
    load: [1.5, 0.75, 0.5],
  };

  test('names the stage, the timings, the port and the load for a silent script', () => {
    const report = describeSmokeStall(evidence);
    expect(report).toContain(
      "expected the fake hub to record 'startup' before the script exited | received stage: script-printed-nothing"
    );
    expect(report).toContain('exit null, signal SIGTERM, after 10014ms; no output');
    expect(report).toContain('events: no events');
    expect(report).toContain('port 43123: free now');
    expect(report).toContain('loadavg: 1.50 0.75 0.50');
    expect(report).toContain('stdout: (empty)');
    expect(report).toContain('stderr: (empty)');
  });

  test('lists the events with their times and the bind failure detail', () => {
    const report = describeSmokeStall({
      ...evidence,
      firstOutputMs: 840,
      stdout: 'Starting binary on port 43123\nWaiting for server to be ready...\n',
      events: [boot, { event: 'bind-failed', pid: 7, at: 1_005, detail: 'EADDRINUSE' }],
      portState: 'not bindable now (EADDRINUSE); listeners: LISTEN 0 512 127.0.0.1:43123',
    });
    expect(report).toContain('received stage: hub-booted-bind-failed');
    expect(report).toContain('first output at 840ms');
    expect(report).toContain('events: boot@1000, bind-failed@1005 (EADDRINUSE)');
    expect(report).toContain('listeners: LISTEN 0 512 127.0.0.1:43123');
  });
});

describe('readTimedText', () => {
  test('returns the text and when the first chunk arrived', async () => {
    const stream = new Response('hello').body as ReadableStream<Uint8Array>;
    const timed = await readTimedText(stream, performance.now() - 50);
    expect(timed.text).toBe('hello');
    expect(timed.firstChunkMs).toBeGreaterThanOrEqual(50);
  });

  test('reports an empty stream as no first chunk', async () => {
    const stream = new Response('').body as ReadableStream<Uint8Array>;
    expect(await readTimedText(stream, performance.now())).toEqual({
      text: '',
      firstChunkMs: null,
    });
  });
});

describe('describePortHolder', () => {
  test('reports a bound loopback port as not bindable', () => {
    const holder = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
    try {
      expect(describePortHolder(holder.port as number)).toStartWith('not bindable now (');
    } finally {
      void holder.stop(true);
    }
  });

  test('reports a released loopback port as free', async () => {
    const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
    const port = reservation.port as number;
    await reservation.stop(true);
    expect(describePortHolder(port)).toBe('free now');
  });
});

describe('fake build smoke hub events', () => {
  async function runFakeHub(port: number): Promise<{ code: number | null; events: SmokeEvent[] }> {
    const root = mkdtempSync(join(tmpdir(), 'mango-fake-hub-events-'));
    scratchRoots.push(root);
    const eventsPath = join(root, 'events.jsonl');
    const hub = Bun.spawn(
      [
        process.execPath,
        join(ROOT_DIR, 'scripts/tests/support/fake-build-smoke-server.ts'),
        'serve',
      ],
      {
        env: { ...process.env, API_PORT: String(port), FAKE_BUILD_SMOKE_EVENTS: eventsPath },
        stdout: 'ignore',
        stderr: 'pipe',
        timeout: 10_000,
      }
    );
    // The fake exits by itself only when it cannot bind; a listening fake is stopped here.
    const settled = await Promise.race([hub.exited, Bun.sleep(1_500).then(() => 'listening')]);
    if (settled === 'listening') hub.kill('SIGTERM');
    const code = await hub.exited;
    const events = readFileSync(eventsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as SmokeEvent);
    return { code, events };
  }

  test.skipIf(process.platform === 'win32')(
    'records boot before startup when the port is free',
    async () => {
      const reservation = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: () => new Response(),
      });
      const port = reservation.port as number;
      await reservation.stop(true);
      const { events } = await runFakeHub(port);
      expect(events.map(({ event }) => event)).toEqual(['boot', 'startup', 'sigterm', 'exit']);
    },
    15_000
  );

  test.skipIf(process.platform === 'win32')(
    'records the bind failure and exits 4 when another process holds the port',
    async () => {
      const holder = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
      try {
        const { code, events } = await runFakeHub(holder.port as number);
        expect(code, 'expected the fake hub to exit 4 after a bind failure').toBe(4);
        expect(events.map(({ event }) => event)).toEqual(['boot', 'bind-failed']);
        expect(events[1]?.detail, 'expected the bind failure to carry the listener error').toMatch(
          /in use|EADDRINUSE/i
        );
      } finally {
        void holder.stop(true);
      }
    },
    15_000
  );
});
