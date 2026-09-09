import { afterEach, describe, expect, test } from 'bun:test';

import { findModuleResolutionFailure } from '../lib/module-resolution';
import {
  DEFAULT_HANDSHAKE_BUDGET_MS,
  probeRuntimeHandshake,
  resolveHandshakeBudgetMs,
  WIN32_HANDSHAKE_BUDGET_MS,
} from '../lib/runtime-handshake';
import { stubProcessPlatform } from './support/process-platform';

/**
 * A generous budget for stand-ins that answer or exit on their own: only the
 * hanging cases should ever reach the deadline, so a slow CI spawn must not
 * turn an expected `eof` into a timeout.
 */
const ANSWERING_TIMEOUT_MS = 10_000;
/**
 * Short, because these stand-ins never answer and the test waits it out — but
 * not so short that a loaded shard's spawn latency eats the whole budget before
 * the child writes the stderr these tests then assert on.
 */
const HANGING_TIMEOUT_MS = 1_000;

const HELLO_FRAME = JSON.stringify({
  type: 'hello',
  protocol: { major: 1, minor: 0 },
  peer: { name: 'mangostudio-runtime', version: '0.0.0-test', role: 'runtime' },
  capabilities: { platform: 'linux-x64' },
});

/** Runs `source` as a stand-in runtime binary under the current Bun. */
function standIn(source: string): readonly string[] {
  return [process.execPath, '-e', source];
}

const NEVER_RESOLVES = 'await new Promise(() => {});';

describe('scripts/lib/runtime-handshake', () => {
  describe('budget constants', () => {
    test('Windows gets more headroom than everything else', () => {
      // A cold `windows-*` runner pays process spawn plus first-run JIT and
      // disk warmup on `--stdio`; `--version` short-circuits and answers in
      // milliseconds, which is why a green `--version` says nothing about this.
      expect(WIN32_HANDSHAKE_BUDGET_MS).toBeGreaterThan(DEFAULT_HANDSHAKE_BUDGET_MS);
    });

    test('the Windows budget stays within a smoke job people will wait for', () => {
      // Generous on purpose — the cost of being wrong upwards is a slower red,
      // not a missed one — but a runtime that never greets still has to fail
      // inside a job somebody is watching.
      expect(WIN32_HANDSHAKE_BUDGET_MS).toBeLessThanOrEqual(2 * 60_000);
    });
  });

  describe('resolveHandshakeBudgetMs', () => {
    let restorePlatform: (() => void) | undefined;

    afterEach(() => {
      restorePlatform?.();
      restorePlatform = undefined;
    });

    test('returns the Windows budget on win32', () => {
      restorePlatform = stubProcessPlatform('win32');
      expect(resolveHandshakeBudgetMs()).toBe(WIN32_HANDSHAKE_BUDGET_MS);
    });

    test.each(['linux', 'darwin'] as const)('returns the default budget on %s', (platform) => {
      restorePlatform = stubProcessPlatform(platform);
      expect(resolveHandshakeBudgetMs()).toBe(DEFAULT_HANDSHAKE_BUDGET_MS);
    });

    test('is what a probe with no budget of its own waits for', async () => {
      // The smoke passes no `timeoutMs`, so a default that stopped being read
      // would silently put every platform back on the same budget.
      restorePlatform = stubProcessPlatform('linux');
      const startedAt = Date.now();
      const probe = await probeRuntimeHandshake({ command: standIn(NEVER_RESOLVES) });

      expect(probe.failure).toContain(`within ${DEFAULT_HANDSHAKE_BUDGET_MS}ms`);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(DEFAULT_HANDSHAKE_BUDGET_MS);
    }, 30_000);
  });

  describe('probeRuntimeHandshake', () => {
    test('returns the handshake line and still drains stderr', async () => {
      const probe = await probeRuntimeHandshake({
        command: standIn(
          `await Bun.write(Bun.stderr, 'warming up\\n');` +
            `await Bun.write(Bun.stdout, ${JSON.stringify(`${HELLO_FRAME}\n`)});` +
            NEVER_RESOLVES
        ),
        timeoutMs: ANSWERING_TIMEOUT_MS,
      });

      expect(probe.hello).toBe(HELLO_FRAME);
      expect(probe.failure).toBeNull();
      expect(probe.stderr).toContain('warming up');
    });

    test('times how long the child took to speak, not how long cleanup took', async () => {
      // This child greets at once and then refuses to die on SIGTERM, so the
      // probe pays the whole exit grace *after* it already has its answer. A
      // number taken at the return would fold that wait into what is meant to
      // be evidence about how long the runtime took to start talking.
      const startedAt = Date.now();
      const probe = await probeRuntimeHandshake({
        command: standIn(
          `process.on('SIGTERM', () => {});` +
            `await Bun.write(Bun.stdout, ${JSON.stringify(`${HELLO_FRAME}\n`)});` +
            `setTimeout(() => process.exit(0), 1_200);` +
            NEVER_RESOLVES
        ),
        timeoutMs: ANSWERING_TIMEOUT_MS,
        exitGraceMs: 800,
      });
      const callMs = Date.now() - startedAt;

      expect(probe.hello).toBe(HELLO_FRAME);
      expect(callMs - probe.elapsedMs).toBeGreaterThanOrEqual(500);
    });

    test('names the child exit and carries its code and stderr', async () => {
      const probe = await probeRuntimeHandshake({
        command: standIn(`await Bun.write(Bun.stderr, 'boom\\n'); process.exit(3);`),
        timeoutMs: ANSWERING_TIMEOUT_MS,
      });

      expect(probe.hello).toBeNull();
      expect(probe.failure).toContain('closed stdout without a handshake frame');
      expect(probe.failure).toContain('exited with code 3');
      expect(probe.exitCode).toBe(3);
      expect(probe.stderr).toContain('boom');
    });

    test('names the timeout when the child writes stderr and then hangs', async () => {
      const probe = await probeRuntimeHandshake({
        command: standIn(`await Bun.write(Bun.stderr, 'stuck\\n');${NEVER_RESOLVES}`),
        timeoutMs: HANGING_TIMEOUT_MS,
      });

      expect(probe.hello).toBeNull();
      expect(probe.failure).toBe(
        `wrote no handshake frame within ${HANGING_TIMEOUT_MS}ms and was killed`
      );
      expect(probe.stderr).toContain('stuck');
      // The kill is ours, so its status is not the failure cause (issue #957).
      expect(probe.exitCode).toBeNull();
      expect(probe.signal).toBeNull();
    });

    test('carries an unterminated partial line verbatim on timeout', async () => {
      const probe = await probeRuntimeHandshake({
        command: standIn(`await Bun.write(Bun.stdout, '{"type":"hel');${NEVER_RESOLVES}`),
        timeoutMs: HANGING_TIMEOUT_MS,
      });

      expect(probe.hello).toBeNull();
      expect(probe.partial).toBe('{"type":"hel');
      expect(probe.failure).toContain('within');
    });

    test('carries an unterminated partial line when the child exits instead', async () => {
      const probe = await probeRuntimeHandshake({
        command: standIn(`await Bun.write(Bun.stdout, '{"type":"hel'); process.exit(0);`),
        timeoutMs: ANSWERING_TIMEOUT_MS,
      });

      expect(probe.partial).toBe('{"type":"hel');
      expect(probe.exitCode).toBe(0);
      expect(probe.failure).toContain('exited with code 0');
    });

    // The two failures the old single-line report collapsed together.
    test('reports a distinct cause for a crash and for a hang', async () => {
      const crashed = await probeRuntimeHandshake({
        command: standIn('process.exit(1);'),
        timeoutMs: ANSWERING_TIMEOUT_MS,
      });
      const hung = await probeRuntimeHandshake({
        command: standIn(NEVER_RESOLVES),
        timeoutMs: HANGING_TIMEOUT_MS,
      });

      expect(crashed.failure).not.toBe(hung.failure);
      expect(crashed.failure).toContain('exited with code 1');
      expect(hung.failure).toContain('within');
    });

    test('reports the resolution error a greeting child left on stderr', async () => {
      const probe = await probeRuntimeHandshake({
        command: standIn(
          `await Bun.write(Bun.stderr, 'error: Cannot find module "./642.js"\\n');` +
            `await Bun.write(Bun.stdout, ${JSON.stringify(`${HELLO_FRAME}\n`)});` +
            NEVER_RESOLVES
        ),
        timeoutMs: ANSWERING_TIMEOUT_MS,
      });

      // The success path is guarded too: the smoke greps this stderr.
      expect(probe.hello).toBe(HELLO_FRAME);
      expect(findModuleResolutionFailure(probe.stderr)).toBe('Cannot find module');
    });

    test('kills a child that closed stdout but never exits, without claiming its status', async () => {
      const startedAt = Date.now();
      const probe = await probeRuntimeHandshake({
        command: standIn(
          `(await import('node:fs')).closeSync(1);` +
            `await Bun.write(Bun.stderr, 'orphaned\\n');` +
            NEVER_RESOLVES
        ),
        timeoutMs: ANSWERING_TIMEOUT_MS,
        exitGraceMs: 200,
      });

      expect(probe.hello).toBeNull();
      expect(probe.failure).toContain('did not exit within 200ms');
      expect(probe.exitCode).toBeNull();
      expect(probe.stderr).toContain('orphaned');
      // Cleanup is bounded: the handshake budget is 10s and must not be spent.
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    });

    // The Windows shape this probe exists to name: the runtime died, but a
    // grandchild inherited stdout, so the pipe never reaches EOF and the read
    // times out. The dead child's own status is the diagnostic, so our kill
    // must not overwrite it with nothing.
    test('keeps the exit status of a child that died holding stdout open', async () => {
      const probe = await probeRuntimeHandshake({
        command: standIn(
          `Bun.spawn({ cmd: [process.execPath, '-e', 'setTimeout(() => process.exit(0), 3000);'],` +
            ` stdout: 'inherit', stderr: 'ignore', stdin: 'ignore' });` +
            `await Bun.write(Bun.stderr, 'dying\\n');` +
            `process.exit(7);`
        ),
        timeoutMs: HANGING_TIMEOUT_MS,
        exitGraceMs: 200,
      });

      expect(probe.hello).toBeNull();
      expect(probe.exitCode).toBe(7);
      expect(probe.failure).toContain('left stdout open');
      expect(probe.failure).toContain('exited with code 7');
      expect(probe.stderr).toContain('dying');
    });

    // A bare newline is a line, not a missing frame: the caller's guard has to
    // be `hello === null`, so the probe must not blur the two.
    test('reports an empty first line as a handshake line, not a failure', async () => {
      const probe = await probeRuntimeHandshake({
        command: standIn(`await Bun.write(Bun.stdout, '\\n');${NEVER_RESOLVES}`),
        timeoutMs: ANSWERING_TIMEOUT_MS,
      });

      expect(probe.hello).toBe('');
      expect(probe.failure).toBeNull();
    });
  });
});

describe('scripts/lib/module-resolution', () => {
  test.each([
    ['error: Cannot find module "./chunk.js"', 'Cannot find module'],
    ['ResolveMessage: could not resolve', 'ResolveMessage'],
    ['failed loading ./642.js', './642.js'],
  ])('flags %j', (text, expected) => {
    expect(findModuleResolutionFailure(text)).toBe(expected);
  });

  test('returns null for benign logging', () => {
    expect(findModuleResolutionFailure('runtime ready; loaded 12 modules')).toBeNull();
  });

  test('returns null for empty stderr', () => {
    expect(findModuleResolutionFailure('')).toBeNull();
  });
});
