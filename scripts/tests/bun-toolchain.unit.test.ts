// Guards the two fields that name the Bun toolchain, and the resolver that
// decides who downloads a cross-compile runtime.
//
// Every one of these broke once, on the `canary` channel the repo tracked until
// Bun 1.4.0 shipped: `packageManager: "bun@canary"` stopped Turborepo resolving
// the workspace at all, and `Bun.version` reporting a bare `1.4.0` sent
// `--compile` looking for a release tag that did not exist. Those failures
// surfaced on a runner, minutes into a distribution build. These tests move them
// to `bun run check`, where the feedback costs seconds — and they stay after the
// pin, because the pin is exactly what they now assert.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BUN_RUNTIME_ASSETS,
  bunCompiledRuntimes,
  bunCrossCompileChannel,
  hostReleasePlatform,
} from '../lib/bun-cross-runtime';
import { ROOT_DIR } from '../lib/config';
import { ALL_BINARY_TARGETS } from '../lib/release-targets';
import { readText } from './support/read-text';

/**
 * Turborepo 2.x parses `packageManager` with this, and refuses to resolve the
 * workspace at all when it does not match — not a warning, a hard stop. Copied
 * from the error it prints so the failure here reads like the real one.
 */
const TURBO_PACKAGE_MANAGER =
  /^(?:aube|bun|npm|nub|pnpm|yarn)@(?:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?|https?:\/\/\S+)$/;

async function withVersionFile<T>(
  contents: string | null,
  run: (path: string) => Promise<T>
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'bun-version-'));
  try {
    const path = join(dir, '.bun-version');
    if (contents !== null) writeFileSync(path, contents);
    return await run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Bun toolchain pins', () => {
  test('packageManager stays parseable by Turborepo', () => {
    const { packageManager } = JSON.parse(readText('package.json')) as {
      packageManager?: string;
    };

    expect(packageManager).toBeDefined();
    // `bun@canary` matches neither branch, which is why a channel can only ever
    // live in `.bun-version`. Keep this field version-shaped.
    expect(packageManager).toMatch(TURBO_PACKAGE_MANAGER);
  });

  test('.bun-version names exactly one thing, on one line', () => {
    const raw = readText('.bun-version');

    expect(raw.trim()).not.toBe('');
    expect(raw.trim().split(/\s+/)).toHaveLength(1);
  });

  test('both fields name the same Bun while the pin is a released version', () => {
    // They were allowed to disagree on `canary`, because they had to: setup-bun
    // could only be given the literal channel tag and Turborepo refuses to parse
    // it. A released pin removes that excuse, and one field bumped without the
    // other is now a plain mistake — CI installing a Bun the workspace floor
    // does not describe, with nothing else in the repo to notice.
    const { packageManager } = JSON.parse(readText('package.json')) as {
      packageManager?: string;
    };

    expect(packageManager).toBe(`bun@${readText('.bun-version').trim()}`);
  });

  test('every setup-bun call site reads .bun-version, never package.json', () => {
    // package.json's `packageManager` is a Turborepo floor marker and does not
    // name an installable build; a call site left pointing at it would ask for a
    // release tag that has never existed.
    //
    // Every workflow and composite action is scanned rather than a listed few:
    // the regression this guards against is a *new* call site copying the old
    // `bun-version-file: package.json`, which a hardcoded list cannot see.
    const files = [
      ...new Bun.Glob('**/*.{yml,yaml}').scanSync({ cwd: join(ROOT_DIR, '.github') }),
    ].sort();

    let seen = 0;
    for (const file of files) {
      for (const match of readText(join('.github', file)).matchAll(/bun-version-file:\s*(\S+)/g)) {
        seen++;
        expect(match[1], file).toBe('.bun-version');
      }
    }
    // Every `oven-sh/setup-bun` step must name the file; a step that stops
    // doing so would otherwise leave this test scanning nothing and passing.
    const callSites = files.reduce(
      (total, file) =>
        total +
        [...readText(join('.github', file)).matchAll(/uses:\s*oven-sh\/setup-bun@/g)].length,
      0
    );
    expect(callSites).toBeGreaterThan(0);
    expect(seen).toBe(callSites);
  });

  test('the install cache is keyed on the revision, not the version', () => {
    // `--version` is unique per release and would work today. `--revision`
    // stays correct for a rebuilt tag or a channel too, which is the state this
    // repo spent three months in, and costs nothing to keep.
    const action = readText('.github/actions/setup-mango/action.yml');

    expect(action).toContain('bun --revision');
    expect(action).not.toMatch(/\$\(bun --version\)/);
  });
});

describe('Bun cross-compile runtime', () => {
  test('reads a channel from .bun-version and ignores a released version', async () => {
    // A released version has a download `--compile` can resolve on its own, so
    // the resolver must stay out of the way and leave that path untouched.
    for (const released of ['1.3.14', 'v1.3.14', '1.4.0-canary.1', '1.4.0+build.5']) {
      expect(await withVersionFile(released, bunCrossCompileChannel), released).toBeNull();
    }

    for (const channel of ['canary', 'canary\n', '  canary  ']) {
      expect(await withVersionFile(channel, bunCrossCompileChannel)).toBe('canary');
    }

    expect(await withVersionFile('', bunCrossCompileChannel)).toBeNull();
    expect(await withVersionFile(null, bunCrossCompileChannel)).toBeNull();
  });

  test('the repository pins a released Bun, so nothing fetches a runtime', async () => {
    // Not a preference — a statement of the state the rest of this file guards.
    // Null here is what makes the fetcher below dormant: `--compile` resolves
    // `bun-v<Bun.version>` on its own and no target downloads anything. Naming a
    // channel in `.bun-version` again flips this, and the download path it
    // re-enables has no CI lane left to cover it.
    expect(await bunCrossCompileChannel()).toBeNull();
  });

  test('every release target has a Bun asset to download', () => {
    // The map's `Record<ReleasePlatformId, string>` type already makes a missing
    // key a compile error, so what is left to check is the value: a wrong asset
    // name is a 404 on a runner, not a type error.
    for (const target of ALL_BINARY_TARGETS) {
      expect(BUN_RUNTIME_ASSETS[target.arch], target.arch).toMatch(/^bun-[a-z0-9-]+$/);
    }
    expect(Object.keys(BUN_RUNTIME_ASSETS).sort()).toEqual(
      ALL_BINARY_TARGETS.map((target) => target.arch).sort()
    );
  });

  test('arm64 targets map to Bun aarch64 assets', () => {
    // The one substitution that is easy to get wrong and produces a 404 rather
    // than a type error.
    expect(BUN_RUNTIME_ASSETS['linux-arm64']).toBe('bun-linux-aarch64');
    expect(BUN_RUNTIME_ASSETS['linux-arm64-musl']).toBe('bun-linux-aarch64-musl');
    expect(BUN_RUNTIME_ASSETS['darwin-arm64']).toBe('bun-darwin-aarch64');
    expect(BUN_RUNTIME_ASSETS['windows-arm64']).toBe('bun-windows-aarch64');
  });

  test('the host resolves to a release platform or to nothing', () => {
    const host = hostReleasePlatform();
    if (host === null) return;

    expect(ALL_BINARY_TARGETS.map((target) => target.arch)).toContain(host);
  });

  test('every target carries the host runtime on a released Bun', async () => {
    // `--compile` downloads the build matching `Bun.version`, so nothing is
    // fetched per target and there is nothing to drift against.
    const runtimes = await bunCompiledRuntimes(null);

    expect(Object.keys(runtimes).sort()).toEqual(ALL_BINARY_TARGETS.map((t) => t.arch).sort());
    for (const [id, runtime] of Object.entries(runtimes)) {
      expect(runtime, id).toEqual({
        source: 'host',
        revision: Bun.revision,
        sha256: null,
        tagAdvanced: false,
      });
    }
  });

  test('the host revision is the spelling the provenance records', async () => {
    // `bun --revision` prints `1.4.0+34cbb9a40` while the API returns the full
    // sha. Recording the flag's spelling made the old drift warning fire on
    // every build, against a runtime that had not drifted at all.
    expect(Bun.revision).toMatch(/^[0-9a-f]{40}$/);

    const runtimes = await bunCompiledRuntimes(await bunCrossCompileChannel());
    const host = hostReleasePlatform();
    if (host === null) return; // unidentifiable host; nothing claims to be it

    expect(runtimes[host]?.revision).toBe(Bun.revision);
  });

  test('targets with nothing fetched are absent rather than invented', async () => {
    // This runs at the end of a successful build and must never be the reason
    // one fails, so a cold cache answers with the host's target alone: every
    // foreign runtime is unknown, and saying so is the point.
    const runtimes = await bunCompiledRuntimes('canary', {
      cacheDir: join(tmpdir(), 'bun-cross-absent'),
      cacheKey: 'nothing-installed-here',
    });

    const host = hostReleasePlatform();
    expect(Object.keys(runtimes)).toEqual(host === null ? [] : [host]);
  });
});
