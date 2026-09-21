/**
 * Locates and drives the real, compiled `mangostudio-runtime` binary for the
 * hub-to-Rust-binary qualification suite.
 *
 * `MANGOSTUDIO_RUNTIME_BINARY` names the exact binary CI just built, the same
 * variable `resolveRuntimeLaunchCommand` reads in production. Outside CI this
 * falls back to the workspace's own `target/debug/mangostudio-runtime`, so
 * `cargo build -p mangostudio-runtime` followed by the workspace's own test
 * command exercises the same suite locally. An explicit env var pointing at a
 * binary that does not exist is a broken CI job, not a reason to skip
 * quietly — only the fallback path is missing-tolerant.
 *
 * The fallback's own tolerance is deliberate, including in CI: the ordinary
 * `bun run test` lane (`.github/workflows/test.yml`) runs every apps/api
 * test, including these two qualification files, without ever building Rust
 * or setting this override — that lane has no Rust binary and is not
 * supposed to. Only `cargo-shim.yml`'s dedicated `real-binary-qualification`
 * job builds the binary and must set the override; that job's own workflow
 * definition is asserted in `ci-gate.unit.test.ts`, which is where "this job
 * forgot to wire it" actually gets caught — not here, where the check cannot
 * tell that job apart from every other CI lane that never needed a Rust
 * binary in the first place.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FALLBACK_DEBUG_BINARY = join(import.meta.dir, '../../../../target/debug/mangostudio-runtime');

export interface RustRuntimeBinary {
  readonly path: string;
  /** False only for the tolerant local-dev fallback; never for an explicit override. */
  readonly available: boolean;
}

/**
 * Resolves the real binary once per test file.
 *
 * @example
 * const binary = resolveRustRuntimeBinary();
 * it.skipIf(!binary.available)('...', async () => { ... });
 */
export function resolveRustRuntimeBinary(): RustRuntimeBinary {
  const configured = process.env.MANGOSTUDIO_RUNTIME_BINARY?.trim();
  if (configured) {
    if (!existsSync(configured)) {
      throw new Error(
        `MANGOSTUDIO_RUNTIME_BINARY is set to ${configured}, which does not exist. Build it ` +
          'first with "cargo build -p mangostudio-runtime --locked".'
      );
    }
    return { path: configured, available: true };
  }
  return { path: FALLBACK_DEBUG_BINARY, available: existsSync(FALLBACK_DEBUG_BINARY) };
}

/**
 * A scratch `MANGO_HOME`, isolated from the developer's real `~/.mango` — every
 * transport writes `runtime.json` and `audit.log` under it on first use.
 *
 * @example
 * const home = await scratchMangoHome('stdio');
 * try { ... } finally { await cleanupMangoHome(home); }
 */
export async function scratchMangoHome(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), `mango-rust-qualification-${prefix}-`));
}

export async function cleanupMangoHome(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true });
}

/**
 * The version this binary reports, read once via `--version` — needed
 * because `spawnRuntimeChild` defaults to refusing a runtime whose version
 * disagrees with the hub's own, and this binary ignores the `VERSION`
 * environment variable the TypeScript runtime reads instead.
 *
 * @example
 * const version = await rustRuntimeVersion('/path/to/mangostudio-runtime');
 */
export async function rustRuntimeVersion(binaryPath: string): Promise<string> {
  const proc = Bun.spawn([binaryPath, '--version'], { stdout: 'pipe', stderr: 'pipe' });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  const match = /^mangostudio-runtime (\S+)/.exec(stdout.trim());
  if (!match) {
    throw new Error(`Could not parse a version from "${binaryPath} --version": ${stdout}`);
  }
  return match[1];
}
