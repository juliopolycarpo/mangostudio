import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isStateLive,
  readState,
  removeState,
  type ServerState,
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
