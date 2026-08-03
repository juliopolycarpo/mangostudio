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
    // Remote login shell runs the constant script with positional args.
    'sh',
    '-c',
    script,
    'sh',
    ...(options.args ?? []),
  ];

  return new Promise((resolve, reject) => {
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

    const finish = (result: RuntimeCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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

  let offset = 0;
  while (offset < bytes.byteLength) {
    const end = Math.min(offset + STDIN_CHUNK_BYTES, bytes.byteLength);
    const chunk = bytes.subarray(offset, end);
    offset = end;
    const canContinue = stdin.write(chunk);
    options.onStdinProgress?.(offset);
    if (!canContinue) {
      await new Promise<void>((resolve, reject) => {
        const onDrain = () => {
          stdin.off('error', onError);
          resolve();
        };
        const onError = (error: Error) => {
          stdin.off('drain', onDrain);
          reject(error);
        };
        stdin.once('drain', onDrain);
        stdin.once('error', onError);
      });
    }
  }
  stdin.end();
}
