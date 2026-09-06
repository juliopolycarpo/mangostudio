import { describe, expect, it } from 'bun:test';
import {
  createBunPtyPort,
  type PtyHandle,
  type PtyPort,
  type PtySpawnInput,
  supportsPty,
} from '../../../../src/services/terminal/pty';

const hasPosixShell = process.platform !== 'win32' && Bun.which('sh') !== null;

/**
 * Real-PTY coverage. Skips with a stated reason rather than passing on a Bun
 * that has no `Bun.Terminal`, so an older CI Bun degrades to a skip and not to
 * a fake green.
 */
describe('createBunPtyPort', () => {
  it.skipIf(!supportsPty() || !hasPosixShell)(
    'spawns a session leader that sees the requested size and follows a resize',
    async () => {
      const port: PtyPort = createBunPtyPort();
      const chunks: Uint8Array[] = [];
      const exited = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>();
      // The resize has to land after the first `stty size` has already run and
      // before the second. A timer cannot say when that is: a loaded runner
      // spawns the shell late, the resize wins the race, and both reads report
      // the size after it. The shell's own first line is the signal.
      const firstRead = Promise.withResolvers<void>();
      const input: PtySpawnInput = {
        argv: ['sh', '-c', 'stty size; sleep 0.2; stty size'],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? '', TERM: 'xterm-256color' },
        cols: 100,
        rows: 30,
        onData: (chunk) => {
          chunks.push(chunk);
          if (new TextDecoder().decode(Buffer.concat(chunks)).includes('\n')) firstRead.resolve();
        },
        onExit: (exitCode, signal) => exited.resolve({ exitCode, signal }),
      };
      const handle: PtyHandle = port.spawn(input);
      expect(handle.pid).toBeGreaterThan(0);
      // Raced with the exit so a shell that never printed fails on the
      // assertions below with what it did produce, rather than hanging here.
      await Promise.race([firstRead.promise, exited.promise]);
      handle.resize(80, 24);
      const exit = await exited.promise;
      handle.close();

      const output = new TextDecoder().decode(Buffer.concat(chunks));
      expect(exit.exitCode).toBe(0);
      expect(output).toContain('30 100');
      expect(output).toContain('24 80');
    }
  );

  it.skipIf(!supportsPty() || !hasPosixShell)(
    'close kills the shell and reports the exit',
    async () => {
      const port = createBunPtyPort();
      const exited = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>();
      const handle = port.spawn({
        argv: ['sh', '-c', 'sleep 30'],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? '' },
        cols: 80,
        rows: 24,
        onData: () => undefined,
        onExit: (exitCode, signal) => exited.resolve({ exitCode, signal }),
      });
      handle.close();
      handle.close();
      const exit = await exited.promise;
      expect(exit.exitCode === null || exit.exitCode !== 0).toBe(true);
    }
  );
});
