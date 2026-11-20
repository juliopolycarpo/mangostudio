import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
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
import { removeFixtureDir } from '../../support/remove-fixture-dir';

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
    await removeFixtureDir({ role: 'server-state', path: dir });
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

  it.each([0, 1, -1, 1.5, 2 ** 53 + 1, 1e300])(
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

  it('isStateLive reflects the liveness probe result', () => {
    const state = makeState({ pid: 99 });

    expect(isStateLive(state, (pid) => pid === 99)).toBe(true);
    expect(isStateLive(state, () => false)).toBe(false);
  });
});

describe('readLiveState', () => {
  it('returns the state when its pid is alive', async () => {
    const state = makeState();
    expect(
      await readLiveState(
        () => Promise.resolve(state),
        () => true
      )
    ).toBe(state);
  });

  it('returns null for a state file left behind by a crash', async () => {
    // The file still names a pid, but that pid can already belong to an
    // unrelated, recycled process — a caller must not treat it as a live hub.
    expect(
      await readLiveState(
        () => Promise.resolve(makeState()),
        () => false
      )
    ).toBeNull();
  });

  it('returns null when there is no state file, without consulting isAlive', async () => {
    let asked = 0;
    const result = await readLiveState(
      () => Promise.resolve(null),
      () => {
        asked += 1;
        return true;
      }
    );

    expect(result).toBeNull();
    expect(asked).toBe(0);
  });
});

describe('readState start token', () => {
  it('round-trips a start token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mango-state-'));
    try {
      const path = join(dir, 'server.json');
      await writeState(makeState({ startToken: 'boot:123' }), path);

      expect((await readState(path))?.startToken).toBe('boot:123');
    } finally {
      await removeFixtureDir({ role: 'server-state', path: dir });
    }
  });

  it('reads a malformed token as no token instead of a mismatch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mango-state-'));
    try {
      const path = join(dir, 'server.json');
      await writeFile(path, JSON.stringify({ ...makeState(), startToken: 12345 }), 'utf8');

      const state = await readState(path);

      expect(state?.pid).toBe(4242);
      expect(state?.startToken).toBeUndefined();
    } finally {
      await removeFixtureDir({ role: 'server-state', path: dir });
    }
  });
});

describe('classifyStateProcess', () => {
  const STARTED_AT = 1_700_000_000_000;
  const HOUR = 3_600_000;
  const withToken = makeState({ startedAt: STARTED_AT, startToken: 'boot:100' });
  const withoutToken = makeState({ startedAt: STARTED_AT });

  /** A probe that counts its queries; `undefined` fields make that query fail. */
  function probe(opts: { alive?: boolean; token?: string; startMs?: number }) {
    const calls = { token: 0, time: 0 };
    return {
      calls,
      isAlive: () => opts.alive ?? true,
      startToken: () => {
        calls.token += 1;
        return Promise.resolve(opts.token);
      },
      startTimeMs: () => {
        calls.time += 1;
        return Promise.resolve(opts.startMs);
      },
    };
  }

  it('is stale when the pid is dead', async () => {
    expect(await classifyStateProcess(withToken, probe({ alive: false }))).toBe('stale');
  });

  it('is the hub when the tokens are equal', async () => {
    expect(await classifyStateProcess(withToken, probe({ token: 'boot:100' }))).toBe('hub');
  });

  it('is stale when both tokens exist and differ', async () => {
    expect(await classifyStateProcess(withToken, probe({ token: 'boot:999' }))).toBe('stale');
  });

  it('is still the hub after the wall clock stepped forward an hour', async () => {
    // The clock rule alone would call this process too young; the token decides.
    expect(
      await classifyStateProcess(
        withToken,
        probe({ token: 'boot:100', startMs: STARTED_AT + HOUR })
      )
    ).toBe('hub');
  });

  it('never calls a clock-rule mismatch stale: a file without a token is unconfirmed', async () => {
    expect(await classifyStateProcess(withoutToken, probe({ startMs: STARTED_AT + HOUR }))).toBe(
      'unconfirmed'
    );
  });

  it('falls back to the clock rule when the token cannot be read now', async () => {
    expect(await classifyStateProcess(withToken, probe({ startMs: STARTED_AT - 3_000 }))).toBe(
      'hub'
    );
    expect(await classifyStateProcess(withToken, probe({ startMs: STARTED_AT + HOUR }))).toBe(
      'unconfirmed'
    );
  });

  it('allows the clock granularity of ps and /proc in the fallback', async () => {
    expect(
      await classifyStateProcess(
        withoutToken,
        probe({ startMs: STARTED_AT + START_TIME_TOLERANCE_MS })
      )
    ).toBe('hub');
  });

  it('is unconfirmed when nothing can be read', async () => {
    expect(await classifyStateProcess(withoutToken, probe({}))).toBe('unconfirmed');
    expect(await classifyStateProcess(withToken, probe({}))).toBe('unconfirmed');
  });

  it('answers hub for this very process without any query', async () => {
    const own = makeState({ pid: process.pid, startToken: 'boot:other' });
    const fake = probe({ token: 'boot:999', startMs: STARTED_AT + HOUR });

    expect(await classifyStateProcess(own, fake)).toBe('hub');
    expect(fake.calls).toEqual({ token: 0, time: 0 });
  });

  it('trusts liveness alone when the probe offers no identity query', async () => {
    expect(await classifyStateProcess(withToken, { isAlive: () => true })).toBe('hub');
  });
});

describe('server-state control token', () => {
  let dir = '';
  let path = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mango-state-token-'));
    path = join(dir, 'server.json');
  });

  afterEach(async () => {
    await removeFixtureDir({ role: 'server-state', path: dir });
  });

  it('round-trips the control token', async () => {
    await writeState(makeState({ controlToken: 'control-token-round-trip' }), path);

    expect((await readState(path))?.controlToken).toBe('control-token-round-trip');
  });

  it('reads a non-string control token as absent rather than as a credential', async () => {
    await writeFile(path, JSON.stringify({ ...makeState(), controlToken: 12345 }), 'utf8');

    const state = await readState(path);

    expect(state, 'expected the file to stay readable').not.toBeNull();
    expect(state?.controlToken).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')(
    'writes the file owner-only, since it carries the token',
    async () => {
      await writeState(makeState({ controlToken: 'control-token-mode' }), path);

      const mode = ((await stat(path)).mode & 0o777).toString(8);

      expect(mode, `expected state file mode: 600 | received: ${mode}`).toBe('600');
    }
  );
});
