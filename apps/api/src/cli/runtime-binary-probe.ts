/**
 * Probes the `mangostudio-runtime` binary the hub launches for Local: the
 * `MANGOSTUDIO_RUNTIME_BINARY` override, the sibling beside a standalone hub,
 * or a source checkout's newest cargo build. Doctor reports it because Local
 * cannot start without it, and a version drift between the two is refused at
 * the protocol handshake.
 */

import { existsSync } from 'node:fs';
import { HIDDEN_WINDOW } from '@mangostudio/shared/process';
import { locateLocalRuntimeBinary } from '../lib/runtime-paths';
import { readVersionProcess, type VersionProbeProcess } from './version-probe-process';

export interface RuntimeVersionProcess extends VersionProbeProcess {
  readonly stdout: ReadableStream<Uint8Array>;
}

function spawnRuntimeVersion(path: string): RuntimeVersionProcess {
  return Bun.spawn([path, '--version'], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
    ...HIDDEN_WINDOW,
  });
}

export interface RuntimeBinaryProbe {
  /** Absolute path that was checked; null when a source checkout has no build. */
  readonly path: string | null;
  readonly present: boolean;
  readonly version: string | null;
  readonly error: string | null;
}

/**
 * Reads the Local runtime binary's version, or explains why it could not. The
 * path is a parameter so tests can point it at a file with a known problem; it
 * defaults to the binary the hub would actually spawn.
 *
 * @example
 * const probe = await probeRuntimeBinary(); // { path: '…/mangostudio-runtime', present: true, version: '0.1.1', error: null }
 */
export async function probeRuntimeBinary(
  path: string | null = locateLocalRuntimeBinary(),
  spawn: (path: string) => RuntimeVersionProcess = spawnRuntimeVersion
): Promise<RuntimeBinaryProbe> {
  if (!path) return { path: null, present: false, version: null, error: null };
  if (!existsSync(path)) return { path, present: false, version: null, error: null };

  // The path existing does not make it runnable — it can be a directory, have
  // lost its executable bit, or not be an executable format at all. Bun.spawn
  // reports those by throwing here, before any of the work below, and doctor
  // exists to report that as a finding rather than die on it.
  let child: RuntimeVersionProcess;
  try {
    child = spawn(path);
  } catch (error) {
    return { path, present: true, version: null, error: describeError(error) };
  }

  try {
    const { text: stdout, exitCode } = await readVersionProcess(
      child,
      child.stdout,
      'runtime --version'
    );
    if (exitCode !== 0) {
      return { path, present: true, version: null, error: `exited with code ${exitCode}` };
    }
    const version = stdout.trim();
    return version
      ? { path, present: true, version, error: null }
      : { path, present: true, version: null, error: 'printed no version' };
  } catch (error) {
    return { path, present: true, version: null, error: describeError(error) };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
