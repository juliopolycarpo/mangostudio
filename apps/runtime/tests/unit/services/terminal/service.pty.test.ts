import { describe, expect, it } from 'bun:test';
import type { RuntimeEventInput } from '../../../../src/host';
import type { RuntimeTerminalOutputEvent } from '../../../../src/methods';
import { isShellAvailable } from '../../../../src/services/shell';
import { supportsPty } from '../../../../src/services/terminal/pty';
import { createTerminalService } from '../../../../src/services/terminal/service';

// `open()` only ever resolves bash or zsh on POSIX (see resolveDefaultShell in
// service.ts) — a machine with only `sh` on PATH must skip, not fail.
const hasPosixShell =
  process.platform !== 'win32' && (isShellAvailable('bash') || isShellAvailable('zsh'));

/**
 * The one test in this suite that spawns a real `Bun.Terminal`. Everything
 * else in `session.test.ts`/`service.test.ts` runs against `FakePtyPort`; this
 * is what proves the wiring between `createTerminalService`,
 * `createTerminalSession`, and the real port actually produces bytes a viewer
 * can read.
 */
describe('createTerminalService over a real pty', () => {
  it.skipIf(!supportsPty() || process.platform === 'win32' || !hasPosixShell)(
    'opens a shell, streams a command back, and closes cleanly',
    async () => {
      const frames: RuntimeTerminalOutputEvent[] = [];
      const service = createTerminalService({
        emit: (event: RuntimeEventInput) => {
          frames.push(event.payload as RuntimeTerminalOutputEvent);
        },
      });

      const sessionId = 'pty-integration';
      try {
        const opened = await service.open({ sessionId, cols: 80, rows: 24 });
        expect(opened.pid).toBeGreaterThan(0);

        await service.attach({ sessionId });
        // The pty echoes typed input back before the shell ever runs it, so a
        // literal command name in the echo would satisfy the assertion even if
        // bash never executed anything. Asking the shell to compute the marker
        // means the assertion can only pass once bash has actually run it.
        await service.write({
          sessionId,
          data: Buffer.from('printf \'%s\\n\' "MANGO_$((20+3))"\n').toString('base64'),
        });

        const sawMarker = await waitFor(() => decodeDataFrames(frames).includes('MANGO_23'));
        expect(sawMarker).toBe(true);
      } finally {
        await service.closeSession({ sessionId });
      }
    },
    10_000
  );
});

function decodeDataFrames(frames: readonly RuntimeTerminalOutputEvent[]): string {
  return frames
    .filter((frame) => frame.kind === 'data')
    .map((frame) => Buffer.from((frame as { data: string }).data, 'base64').toString('utf8'))
    .join('');
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await Bun.sleep(20);
  }
  return condition();
}
