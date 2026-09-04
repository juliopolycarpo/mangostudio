/**
 * Runs an install recipe on the environment it was approved for.
 *
 * Execution moved to the runtime, so what is left here is the relay: the hub
 * asks a machine to run an argv it built, and turns the machine's `evt` frames
 * back into the log callbacks the install service has always consumed. The SSE
 * stream a browser sees is unchanged in shape — only the host that produced the
 * bytes moved.
 *
 * Cancellation crosses the boundary as a method call rather than a signal,
 * because the child belongs to the other side; a runtime that has gone away
 * cannot be told, which the connection failure already reports.
 */

import {
  RUNTIME_INSTALL_OUTPUT_TOPIC,
  type RuntimeInstallOutputEvent,
  type RuntimeInstallRunResult,
} from '@mangostudio/runtime';
import type { InstallRunStatus, ToolchainSelection } from '@mangostudio/shared/environments';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { getInstallLogPath } from '../../../lib/mango-paths';
import type { RuntimeClient } from '../../../services/runtime-client/runtime-client';
import { getRuntimeClient } from '../../../services/runtime-client/runtime-connection-manager';
import { toolchainParams } from '../application/toolchain-service';

type InstallOutputStream = RuntimeInstallOutputEvent['stream'];

export interface InstallLogLine {
  readonly stream: InstallOutputStream;
  readonly line: string;
}

interface RunInstallCommand {
  readonly runId: string;
  readonly userId: string;
  readonly environmentId: string;
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** Exit codes besides 0 that still count as `succeeded` (winget's "already current"). */
  readonly acceptedExitCodes?: readonly number[];
  /** Absent: the runtime's own PATH. The service resolves this per environment. */
  readonly toolchain?: ToolchainSelection;
}

interface RunInstallOptions {
  readonly signal?: AbortSignal;
  readonly onLog?: (event: InstallLogLine) => void;
  readonly outputLimitBytes?: number;
}

interface InstallRunnerResult {
  readonly exitCode: number | null;
  readonly status: Exclude<InstallRunStatus, 'running'>;
  readonly truncated: boolean;
  readonly finishedAt: number;
  readonly durationMs: number;
}

export interface InstallRunner {
  run(command: RunInstallCommand, options?: RunInstallOptions): Promise<InstallRunnerResult>;
}

export interface InstallRunnerDeps {
  readonly resolveClient: (userId: string, environmentId: string) => Promise<RuntimeClient>;
  /**
   * Where the run's log lives on the machine that produces it. The hub's own
   * layout is used for its own machine; a remote runtime is told a path under
   * its own home rather than one that only exists here.
   */
  readonly logPathFor: (runId: string, environmentId: string) => string;
  readonly now: () => number;
}

/**
 * A remote runtime writes its log beside its own runtime home. The hub keeps
 * the authoritative copy in the stream it relays and in the audit row, so this
 * path only has to be writable there, not meaningful here.
 */
function defaultLogPath(runId: string, environmentId: string): string {
  return environmentId === LOCAL_ENVIRONMENT_ID
    ? getInstallLogPath(runId)
    : `.mango/runtime/logs/install-${runId}.log`;
}

const defaultDeps: InstallRunnerDeps = {
  resolveClient: (userId, environmentId) => getRuntimeClient(userId, environmentId),
  logPathFor: defaultLogPath,
  now: Date.now,
};

function terminalFor(result: RuntimeInstallRunResult): Exclude<InstallRunStatus, 'running'> {
  return result.status;
}

export function createInstallRunner(overrides: Partial<InstallRunnerDeps> = {}): InstallRunner {
  const deps = { ...defaultDeps, ...overrides };

  return {
    async run(command, options = {}) {
      const startedAt = deps.now();
      const failure = (status: Exclude<InstallRunStatus, 'running'>): InstallRunnerResult => {
        const finishedAt = deps.now();
        return {
          exitCode: null,
          status,
          truncated: false,
          finishedAt,
          durationMs: finishedAt - startedAt,
        };
      };

      if (options.signal?.aborted) return failure('cancelled');

      let client: RuntimeClient;
      try {
        client = await deps.resolveClient(command.userId, command.environmentId);
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'The environment is unavailable.';
        options.onLog?.({ stream: 'system', line: detail });
        return failure('spawn-failed');
      }

      // Subscribed before the request goes out: a fast installer can produce
      // output before `run` resolves, and a listener attached afterwards would
      // miss exactly the first lines someone is watching for.
      const unsubscribe = client.onEvent((event) => {
        if (event.topic !== RUNTIME_INSTALL_OUTPUT_TOPIC) return;
        if (event.streamId !== command.runId) return;
        const payload = event.payload as RuntimeInstallOutputEvent;
        if (payload.end) return;
        options.onLog?.({ stream: payload.stream, line: payload.line });
      });

      const cancel = () => {
        // The child belongs to the other side, so cancellation is a request
        // rather than a signal; a runtime that is already gone cannot be told,
        // and the run's own failure reports that.
        void client.install.cancel({ runId: command.runId }).catch(() => undefined);
      };
      options.signal?.addEventListener('abort', cancel, { once: true });
      if (options.signal?.aborted) cancel();

      try {
        const result = await client.install.run(
          {
            runId: command.runId,
            argv: [...command.argv],
            ...(command.env && { env: command.env }),
            timeoutMs: command.timeoutMs,
            logPath: deps.logPathFor(command.runId, command.environmentId),
            ...toolchainParams(client.manifest, command.toolchain),
            ...(options.outputLimitBytes !== undefined && {
              outputLimitBytes: options.outputLimitBytes,
            }),
            ...(command.acceptedExitCodes && { acceptedExitCodes: command.acceptedExitCodes }),
          },
          // Above the recipe's own timeout: the runtime kills the child on
          // time, and this deadline only catches a link that stopped answering.
          { timeoutMs: command.timeoutMs + 30_000 }
        );
        return {
          exitCode: result.exitCode,
          status: terminalFor(result),
          truncated: result.truncated,
          // Audit rows are hub-local; stamp completion with the hub clock and
          // keep the remote-measured duration as the wall time the installer
          // actually spent on that machine.
          finishedAt: deps.now(),
          durationMs: result.durationMs,
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'Install execution failed.';
        options.onLog?.({ stream: 'system', line: detail });
        // The installer may well have started; reporting `spawn-failed` would
        // claim otherwise. `failed` is the honest reading of "we lost track".
        return failure('failed');
      } finally {
        unsubscribe();
        options.signal?.removeEventListener('abort', cancel);
      }
    },
  };
}

export const installRunner = createInstallRunner();
