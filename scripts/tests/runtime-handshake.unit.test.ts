import { describe, expect, test } from 'bun:test';

import { findModuleResolutionFailure } from '../lib/module-resolution';
import { probeRuntimeHandshake } from '../lib/runtime-handshake';

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
  runtimeVersion: '0.0.0-test',
  manifest: { platform: 'linux-x64' },
});

/** Runs `source` as a stand-in runtime binary under the current Bun. */
function standIn(source: string): readonly string[] {
  return [process.execPath, '-e', source];
}

const NEVER_RESOLVES = 'await new Promise(() => {});';

describe('scripts/lib/runtime-handshake', () => {
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
