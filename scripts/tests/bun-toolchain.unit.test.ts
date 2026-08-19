// Guards the assumptions the floating `canary` channel rests on.
//
// Every one of these has already broken once. `packageManager: "bun@canary"`
// stopped Turborepo resolving the workspace at all; `Bun.version` reporting a
// bare `1.4.0` sent `--compile` looking for a release tag that does not exist.
// Those failures surfaced on a runner, minutes into a distribution build. These
// tests move them to `bun run check`, where the feedback costs seconds.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  bunCompileRuntimeRevision,
  bunCrossCompileChannel,
  hostReleasePlatform,
} from '../lib/bun-cross-runtime';
import { ALL_BINARY_TARGETS, type ReleasePlatformId } from '../lib/release-targets';
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
    // `bun@canary` matches neither branch, which is why the channel lives in
    // `.bun-version` instead. Keep this field version-shaped.
    expect(packageManager).toMatch(TURBO_PACKAGE_MANAGER);
  });

  test('.bun-version names exactly one thing, on one line', () => {
    const raw = readText('.bun-version');

    expect(raw.trim()).not.toBe('');
    expect(raw.trim().split(/\s+/)).toHaveLength(1);
  });

  test('every setup-bun call site reads .bun-version, never package.json', () => {
    // package.json's `packageManager` is a Turborepo floor marker and does not
    // name an installable build; a call site left pointing at it would ask for a
    // release tag that has never existed.
    const sites = [
      '.github/actions/setup-mango/action.yml',
      '.github/workflows/ci.yml',
      '.github/workflows/smoke-binary.yml',
      '.github/workflows/release-dry-run.yml',
      '.github/workflows/cargo-shim.yml',
    ];

    let seen = 0;
    for (const file of sites) {
      const text = readText(file);
      for (const match of text.matchAll(/bun-version-file:\s*(\S+)/g)) {
        seen++;
        expect(match[1], file).toBe('.bun-version');
      }
    }
    expect(seen).toBeGreaterThanOrEqual(sites.length);
  });

  test('the install cache is keyed on the revision, not the version', () => {
    // Every canary build reports the same `1.4.0-canary.1` from `--version`.
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

  test('the repository currently tracks a channel', async () => {
    // Not a preference — a statement of the state the rest of this file guards.
    // When a release carrying the fixes lands and `.bun-version` becomes a
    // version, this flips and the cross-runtime download stops being reachable.
    expect(await bunCrossCompileChannel()).toBe('canary');
  });

  test('every release target has a Bun asset to download', () => {
    // The asset map is the thing a new release platform silently misses. Bun
    // spells arm64 `aarch64`, so it cannot be derived from the platform id, and
    // a missing entry only shows up as a failed cross-compile on a runner.
    const source = readText('scripts/lib/bun-cross-runtime.ts');
    const mapped = new Set(
      [...source.matchAll(/^ {2}'([a-z0-9-]+)':\s*'(bun-[a-z0-9-]+)',$/gm)].map(
        (match) => match[1] as ReleasePlatformId
      )
    );

    for (const target of ALL_BINARY_TARGETS) {
      expect(mapped.has(target.arch), `no Bun asset mapped for ${target.arch}`).toBe(true);
    }
    expect(mapped.size).toBe(ALL_BINARY_TARGETS.length);
  });

  test('arm64 targets map to Bun aarch64 assets', () => {
    // The one substitution that is easy to get wrong and produces a 404 rather
    // than a type error.
    const source = readText('scripts/lib/bun-cross-runtime.ts');

    expect(source).toContain("'linux-arm64': 'bun-linux-aarch64'");
    expect(source).toContain("'darwin-arm64': 'bun-darwin-aarch64'");
    expect(source).toContain("'windows-arm64': 'bun-windows-aarch64'");
  });

  test('the host resolves to a release platform or to nothing', () => {
    const host = hostReleasePlatform();
    if (host === null) return;

    expect(ALL_BINARY_TARGETS.map((target) => target.arch)).toContain(host);
  });

  test('the compile revision is the host revision on a released Bun', async () => {
    // `--compile` downloads the build matching `Bun.version`, so there is
    // nothing to drift against.
    expect(await bunCompileRuntimeRevision(null)).toBe(Bun.revision);
  });

  test('the compile revision is comparable to Bun.revision', async () => {
    // The drift check compares this against `Bun.revision`, so it has to be the
    // same spelling. `bun --revision` prints `1.4.0-canary.1+32e87032b` while
    // the API returns the full sha — reading the flag made the warning fire on
    // every build, against a runtime that had not drifted at all.
    expect(Bun.revision).toMatch(/^[0-9a-f]{40}$/);

    const compiled = await bunCompileRuntimeRevision(await bunCrossCompileChannel());
    if (compiled === null) return; // cold cache; nothing fetched to ask

    expect(compiled).toMatch(/^[0-9a-f]{40}$/);
  });

  test('an unresolvable compile revision reports nothing rather than throwing', async () => {
    // The drift check runs at the end of a successful build. It must never be
    // the reason a build fails, so a cold cache answers null and the caller
    // skips the comparison.
    const revision = await bunCompileRuntimeRevision('canary', {
      cacheDir: join(tmpdir(), 'bun-cross-absent'),
      cacheKey: 'nothing-installed-here',
    });

    expect(revision).toBeNull();
  });
});
