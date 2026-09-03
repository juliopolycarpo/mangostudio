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
import { findShellExecutable, resolveWorkingDirectory, ShellExecutionError } from '../shell';
import { sanitizeShellEnv } from '../shell-env';
import { TerminalNotFoundError } from './errors';
import { createBunPtyPort, type PtyPort } from './pty';
import { createTerminalSession, type TerminalSession } from './session';

/**
 * Order a default shell is tried in, per platform.
 *
 * PowerShell comes first on Windows and never resolves anywhere else: a
 * Windows box with Git for Windows or WSL installed answers `Bun.which('bash')`
 * with `…\Git\usr\bin\bash.exe` or `System32\bash.exe` — the WSL launcher —
 * so a POSIX-first order would hand a Windows user a shell on a different
 * filesystem than the one their chat's working directory names.
 */
const SHELL_FALLBACK_ORDER: Readonly<Record<'win32' | 'posix', readonly RuntimeShellKind[]>> = {
  win32: ['powershell', 'bash', 'zsh'],
  posix: ['bash', 'zsh', 'powershell'],
};

interface TerminalServiceDeps {
  readonly pty: PtyPort;
  readonly sourceEnv: () => NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  /**
   * PATH lookup for a shell kind. Injected alongside `platform` because the
   * real one reads this host's PATH and hard-refuses `powershell` off win32,
   * which leaves the Windows fallback order untestable anywhere it matters —
   * and there is no Windows unit-test lane.
   */
  readonly findShell: (kind: RuntimeShellKind) => string | null;
}

const DEFAULT_DEPS: TerminalServiceDeps = {
  pty: createBunPtyPort(),
  sourceEnv: () => process.env,
  platform: process.platform,
  findShell: findShellExecutable,
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

  /**
   * Runs `act` against a session that must exist, answering the bare `ok` the
   * mutating methods share. `async` so an unknown session id rejects the
   * promise rather than throwing synchronously into the caller's frame — the
   * one reason each of these methods was declared `async` with no `await`.
   */
  // biome-ignore lint/suspicious/useAwait: an unknown session id must reject.
  const onSession = async (
    sessionId: string,
    act: (session: TerminalSession) => void
  ): Promise<{ readonly ok: true }> => {
    act(requireSession(sessionId));
    return { ok: true as const };
  };

  return {
    // biome-ignore lint/suspicious/useAwait: a synchronous throw here must reject the promise, not escape it.
    async open(params) {
      if (sessions.has(params.sessionId)) {
        throw new RuntimeToolArgumentError(
          `Terminal session "${params.sessionId}" is already open; open expects a fresh session id.`
        );
      }

      const shell = params.shell ?? resolveDefaultShell(deps);
      const executable = deps.findShell(shell);
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

    detach(params) {
      return onSession(params.sessionId, (session) => session.detach());
    },

    write(params) {
      return onSession(params.sessionId, (session) => session.write(params.data));
    },

    resize(params) {
      return onSession(params.sessionId, (session) => session.resize(params.cols, params.rows));
    },

    ack(params) {
      return onSession(params.sessionId, (session) => session.ack(params.bytes));
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
 * when it is one this runtime offers and can find, else the first of this
 * platform's fallback order that is actually installed.
 *
 * `SHELL` is honoured only off Windows. A Windows process can inherit one from
 * a Git Bash or MSYS parent, and it would name a shell for a filesystem this
 * session is not going to run in.
 */
function resolveDefaultShell(deps: TerminalServiceDeps): RuntimeShellKind {
  const isWindows = deps.platform === 'win32';
  const order = isWindows ? SHELL_FALLBACK_ORDER.win32 : SHELL_FALLBACK_ORDER.posix;
  const available = (shell: RuntimeShellKind): boolean => deps.findShell(shell) !== null;
  const loginShell = isWindows ? '' : basename(deps.sourceEnv().SHELL ?? '');
  if ((loginShell === 'bash' || loginShell === 'zsh') && available(loginShell)) {
    return loginShell;
  }
  const fallback = order.find(available);
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
