import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyStateProcess,
  isStateLive,
  readLiveState,
  readState,
  removeState,
  type ServerState,
  START_TIME_TOLERANCE_MS,
  writeState,
} from '../../../src/lib/server-state';

function makeState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    pid: 4242,
    port: 3001,
    host: 'localhost',
    startedAt: 1_700_000_000_000,
    logFile: '/home/user/.mango/logs/server.log',
    version: 'test',
    buildInfo: {
      gitSha: 'abc123',
      gitDirty: false,
      builtAt: '2026-07-04T12:00:00.000Z',
      buildType: 'production',
    },
    frontendDir: '/app/public',
    ...overrides,
  };
}

describe('server-state', () => {
  let dir = '';
  let path = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mango-state-'));
    path = join(dir, 'server.json');
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  it('round-trips state through write and read', async () => {
    const state = makeState();
    await writeState(state, path);

    expect(await readState(path)).toEqual(state);
  });

  it('returns null when the state file is missing', async () => {
    expect(await readState(join(dir, 'absent.json'))).toBeNull();
  });

  it('returns null when the state file is corrupt', async () => {
    await writeFile(path, '{ not valid json', 'utf8');

    expect(await readState(path)).toBeNull();
  });

  it.each([0, 1, -1, 1.5])(
    'returns null when the recorded pid is %p: stop and killserver would signal it',
    async (pid) => {
      // kill(0) is the caller's group, kill(-1) every process the user owns.
      await writeFile(path, JSON.stringify(makeState({ pid })), 'utf8');

      expect(
        await readState(path),
        `expected a state naming pid ${pid} to read as null`
      ).toBeNull();
    }
  );

  it('returns null for valid JSON that is missing required fields', async () => {
    // A truncated/older-format file must read as "no instance" rather than
    // yielding a state with an undefined pid that downstream callers signal.
    await writeFile(path, JSON.stringify({ port: 3001 }), 'utf8');

    expect(await readState(path)).toBeNull();
  });

  it('leaves no temp file behind after an atomic write', async () => {
    await writeState(makeState(), path);

    const entries = await readdir(dir);
    expect(entries).toEqual(['server.json']);
  });

  it('removeState is idempotent on a missing file', async () => {
    await expect(removeState(join(dir, 'absent.json'))).resolves.toBeUndefined();
  });

  it('removeState deletes an existing file', async () => {
    await writeState(makeState(), path);
    await removeState(path);

    expect(existsSync(path)).toBe(false);
  });

  it('isStateLive reflects the liveness probe result', async () => {
    const state = makeState({ pid: 99 });

    expect(await isStateLive(state, { isAlive: (pid) => pid === 99 })).toBe(true);
    expect(await isStateLive(state, { isAlive: () => false })).toBe(false);
  });
});

describe('readLiveState', () => {
  it('returns the state when its pid is alive', async () => {
    const state = makeState();
    expect(await readLiveState(() => Promise.resolve(state), { isAlive: () => true })).toBe(state);
  });

  it('returns null for a state file left behind by a crash', async () => {
    // The file still names a pid, but that pid can already belong to an
    // unrelated, recycled process — a caller must not treat it as a live hub.
    expect(
      await readLiveState(() => Promise.resolve(makeState()), { isAlive: () => false })
    ).toBeNull();
  });

  it('returns null when there is no state file, without consulting isAlive', async () => {
    let asked = 0;
    const result = await readLiveState(() => Promise.resolve(null), {
      isAlive: () => {
        asked += 1;
        return true;
      },
    });

    expect(result).toBeNull();
    expect(asked).toBe(0);
  });
});

describe('classifyStateProcess', () => {
  const STARTED_AT = 1_700_000_000_000;
  const state = makeState({ startedAt: STARTED_AT });
  const probe = (startMs: number | undefined, alive = true) => ({
    isAlive: () => alive,
    startTimeMs: () => Promise.resolve(startMs),
  });

  it('is stale when the pid is dead', async () => {
    expect(await classifyStateProcess(state, probe(STARTED_AT, false))).toBe('stale');
  });

  it('is the hub when it started before the state was written', async () => {
    expect(await classifyStateProcess(state, probe(STARTED_AT - 3_000))).toBe('hub');
  });

  it('allows the clock granularity of ps and /proc', async () => {
    expect(await classifyStateProcess(state, probe(STARTED_AT + START_TIME_TOLERANCE_MS))).toBe(
      'hub'
    );
  });

  it('is stale when the process started after the hub wrote its state', async () => {
    expect(await classifyStateProcess(state, probe(STARTED_AT + START_TIME_TOLERANCE_MS + 1))).toBe(
      'stale'
    );
  });

  it('is unconfirmed when the start time cannot be read', async () => {
    expect(await classifyStateProcess(state, probe(undefined))).toBe('unconfirmed');
  });

  it('trusts liveness alone when the probe has no start time to offer', async () => {
    expect(await classifyStateProcess(state, { isAlive: () => true })).toBe('hub');
  });
});
