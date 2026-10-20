/**
 * Probes the system `ssh` client the hub launches SSH environments through.
 *
 * Doctor reports it because there is no fallback: SSH environments are the one
 * transport whose launcher is a program the hub does not ship. A Windows host
 * is the case worth naming — OpenSSH is an optional feature there, so a hub
 * that works in every other respect can still be unable to start one.
 */

import type { ReadableStreamDefaultReader } from 'node:stream/web';
import { HIDDEN_WINDOW } from '@mangostudio/shared/process';

const VERSION_PROBE_TIMEOUT_MS = 5_000;

export interface SshClientProbe {
  /** Resolved executable, or null when nothing named `ssh` is on PATH. */
  readonly path: string | null;
  readonly version: string | null;
  readonly error: string | null;
}

export interface SshClientProcess {
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(signal?: 'SIGKILL'): void;
}

/** Starts the exact executable doctor found, without invoking a shell. */
function spawnSshClient(path: string): SshClientProcess {
  return Bun.spawn([path, '-V'], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
    ...HIDDEN_WINDOW,
  });
}

/**
 * Reads the installed SSH client's version, retaining failures for doctor.
 *
 * @example
 * const client = await probeSshClient(); // { path: '/usr/bin/ssh', version: 'OpenSSH_...', error: null }
 */
export async function probeSshClient(
  path: string | null = Bun.which('ssh'),
  spawn: (path: string) => SshClientProcess = spawnSshClient
): Promise<SshClientProbe> {
  if (!path) return { path: null, version: null, error: null };

  let child: SshClientProcess;
  try {
    child = spawn(path);
  } catch (error) {
    return { path, version: null, error: describeError(error) };
  }

  const reader = child.stderr.getReader();
  let timedOut = false;
  let cancellation: Promise<void> | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
    // A descendant can retain stderr after ssh exits. Cancel our read as well
    // as killing the child, so that inherited pipe cannot strand doctor.
    cancellation = reader.cancel();
    void cancellation.catch(() => undefined);
  }, VERSION_PROBE_TIMEOUT_MS);
  try {
    const output = readProbeOutput(reader).catch((error) => {
      child.kill('SIGKILL');
      throw error;
    });
    // Retain ownership until both the pipe and the process have settled,
    // including after a read error or a deadline-triggered kill.
    const [stderr, exited] = await Promise.allSettled([output, child.exited]);
    if (timedOut) {
      return {
        path,
        version: null,
        error: `ssh -V timed out after ${VERSION_PROBE_TIMEOUT_MS} ms`,
      };
    }
    if (stderr.status === 'rejected') throw stderr.reason;
    if (exited.status === 'rejected') throw exited.reason;
    const version = stderr.value.trim().split(/\r?\n/)[0]?.trim() ?? '';
    // OpenSSH prints its banner on stderr and exits 0. Leftover error text
    // from a wrong binary or unsupported option is not a version string.
    if (exited.value !== 0) {
      return { path, version: null, error: version || `exited with code ${exited.value}` };
    }
    return version
      ? { path, version, error: null }
      : { path, version: null, error: 'printed no version' };
  } catch (error) {
    return { path, version: null, error: describeError(error) };
  } finally {
    clearTimeout(timeout);
    await cancellation?.catch(() => undefined);
    reader.releaseLock();
  }
}

async function readProbeOutput(
  reader: Pick<ReadableStreamDefaultReader<Uint8Array>, 'read'>
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
