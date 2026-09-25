/**
 * Locates and drives the real, compiled `mangostudio-runtime` binary for the
 * hub-to-Rust-binary qualification suite.
 *
 * `MANGOSTUDIO_RUNTIME_BINARY` names the exact binary CI just built, the same
 * variable `resolveRuntimeLaunchCommand` reads in production. Outside CI this
 * falls back to the workspace's newest cargo build, resolved exactly as
 * production resolves it, so `cargo build -p mangostudio-runtime` followed by
 * the workspace's own test command exercises the same suite locally. An explicit env var pointing at a
 * binary that does not exist is a broken CI job, not a reason to skip
 * quietly — only the fallback path is missing-tolerant.
 *
 * The fallback's own tolerance is for a developer who has not run cargo yet.
 * CI never relies on it: every lane that starts a hub — the `bun run test`
 * shards (`.github/workflows/test.yml`), the browser smoke, and
 * `cargo-shim.yml`'s `real-binary-qualification` job — sets the override to a
 * binary it built or downloaded (`.github/actions/local-runtime`), because the
 * hub launches Local as this binary and there is no runtime to fall back to.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newestRuntimeBuild, workspaceRuntimeBinaryCandidates } from '../../src/lib/runtime-paths';

/**
 * The workspace builds production would launch in a source checkout, so a
 * test and the hub it drives pick the same binary: the newest of
 * `target/debug` and `target/release`, debug on a tie.
 */
const WORKSPACE_BUILDS = workspaceRuntimeBinaryCandidates();

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
  const built = newestRuntimeBuild(WORKSPACE_BUILDS);
  return built
    ? { path: built, available: true }
    : { path: WORKSPACE_BUILDS[0] as string, available: false };
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
  // Bare `<version>`, the same line the TypeScript runtime prints.
  const match = /^(\S+)$/.exec(stdout.trim());
  if (!match) {
    throw new Error(`Could not parse a version from "${binaryPath} --version": ${stdout}`);
  }
  return match[1];
}

const announcedSkips = new Set<string>();

/**
 * True when `binary` is missing, after saying so on stderr once per suite, so
 * a lane without the Rust build reports which cases it did not run instead of
 * passing silently.
 *
 * @example
 * it.skipIf(skipWithoutRustBinary(binary, 'terminal-socket'))('relays a PTY', async () => { ... });
 */
export function skipWithoutRustBinary(binary: RustRuntimeBinary, suite: string): boolean {
  if (binary.available) return false;
  if (!announcedSkips.has(suite)) {
    announcedSkips.add(suite);
    console.warn(
      `[rust-runtime] skipping the Rust-backed cases of ${suite}: no binary at ${binary.path}. ` +
        'Build it with "cargo build -p mangostudio-runtime --locked" or set MANGOSTUDIO_RUNTIME_BINARY; ' +
        'CI runs them in cargo-shim.yml real-binary-qualification.'
    );
  }
  return true;
}
