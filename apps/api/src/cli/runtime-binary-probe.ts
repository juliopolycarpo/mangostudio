/**
 * Probes the `mangostudio-runtime` binary that ships beside the hub executable.
 * Doctor reports it because stdio environments spawn it, and a version drift
 * between the two is refused at the protocol handshake.
 */

import { existsSync } from 'node:fs';
import { getRuntimeBinaryPath } from '../lib/runtime-paths';

const VERSION_PROBE_TIMEOUT_MS = 5_000;

export interface RuntimeBinaryProbe {
  /** Absolute path that was checked; null when running from a source checkout. */
  readonly path: string | null;
  readonly present: boolean;
  readonly version: string | null;
  readonly error: string | null;
}

/** Reads the sibling runtime binary's version, or explains why it could not. */
export async function probeRuntimeBinary(): Promise<RuntimeBinaryProbe> {
  const path = getRuntimeBinaryPath();
  if (!path) return { path: null, present: false, version: null, error: null };
  if (!existsSync(path)) return { path, present: false, version: null, error: null };

  const child = Bun.spawn([path, '--version'], { stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => child.kill(), VERSION_PROBE_TIMEOUT_MS);
  try {
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (exitCode !== 0) {
      return { path, present: true, version: null, error: `exited with code ${exitCode}` };
    }
    const version = stdout.trim();
    return version
      ? { path, present: true, version, error: null }
      : { path, present: true, version: null, error: 'printed no version' };
  } catch (error) {
    return {
      path,
      present: true,
      version: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}
