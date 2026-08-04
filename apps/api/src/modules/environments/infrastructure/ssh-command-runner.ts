/**
 * Runs a constant shell script on an SSH host via a fresh `ssh` spawn.
 *
 * Own invocation — never multiplexed onto the live protocol connection. Values
 * travel as argv (`$1`…) or stdin; the script itself is always a code-defined
 * constant. Leading-dash refusal for host/user/identity is already enforced by
 * {@link SshEnvironmentConfigSchema}.
 */

import { spawn } from 'node:child_process';
import {
  quoteForRemoteShell,
  SSH_FORCED_OPTIONS,
  type SshEnvironmentConfig,
  sshDestination,
} from '@mangostudio/shared/environments';
import type {
  RuntimeCommandOptions,
  RuntimeCommandResult,
  RuntimeCommandRunner,
} from '../domain/runtime-push';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const STDIN_CHUNK_BYTES = 64 * 1024;

export function createSshCommandRunner(config: SshEnvironmentConfig): RuntimeCommandRunner {
  return (script, options) => runOverSsh(config, script, options);
}

/**
 * One remote command string for OpenSSH's login-shell join: `sh -c <script> sh
 * <args…>`, with every word quoted so spaces/metacharacters in a multi-statement
 * script stay one `-c` operand and positional `$1`… still arrive intact.
 */
export function buildSshRemoteCommand(script: string, args: readonly string[] = []): string {
  return ['sh', '-c', quoteForRemoteShell(script), 'sh', ...args.map(quoteForRemoteShell)].join(
    ' '
  );
}

function runOverSsh(
  config: SshEnvironmentConfig,
  script: string,
  options: RuntimeCommandOptions = {}
): Promise<RuntimeCommandResult> {
  const args = [
    ...SSH_FORCED_OPTIONS,
    ...(config.identityFile ? ['-o', 'IdentitiesOnly=yes', '-i', config.identityFile] : []),
    ...(config.port ? ['-p', String(config.port)] : []),
    '-T',
    '--',
    sshDestination(config),
    // OpenSSH joins argv after the destination into one remote command; pass a
    // single already-quoted string the way {@link sshLaunchCommand} does.
    buildSshRemoteCommand(script, options.args ?? []),
  ];

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      resolve({ stdout: '', stderr: '', exitCode: 1, signal: 'SIGKILL' });
      return;
    }

    const child = spawn('ssh', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);

    const onAbort = () => {
      child.kill('SIGKILL');
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (result: RuntimeCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= MAX_OUTPUT_BYTES) return;
      const slice = chunk.subarray(0, Math.max(0, MAX_OUTPUT_BYTES - stdoutBytes));
      stdoutBytes += slice.length;
      stdout += slice.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes >= MAX_OUTPUT_BYTES) return;
      const slice = chunk.subarray(0, Math.max(0, MAX_OUTPUT_BYTES - stderrBytes));
      stderrBytes += slice.length;
      stderr += slice.toString('utf8');
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code, signal) => {
      finish({
        stdout,
        stderr,
        exitCode: code ?? 1,
        ...(signal ? { signal } : {}),
      });
    });

    void writeStdin(child, options).catch((error) => {
      child.kill('SIGKILL');
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

async function writeStdin(
  child: ReturnType<typeof spawn>,
  options: RuntimeCommandOptions
): Promise<void> {
  const stdin = child.stdin;
  if (!stdin) return;
  const bytes = options.stdin;
  if (!bytes || bytes.byteLength === 0) {
    stdin.end();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    // One `error` listener for the whole write, held in a promise the drain
    // waits race against. Registering a fresh `once('error')` inside each drain
    // wait would leak one listener per wait — a 95 MB push drains hundreds of
    // times, which is a MaxListenersExceededWarning and a pile of retained
    // closures, not a theoretical concern.
    let failed: Error | null = null;
    let raiseFailure: ((error: Error) => void) | undefined;
    const failure = new Promise<never>((_, rejectFailure) => {
      raiseFailure = (error: Error) => {
        failed ??= error;
        rejectFailure(error);
      };
    });
    // Nothing else awaits `failure` when the write finishes cleanly.
    failure.catch(() => undefined);

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      stdin.off('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error) => {
      raiseFailure?.(error);
      finish(error);
    };
    // Persistent for the whole write loop — EPIPE after a successful write()
    // would otherwise become an uncaught exception when only drain had a listener.
    stdin.on('error', onError);

    void (async () => {
      try {
        let offset = 0;
        while (offset < bytes.byteLength) {
          if (options.signal?.aborted) {
            finish(new Error('SSH stdin write cancelled.'));
            return;
          }
          const end = Math.min(offset + STDIN_CHUNK_BYTES, bytes.byteLength);
          const chunk = bytes.subarray(offset, end);
          offset = end;
          const canContinue = stdin.write(chunk);
          options.onStdinProgress?.(offset);
          if (!canContinue) {
            // Racing the shared failure promise keeps the loop from hanging if
            // `drain` never arrives after EPIPE, without a per-wait listener.
            await Promise.race([
              new Promise<void>((drainResolve) => stdin.once('drain', drainResolve)),
              failure,
            ]);
          }
          if (failed) return;
        }
        if (settled) return;
        stdin.end();
        finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });
}
