/**
 * A CLI command that reaches Local must exit once it is done.
 *
 * Local is a spawned `mangostudio-runtime` child, and a live pipe to it keeps
 * the event loop — and so the CLI — alive. `mangostudio env` probes Local
 * through the process-wide connection manager, so it is the command that
 * would hang if `dispatch` stopped releasing runtime connections.
 *
 * Spawns the real CLI entry under `NODE_ENV=production` with a scratch `HOME`
 * and `MANGO_HOME`, so it resolves real configuration and never touches the
 * developer's `~/.mango`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRustRuntimeBinary } from '../../support/rust-runtime-binary';

const ENTRY = join(import.meta.dir, '../../../src/index.ts');
const EXIT_BOUND_MS = 10_000;
const binary = resolveRustRuntimeBinary();
const isPosix = process.platform !== 'win32';

/** Pids of `pid`'s direct children, read with `pgrep`, so a hang can name the child it left. */
function childPids(pid: number): number[] {
  const listed = Bun.spawnSync(['pgrep', '-P', String(pid)]);
  return new TextDecoder()
    .decode(listed.stdout)
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((child) => Number.isInteger(child) && child > 0);
}

describe('CLI commands that reach Local', () => {
  let home = '';

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'mango-cli-local-'));
  });

  afterEach(async () => {
    await rm(home, { force: true, recursive: true });
  });

  it.skipIf(!binary.available || !isPosix)(
    'exits after `env` instead of waiting on the Local runtime child',
    async () => {
      const cli = Bun.spawn({
        cmd: [process.execPath, ENTRY, 'env'],
        env: {
          ...(process.env as Record<string, string>),
          NODE_ENV: 'production',
          HOME: home,
          MANGO_HOME: join(home, '.mango'),
          DATABASE_PATH: join(home, 'database.sqlite'),
          MANGOSTUDIO_RUNTIME_BINARY: binary.path,
          MANGOSTUDIO_DIAGNOSTIC_LOGS: '0',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stdout = new Response(cli.stdout).text();
      const stderr = new Response(cli.stderr).text();
      const timedOut = Symbol('timed out');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        cli.exited,
        new Promise<typeof timedOut>((resolve) => {
          timer = setTimeout(() => resolve(timedOut), EXIT_BOUND_MS);
        }),
      ]);
      clearTimeout(timer);

      if (outcome === timedOut) {
        const children = childPids(cli.pid);
        cli.kill('SIGKILL');
        for (const child of children) process.kill(child, 'SIGKILL');
        throw new Error(
          `expected CLI exit within ${EXIT_BOUND_MS / 1_000}s | received: still running, ` +
            `runtime child pid ${children.join(', ') || 'none'} alive`
        );
      }
      // Proves the command reached Local rather than exiting early on a
      // configuration error, which would pass the bound for the wrong reason.
      expect({ exitCode: outcome, stderr: (await stderr).trim() }).toEqual({
        exitCode: 0,
        stderr: '',
      });
      expect(await stdout).toContain('Agent CLIs');
    },
    30_000
  );
});
