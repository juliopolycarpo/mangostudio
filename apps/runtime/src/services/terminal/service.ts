/**
 * Owns every terminal session this runtime is currently hosting.
 *
 * The eight `terminal.*` methods are thin dispatch onto a `Map<sessionId,
 * TerminalSession>`; the interesting behaviour — credit-gated streaming,
 * scrollback, the drop marker — lives in `session.ts`. What is here is the
 * part that decides *what* gets spawned: which shell, which directory, which
 * environment, and refusing to spawn twice under the same id.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import type { RuntimeShellKind } from '@mangostudio/shared/runtime-protocol';
import { RuntimeToolArgumentError } from '../../errors';
import type { RuntimeEventInput } from '../../host';
import type {
  RuntimeTerminalAckParams,
  RuntimeTerminalAttachParams,
  RuntimeTerminalAttachResult,
  RuntimeTerminalCloseParams,
  RuntimeTerminalDetachParams,
  RuntimeTerminalListResult,
  RuntimeTerminalOpenParams,
  RuntimeTerminalOpenResult,
  RuntimeTerminalOutputEvent,
  RuntimeTerminalResizeParams,
  RuntimeTerminalWriteParams,
} from '../../methods';
import { RUNTIME_TERMINAL_OUTPUT_TOPIC } from '../../methods';
import {
  findShellExecutable,
  isShellAvailable,
  resolveWorkingDirectory,
  ShellExecutionError,
} from '../shell';
import { sanitizeShellEnv } from '../shell-env';
import { TerminalNotFoundError } from './errors';
import { createBunPtyPort, type PtyPort } from './pty';
import { createTerminalSession, type TerminalSession } from './session';

/** Order a default shell is tried in; `powershell` only ever resolves on win32. */
const SHELL_FALLBACK_ORDER: readonly RuntimeShellKind[] = ['bash', 'zsh', 'powershell'];

interface TerminalServiceDeps {
  readonly pty: PtyPort;
  readonly sourceEnv: () => NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
}

const DEFAULT_DEPS: TerminalServiceDeps = {
  pty: createBunPtyPort(),
  sourceEnv: () => process.env,
  platform: process.platform,
};

export interface TerminalService {
  open(params: RuntimeTerminalOpenParams): Promise<RuntimeTerminalOpenResult>;
  attach(params: RuntimeTerminalAttachParams): Promise<RuntimeTerminalAttachResult>;
  detach(params: RuntimeTerminalDetachParams): Promise<{ readonly ok: true }>;
  write(params: RuntimeTerminalWriteParams): Promise<{ readonly ok: true }>;
  resize(params: RuntimeTerminalResizeParams): Promise<{ readonly ok: true }>;
  ack(params: RuntimeTerminalAckParams): Promise<{ readonly ok: true }>;
  closeSession(params: RuntimeTerminalCloseParams): Promise<{ readonly ok: true }>;
  list(): Promise<RuntimeTerminalListResult>;
  /** Kills every session. Used when the paired connection goes away. */
  close(): Promise<void>;
}

export interface TerminalServiceOptions {
  /** Publishes a `terminal.output` frame; only ever called once a session has been attached. */
  readonly emit: (event: RuntimeEventInput) => void;
  readonly deps?: Partial<TerminalServiceDeps>;
}

export function createTerminalService(options: TerminalServiceOptions): TerminalService {
  const deps: TerminalServiceDeps = { ...DEFAULT_DEPS, ...options.deps };
  const sessions = new Map<string, TerminalSession>();

  const publish = (sessionId: string, payload: RuntimeTerminalOutputEvent, end?: true): void => {
    options.emit({
      topic: RUNTIME_TERMINAL_OUTPUT_TOPIC,
      streamId: sessionId,
      payload,
      ...(end ? { end } : {}),
    });
  };

  const requireSession = (sessionId: string): TerminalSession => {
    const session = sessions.get(sessionId);
    if (!session) throw new TerminalNotFoundError(sessionId);
    return session;
  };

  return {
    // biome-ignore lint/suspicious/useAwait: a synchronous throw here must reject the promise, not escape it.
    async open(params) {
      if (sessions.has(params.sessionId)) {
        throw new RuntimeToolArgumentError(
          `Terminal session "${params.sessionId}" is already open; open expects a fresh session id.`
        );
      }

      const shell = params.shell ?? resolveDefaultShell(deps.sourceEnv());
      const executable = findShellExecutable(shell);
      if (!executable) {
        throw new ShellExecutionError(`The "${shell}" shell is not available on this system.`);
      }

      const cwd = resolveSessionCwd(params.cwd);
      const env = buildSessionEnv(params, deps.sourceEnv());
      const argv = buildShellArgv(shell, executable, deps.platform);

      const session = createTerminalSession({
        sessionId: params.sessionId,
        shell,
        cwd,
        argv,
        env,
        cols: params.cols,
        rows: params.rows,
        pty: deps.pty,
        ...(params.scrollbackBytes !== undefined
          ? { scrollbackBytes: params.scrollbackBytes }
          : {}),
        emit: (payload, end) => publish(params.sessionId, payload, end),
      });
      sessions.set(params.sessionId, session);

      return { sessionId: params.sessionId, shell, cwd, pid: session.pid };
    },

    // biome-ignore lint/suspicious/useAwait: an unknown session id must reject.
    async attach(params) {
      return requireSession(params.sessionId).attach();
    },

    // biome-ignore lint/suspicious/useAwait: an unknown session id must reject.
    async detach(params) {
      requireSession(params.sessionId).detach();
      return { ok: true as const };
    },

    // biome-ignore lint/suspicious/useAwait: an unknown session id must reject.
    async write(params) {
      requireSession(params.sessionId).write(params.data);
      return { ok: true as const };
    },

    // biome-ignore lint/suspicious/useAwait: an unknown session id must reject.
    async resize(params) {
      requireSession(params.sessionId).resize(params.cols, params.rows);
      return { ok: true as const };
    },

    // biome-ignore lint/suspicious/useAwait: an unknown session id must reject.
    async ack(params) {
      requireSession(params.sessionId).ack(params.bytes);
      return { ok: true as const };
    },

    closeSession(params) {
      // Closing a session the hub no longer holds a view of is not an error:
      // the hub may be acting on a state one frame behind this one, the same
      // reasoning `install.cancel` uses for an already-finished run.
      sessions.get(params.sessionId)?.close();
      sessions.delete(params.sessionId);
      return Promise.resolve({ ok: true as const });
    },

    list() {
      return Promise.resolve({
        sessions: [...sessions.values()].map((session) => session.snapshot()),
      });
    },

    close() {
      // One session's kill throwing must not skip the rest — the registry
      // relies on this teardown finishing so its sibling services still get
      // torn down inside the same `Promise.allSettled`.
      for (const session of sessions.values()) {
        try {
          session.close();
        } catch {
          // Already gone, or the underlying pty misbehaved on the way out.
        }
      }
      sessions.clear();
      return Promise.resolve();
    },
  };
}

/**
 * Picks the shell when the hub did not name one: the caller's login shell
 * when it is one this runtime offers and can find, else the first of bash,
 * zsh, powershell that is actually installed.
 */
function resolveDefaultShell(sourceEnv: NodeJS.ProcessEnv): RuntimeShellKind {
  const loginShell = basename(sourceEnv.SHELL ?? '');
  if ((loginShell === 'bash' || loginShell === 'zsh') && isShellAvailable(loginShell)) {
    return loginShell;
  }
  const fallback = SHELL_FALLBACK_ORDER.find((shell) => isShellAvailable(shell));
  if (!fallback) {
    throw new ShellExecutionError(
      'No shell is available on this system; install bash, zsh, or (on Windows) PowerShell.'
    );
  }
  return fallback;
}

/** POSIX shells run plain, except macOS defaults to a login shell (`-l`). */
function buildShellArgv(
  shell: RuntimeShellKind,
  executable: string,
  platform: NodeJS.Platform
): readonly string[] {
  if (shell === 'powershell') return [executable, '-NoLogo'];
  return platform === 'darwin' ? [executable, '-l'] : [executable];
}

/**
 * Resolves the session's working directory: `~`-expanded like `shell.run`,
 * defaulting to the runtime user's home. A directory that does not exist —
 * a stale chat cwd, an unmounted drive — falls back to home rather than
 * refusing the open outright; a terminal that starts somewhere is more
 * useful than one that cannot start at all.
 */
function resolveSessionCwd(requested: string | undefined): string {
  const home = homedir();
  if (!requested) return home;
  const resolved = resolveWorkingDirectory(requested);
  return resolved !== undefined && existsSync(resolved) ? resolved : home;
}

function buildSessionEnv(
  params: RuntimeTerminalOpenParams,
  source: NodeJS.ProcessEnv
): Record<string, string> {
  return {
    ...sanitizeShellEnv(params.envPolicy, source),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    MANGOSTUDIO_TERMINAL: '1',
    ...params.env,
  };
}
