// The content of the `mangostudio-runtime` the API tests spawn, as a Turbo
// cache-key input.
//
// `test:unit` is a cached task, and Turbo hashes the *path* in
// `MANGOSTUDIO_RUNTIME_BINARY` (the task allows `MANGOSTUDIO_*`), never the file
// behind it; a default `target/debug` build is not in the key at all. So a
// rebuilt or replaced binary replayed the pass recorded against the old one.
// `scripts/test.ts` exports the SHA-256 of the binary the tests will spawn as
// `RUNTIME_BINARY_DIGEST_ENV`, which that allowlist puts into the key. Nothing
// in the hub reads the variable; it exists only to move the hash.

import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ROOT_DIR } from './config';
import { cargoTargetDir } from './runtime-build';

/** The test-lane variable carrying the digest. The hub never reads it. */
export const RUNTIME_BINARY_DIGEST_ENV = 'MANGOSTUDIO_RUNTIME_BINARY_SHA256';

type Env = Readonly<Record<string, string | undefined>>;

/** The cargo profiles a source checkout may have built, in tie-break order. */
const BUILD_PROFILES = ['debug', 'release'] as const;

/** Modification time of a regular file, or null when there is no file to run. */
function builtAtMs(path: string): number | null {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.mtimeMs : null;
  } catch {
    return null;
  }
}

/**
 * The runtime binary the API tests spawn, or null when there is none to digest.
 *
 * It follows the resolution the tests and the hub share
 * (`resolveRustRuntimeBinary`, `resolveRuntimeLaunchCommand`): an explicit
 * `MANGOSTUDIO_RUNTIME_BINARY` first — a relative one from `apps/api`, where
 * `bun test` runs — otherwise the newest of `target/debug` and `target/release`
 * under `CARGO_TARGET_DIR`, debug on a tie. A named binary that is not a file
 * resolves to null rather than to a default build: the tests report that
 * themselves, and digesting something else would hide it. The parity cases in
 * `scripts/tests/runtime-binary-digest.unit.test.ts` fail if the hub's
 * resolution moves.
 *
 * @example
 * resolveLaneRuntimeBinary({}, '/repo'); // '/repo/target/debug/mangostudio-runtime' or null
 */
export function resolveLaneRuntimeBinary(
  env: Env = process.env,
  rootDir: string = ROOT_DIR,
  platform: NodeJS.Platform = process.platform
): string | null {
  const override = env.MANGOSTUDIO_RUNTIME_BINARY?.trim();
  if (override) {
    const named = resolve(rootDir, 'apps', 'api', override);
    return builtAtMs(named) === null ? null : named;
  }

  const binaryName = platform === 'win32' ? 'mangostudio-runtime.exe' : 'mangostudio-runtime';
  const targetDir = cargoTargetDir(rootDir, env);
  let newest: { readonly path: string; readonly mtimeMs: number } | null = null;
  for (const profile of BUILD_PROFILES) {
    const path = join(targetDir, profile, binaryName);
    const mtimeMs = builtAtMs(path);
    if (mtimeMs === null) continue;
    if (newest === null || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
  }
  return newest?.path ?? null;
}

/**
 * Lowercase hex SHA-256 of a file's bytes, streamed so a 150 MB binary is never
 * held whole. Rejects naming the path and the shape it expected.
 *
 * @example
 * await sha256OfFile('/repo/target/debug/mangostudio-runtime'); // 'ba7816bf…'
 */
export async function sha256OfFile(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  try {
    for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  } catch (caught) {
    const reason = caught instanceof Error ? caught.message : String(caught);
    throw new Error(`Cannot digest runtime binary '${path}'; expected a readable file: ${reason}`);
  }
  return hasher.digest('hex');
}

/**
 * The environment entry that keys the cached API unit tests on the runtime
 * binary's content: `{ MANGOSTUDIO_RUNTIME_BINARY_SHA256: <hex> }`, or `{}` when
 * there is no binary, which leaves the lane exactly as it was — the tests then
 * skip or fail with their own message. Computed once, before Turbo starts, from
 * the file's bytes: the path and mtime are not part of it.
 *
 * @example
 * const unitEnv = { ...laneEnv, ...(await runtimeBinaryDigestEnv()) };
 */
export async function runtimeBinaryDigestEnv(
  env: Env = process.env,
  rootDir: string = ROOT_DIR
): Promise<Record<string, string>> {
  const binary = resolveLaneRuntimeBinary(env, rootDir);
  if (binary === null) return {};
  return { [RUNTIME_BINARY_DIGEST_ENV]: await sha256OfFile(binary) };
}
