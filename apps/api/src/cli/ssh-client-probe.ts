/**
 * Probes the system `ssh` client the hub launches SSH environments through.
 *
 * Doctor reports it because there is no fallback: SSH environments are the one
 * transport whose launcher is a program the hub does not ship. A Windows host
 * is the case worth naming — OpenSSH is an optional feature there, so a hub
 * that works in every other respect can still be unable to start one.
 */

import { HIDDEN_WINDOW } from '@mangostudio/shared/process';

import { readVersionProcess, type VersionProbeProcess } from './version-probe-process';

export interface SshClientProbe {
  /** Resolved executable, or null when nothing named `ssh` is on PATH. */
  readonly path: string | null;
  readonly version: string | null;
  readonly error: string | null;
}

export interface SshClientProcess extends VersionProbeProcess {
  readonly stderr: ReadableStream<Uint8Array>;
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

  try {
    const { text, exitCode } = await readVersionProcess(child, child.stderr, 'ssh -V');
    const version = text.trim().split(/\r?\n/)[0]?.trim() ?? '';
    // OpenSSH prints its banner on stderr and exits 0. Leftover error text
    // from a wrong binary or unsupported option is not a version string.
    if (exitCode !== 0) {
      return { path, version: null, error: version || `exited with code ${exitCode}` };
    }
    return version
      ? { path, version, error: null }
      : { path, version: null, error: 'printed no version' };
  } catch (error) {
    return { path, version: null, error: describeError(error) };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
