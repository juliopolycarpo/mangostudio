import { describe, expect, it } from 'bun:test';

import {
  awaitStartToken,
  decodeStartToken,
  type StartTokenContext,
  startTokenProblem,
} from '../lib/binary-smoke-start-token';

/** 2023-11-14T22:13:20Z. */
const NOW_MS = 1_700_000_000_000;

/** .NET ticks at the Unix epoch plus `ms` milliseconds. */
function dotNetTicksAt(ms: number): string {
  return String(621_355_968_000_000_000n + BigInt(ms) * 10_000n);
}

function context(platform: NodeJS.Platform, uptimeSeconds = 0): StartTokenContext {
  return { platform, nowMs: NOW_MS, uptimeSeconds };
}

const WINDOW = { spawnedAtMs: NOW_MS - 2_000, toleranceMs: 5_000 };

describe('decodeStartToken', () => {
  it('reads Windows .NET ticks as the UTC instant they name', () => {
    expect(decodeStartToken(dotNetTicksAt(NOW_MS - 1_234), context('win32'))).toBe(NOW_MS - 1_234);
  });

  it('reads a Linux token as system uptime minus the start tick', () => {
    // Up 1000 s, started at tick 99_000 (990 s): ten seconds old.
    expect(
      decodeStartToken('3f2a9c10-1111-2222-3333-444455556666:99000', context('linux', 1000))
    ).toBe(NOW_MS - 10_000);
  });

  it('reads a macOS lstart token, padded day included, as UTC', () => {
    expect(decodeStartToken('Tue Nov 14 22:13:20 2023', context('darwin'))).toBe(NOW_MS);
    expect(decodeStartToken('Wed Nov  1 00:00:00 2023', context('darwin'))).toBe(
      Date.UTC(2023, 10, 1)
    );
  });

  it.each([
    ['win32', ''],
    ['win32', 'not-ticks'],
    ['win32', '12345'],
    ['linux', '99000'],
    ['linux', 'boot-id-with-no-ticks:'],
    ['darwin', 'garbage'],
    ['darwin', '09:15'],
  ] as const)('is undefined for %s token %p', (platform, token) => {
    expect(decodeStartToken(token, context(platform))).toBeUndefined();
  });
});

describe('startTokenProblem', () => {
  it('accepts a token that decodes to a start inside the window', () => {
    expect(
      startTokenProblem(dotNetTicksAt(NOW_MS - 500), context('win32'), WINDOW)
    ).toBeUndefined();
  });

  it('accepts a start a little before the spawn, within the tolerance', () => {
    expect(
      startTokenProblem(dotNetTicksAt(WINDOW.spawnedAtMs - 4_000), context('win32'), WINDOW)
    ).toBeUndefined();
  });

  it.each([undefined, '', null, 42])(
    'names the field and the value for a missing or non-string token %p',
    (token) => {
      const problem = startTokenProblem(token, context('win32'), WINDOW);

      expect(problem).toContain('state file startToken: expected a non-empty string');
      expect(problem).toContain(`received: ${JSON.stringify(token) ?? 'undefined'}`);
    }
  );

  it('names the value for a token that does not have the platform shape', () => {
    expect(startTokenProblem('boot:123', context('win32'), WINDOW)).toBe(
      'state file startToken: expected the win32 token shape | received: "boot:123"'
    );
  });

  it('names the value and both bounds for a start outside the window', () => {
    const stale = dotNetTicksAt(NOW_MS - 3_600_000);
    const problem = startTokenProblem(stale, context('win32'), WINDOW);

    expect(problem).toContain(
      `startToken "${stale}" decodes to a start of 2023-11-14T21:13:20.000Z`
    );
    expect(problem).toContain(
      'expected between 2023-11-14T22:13:13.000Z and 2023-11-14T22:13:25.000Z'
    );
  });

  it('rejects a start after now, as a token read from a clock that ran ahead', () => {
    expect(startTokenProblem(dotNetTicksAt(NOW_MS + 60_000), context('win32'), WINDOW)).toContain(
      'decodes to a start of'
    );
  });
});

describe('awaitStartToken', () => {
  /** A state file that serves `texts` in order (the last one repeats), with a fake clock. */
  class FakeStateFile {
    reads = 0;
    clock = 0;
    sleeps: number[] = [];
    constructor(private readonly texts: ReadonlyArray<string | undefined>) {}
    readStateText = (): Promise<string | undefined> => {
      const text = this.texts[Math.min(this.reads, this.texts.length - 1)];
      this.reads += 1;
      return Promise.resolve(text);
    };
    sleep = (ms: number): Promise<void> => {
      this.sleeps.push(ms);
      this.clock += ms;
      return Promise.resolve();
    };
    now = () => this.clock;
  }

  const options = (file: FakeStateFile, budgetMs = 1_000) => ({
    readStateText: file.readStateText,
    sleep: file.sleep,
    now: file.now,
    budgetMs,
    intervalMs: 100,
  });

  it('waits through a file with no token yet, as Windows writes it', async () => {
    const file = new FakeStateFile([undefined, '{"pid":4}', '{"pid":4,"startToken":"abc"}']);

    expect(await awaitStartToken(options(file))).toBe('abc');
    expect(file.reads).toBe(3);
    expect(file.sleeps).toEqual([100, 100]);
  });

  it('returns at once when the token is already there', async () => {
    const file = new FakeStateFile(['{"startToken":"abc"}']);

    expect(await awaitStartToken(options(file))).toBe('abc');
    expect(file.sleeps).toEqual([]);
  });

  it('gives back undefined once the budget passes with no token', async () => {
    const file = new FakeStateFile(['{"pid":4}']);

    expect(await awaitStartToken(options(file, 300))).toBeUndefined();
    expect(file.clock).toBe(300);
  });

  it('gives back an empty or non-string token as read after the budget, so the caller can name it', async () => {
    expect(await awaitStartToken(options(new FakeStateFile(['{"startToken":""}']), 200))).toBe('');
    expect(await awaitStartToken(options(new FakeStateFile(['{"startToken":7}']), 200))).toBe(7);
  });

  it.each(['not json', 'null', '[]'])('treats state text %p as having no token', async (text) => {
    expect(await awaitStartToken(options(new FakeStateFile([text]), 200))).toBeUndefined();
  });
});
