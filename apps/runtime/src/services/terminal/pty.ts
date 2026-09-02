/**
 * The PTY seam. `Bun.Terminal` is the only implementation that ships; the
 * interface exists so the session code is tested against a fake and so the
 * spawn options that matter (inline `terminal:` per spawn, own process group,
 * hidden window) live in one place.
 *
 * Inline `terminal:` on every spawn rather than a shared `Bun.Terminal`: a
 * reused terminal object does not make the child a session leader, and a shell
 * that is not one cannot own its job control.
 */

import { killProcessTree, OWN_PROCESS_GROUP } from '../process-tree';
import { HIDDEN_WINDOW } from '../process-window';

export interface PtySpawnInput {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cols: number;
  readonly rows: number;
  /** Fires for every byte run the child writes; never awaited by Bun. */
  readonly onData: (chunk: Uint8Array) => void;
  readonly onExit: (exitCode: number | null, signal: string | null) => void;
}

/** One live pseudo-terminal and the child behind it. */
export interface PtyHandle {
  readonly pid: number;
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  /** Kills the process tree, then releases the PTY. Idempotent. */
  close(): void;
}

export interface PtyPort {
  spawn(input: PtySpawnInput): PtyHandle;
}

/** Whether this build of Bun can open a PTY at all. */
export function supportsPty(): boolean {
  return typeof (Bun as { Terminal?: unknown }).Terminal === 'function';
}

/** The production port over `Bun.spawn` with its `terminal` option. */
export function createBunPtyPort(): PtyPort {
  return {
    spawn(input) {
      const proc = Bun.spawn([...input.argv], {
        cwd: input.cwd,
        env: { ...input.env },
        terminal: {
          cols: input.cols,
          rows: input.rows,
          name: 'xterm-256color',
          data: (_terminal, chunk) => input.onData(chunk),
        },
        ...OWN_PROCESS_GROUP,
        ...HIDDEN_WINDOW,
      });
      // The status comes from the subprocess, not from the terminal's `exit`
      // callback: measured on Bun 1.4.0, that callback reports `1, null` for a
      // clean `exit 0` and for a SIGKILL alike, while `exitCode`/`signalCode`
      // on the process are right for both.
      void proc.exited.then(() => input.onExit(proc.exitCode, proc.signalCode));
      let closed = false;
      return {
        pid: proc.pid,
        write(data) {
          proc.terminal?.write(data);
        },
        resize(cols, rows) {
          proc.terminal?.resize(cols, rows);
        },
        close() {
          if (closed) return;
          closed = true;
          // Tree first: on Windows, ConPTY's `close()` can block while a child
          // still runs, and on POSIX a shell's descendants would outlive it.
          killProcessTree(proc.pid, () => proc.kill('SIGKILL'));
          try {
            proc.terminal?.close();
          } catch {
            // Already gone with the child.
          }
        },
      };
    },
  };
}
