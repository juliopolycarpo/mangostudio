import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { settleWorker } from '../../lib/test-worker-settle';
import type { FixtureJob } from './fixture-windows-job';

export const FIXTURE_COMMAND_TIMEOUT_MS = 15_000;
export const FIXTURE_STOP_TIMEOUT_MS = 5_000;

export class FixtureSettlementError extends Error {
  override name = 'FixtureSettlementError';
}

/** Dispose task-owned handles while retaining any unknown settlement as an error.
 * @example disposeFixtureJob(job); // throws and retains storage when the census failed
 */
export function disposeFixtureJob(job: FixtureJob): void {
  let failure: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    try {
      if (!job.empty()) throw new Error('fixture Windows job remains nonempty; storage retained');
    } catch (error) {
      failure = error;
      try {
        job.stop();
      } catch (stopError) {
        cleanupErrors.push(stopError);
      }
    }
  } finally {
    try {
      job.close();
    } catch (closeError) {
      cleanupErrors.push(closeError);
    }
  }
  if (failure !== undefined || cleanupErrors.length)
    throw new FixtureSettlementError(
      `fixture Windows job settlement failed; storage retained: ${String(failure ?? 'native handle disposal failed')}${cleanupErrors.length ? `; cleanup errors: ${cleanupErrors.map(String).join('; ')}` : ''}`
    );
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface FixtureChild {
  readonly completed: Promise<CommandResult>;
  stop(): void;
}

export interface FixtureCommandHost {
  readonly settleUnix?: typeof settleWorker;
  start(
    cmd: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv
  ): FixtureChild | Promise<FixtureChild>;
  deadline(callback: () => void, ms: number): () => void;
}

export const fixtureCommandHost: FixtureCommandHost = {
  async start(cmd, cwd, env) {
    const settleUnix = this.settleUnix ?? settleWorker;
    const job =
      process.platform === 'win32'
        ? (await import('./fixture-windows-job')).createFixtureJob()
        : undefined;
    const child = spawn(
      process.execPath,
      [join(import.meta.dir, 'fixture-command-main.ts'), job?.name ?? '', ...cmd],
      {
        cwd,
        env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      stdout += data;
    });
    child.stderr.on('data', (data: string) => {
      stderr += data;
    });
    let stopped = false;
    const closed = new Promise<CommandResult>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode) => resolve({ stdout, stderr, exitCode: exitCode ?? 1 }));
    });
    const settleJob = async (): Promise<void> => {
      const until = performance.now() + FIXTURE_STOP_TIMEOUT_MS;
      while (job && !job.empty() && performance.now() < until) await Bun.sleep(10);
      if (job && !job.empty())
        throw new FixtureSettlementError(
          'fixture Windows job retained active processes; storage retained'
        );
    };
    const completed = closed
      .then(async (result) => {
        if (!job) {
          const leftovers = await settleUnix({
            who: { pgid: child.pid ?? null, token: '' },
            graceMs: FIXTURE_STOP_TIMEOUT_MS,
            pollMs: FIXTURE_STOP_TIMEOUT_MS,
          });
          if (!leftovers.length) return result;
          const remaining = await settleUnix({
            who: { pgid: child.pid ?? null, token: '' },
            graceMs: FIXTURE_STOP_TIMEOUT_MS,
            pollMs: FIXTURE_STOP_TIMEOUT_MS,
          });
          if (remaining.length)
            throw new FixtureSettlementError(
              `fixture process group retained ${remaining.length} processes; storage retained`
            );
          if (!stopped)
            return {
              ...result,
              exitCode: 1,
              stderr: `${result.stderr}\nfixture command left running descendants; terminated and settled`,
            };
          return result;
        }
        if (stopped) job.stop();
        try {
          await settleJob();
        } catch (error) {
          if (stopped) throw error;
          job.stop();
          await settleJob();
          return {
            ...result,
            exitCode: 1,
            stderr: `${result.stderr}\nfixture command left running descendants; terminated and settled`,
          };
        }
        return result;
      })
      .catch(async (error: unknown) => {
        if (!job)
          throw new FixtureSettlementError(
            `fixture process-group settlement failed; storage retained: ${String(error)}`
          );
        if (job) {
          child.kill('SIGKILL');
          job.stop();
          await settleJob();
        }
        throw error;
      })
      .finally(() => {
        if (job) disposeFixtureJob(job);
      });
    return {
      completed,
      stop() {
        stopped = true;
        if (!child.pid) return;
        if (process.platform === 'win32') {
          try {
            job?.stop();
          } finally {
            child.kill('SIGKILL');
          }
          return;
        }
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      },
    };
  },
  deadline(callback, ms) {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};

/**
 * Own fixture commands until their process and output pipes close, including after a deadline.
 * @example const commands = new FixtureCommands(); await commands.run(['git', 'status'], root);
 */
export class FixtureCommands {
  private readonly active = new Set<Promise<unknown>>();
  private unsettled: string | undefined;

  constructor(
    private readonly host: FixtureCommandHost = fixtureCommandHost,
    private readonly timeoutMs = FIXTURE_COMMAND_TIMEOUT_MS
  ) {}

  /** Run a bounded command; a timeout rejects only after its child settles. */
  run = (
    cmd: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv = process.env
  ): Promise<CommandResult> => {
    const operation = this.execute(cmd, cwd, env);
    this.active.add(operation);
    operation.then(
      () => this.active.delete(operation),
      () => this.active.delete(operation)
    );
    return operation;
  };

  private async execute(
    cmd: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv
  ): Promise<CommandResult> {
    const started = this.host.start(cmd, cwd, env);
    const child = started instanceof Promise ? await started : started;
    let timedOut = false;
    let stopError: unknown;
    let cancelStopDeadline: () => void = () => undefined;
    let rejectUnsettled: (error: Error) => void = () => undefined;
    const stopFailed = new Promise<never>((_, reject) => {
      rejectUnsettled = reject;
    });
    const cancelDeadline = this.host.deadline(() => {
      timedOut = true;
      try {
        child.stop();
      } catch (error) {
        stopError = error;
      }
      cancelStopDeadline = this.host.deadline(() => {
        this.unsettled = cmd.join(' ');
        rejectUnsettled(
          new FixtureSettlementError(
            `fixture command ${this.unsettled} did not settle within ${FIXTURE_STOP_TIMEOUT_MS}ms after stop; storage retained`
          )
        );
      }, FIXTURE_STOP_TIMEOUT_MS);
    }, this.timeoutMs);
    const operation = Promise.race([child.completed, stopFailed])
      .then((result) => {
        if (timedOut)
          throw new Error(
            `fixture command ${cmd.join(' ')} exceeded ${this.timeoutMs}ms${stopError ? `; stop failed: ${String(stopError)}` : ''}`
          );
        return result;
      })
      .finally(() => {
        cancelDeadline();
        cancelStopDeadline();
      });
    try {
      return await operation;
    } catch (error) {
      if (error instanceof FixtureSettlementError) this.unsettled = cmd.join(' ');
      throw error;
    }
  }

  /** Wait before removing storage, even if the test runner abandoned the test body. */
  async settle(): Promise<void> {
    while (this.active.size) await Promise.allSettled([...this.active]);
    if (this.unsettled)
      throw new Error(`fixture command ${this.unsettled} remains unsettled; storage retained`);
  }
}
