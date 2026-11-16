/** Which runtime build a benchmark measures when no binary is named, and how to label one. */

import { stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Cargo profile directories under `target/` that a benchmark considers, in tie-break order. */
const WORKSPACE_BUILD_PROFILES = ['release', 'release-fast', 'debug'] as const;

const EXE = process.platform === 'win32' ? '.exe' : '';

/**
 * The most recently modified `mangostudio-runtime` among the profile directories under
 * `<repoRoot>/target`, or undefined. A later debug build wins over an older release one, so A/B runs
 * must name their binaries.
 *
 * @example
 * await newestWorkspaceBuild('/repo'); // → '/repo/target/release-fast/mangostudio-runtime'
 */
export async function newestWorkspaceBuild(
  repoRoot: string,
  exe: string = EXE
): Promise<string | undefined> {
  let newest: { path: string; mtimeMs: number } | undefined;
  for (const profile of WORKSPACE_BUILD_PROFILES) {
    const path = join(repoRoot, 'target', profile, `mangostudio-runtime${exe}`);
    const info = await stat(path).catch(() => undefined);
    if (info && (!newest || info.mtimeMs > newest.mtimeMs)) {
      newest = { path, mtimeMs: info.mtimeMs };
    }
  }
  return newest?.path;
}

/**
 * The cargo profile a `target/<profile>/` path names, or `unknown`. `release-fast` is named apart
 * so its numbers never read as the shipping profile's.
 *
 * @example
 * buildProfileOf('/repo/target/release-fast/mangostudio-runtime'); // → 'release-fast'
 */
export function buildProfileOf(binary: string): string {
  for (const profile of WORKSPACE_BUILD_PROFILES) {
    if (new RegExp(`[\\\\/]${profile}[\\\\/]`).test(binary)) return profile;
  }
  return 'unknown';
}
