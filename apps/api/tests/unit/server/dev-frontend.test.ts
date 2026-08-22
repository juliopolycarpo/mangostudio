/**
 * The dev boot's staleness scan. `newestSourceMtime` decides whether
 * `bun run dev` rebuilds or reports the existing bundle as current, so a
 * subtree it fails to see is a stale bundle served as current — and a subtree
 * it wrongly *does* see (`dist/`) is a full rebuild on every API hot reload,
 * which `bun --watch` triggers on every `apps/api/src` save.
 *
 * The scan counts directory mtimes as well as file mtimes, because a deletion
 * advances nothing else. That makes the fixtures timestamp-sensitive in both
 * directions: see `holdDirs`.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BUILD_STATE_FILE } from '@mangostudio/shared/utils/dist-files';
import { distIsCurrent, newestSourceMtime, readBuildState } from '../../../src/server/dev-frontend';

/** Seconds since the epoch, so mtimes are far enough apart to compare. */
const OLD = 1_000_000;
const NEW = 2_000_000;

function writeAt(path: string, seconds: number): void {
  writeFileSync(path, 'x');
  utimesSync(path, seconds, seconds);
}

function writeBuildState(root: string, apiUrl: string, mode: 'dev' | 'production' = 'dev'): void {
  const path = join(root, 'dist', BUILD_STATE_FILE);
  writeFileSync(path, JSON.stringify({ apiUrl, mode }));
  utimesSync(path, NEW, NEW);
}

function sharedFixture(root: string): string {
  const shared = join(root, 'shared');
  mkdirSync(join(shared, 'src', 'i18n'), { recursive: true });
  writeAt(join(shared, 'package.json'), OLD);
  writeAt(join(shared, 'tsconfig.json'), OLD);
  writeAt(join(shared, 'src', 'index.ts'), OLD);
  utimesSync(join(shared, 'src', 'i18n'), OLD, OLD);
  utimesSync(join(shared, 'src'), OLD, OLD);
  return shared;
}

function dependencyFixture(root: string): string {
  const repository = join(root, 'repository');
  mkdirSync(repository);
  writeAt(join(repository, 'package.json'), OLD);
  writeAt(join(repository, 'bun.lock'), OLD);
  return repository;
}

function effectiveApiUrl(): string {
  return process.env.MANGO_API_URL || process.env.VITE_API_URL || '';
}

/**
 * Hold every counted directory at OLD.
 *
 * The scan counts directory mtimes as well as file mtimes — that is the only
 * signal a *deletion* produces — and mkdir, writeFile and rm all leave the
 * containing directory at wall-clock now, which would swamp OLD/NEW. Every
 * assertion about a file's mtime calls this first, so what it measures is the
 * file. The deletion test is the one that deliberately does not.
 */
function holdDirs(root: string): void {
  for (const directory of ['src', 'public']) {
    utimesSync(join(root, directory), OLD, OLD);
  }
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dev-frontend-'));
  mkdirSync(join(root, 'src', 'routes'), { recursive: true });
  mkdirSync(join(root, 'public'), { recursive: true });
  mkdirSync(join(root, 'dist', 'assets'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  utimesSync(join(root, 'src', 'routes'), OLD, OLD);
  holdDirs(root);
  return root;
}

describe('newestSourceMtime', () => {
  test('sees index.html, public/ and build config, not just src/', () => {
    const root = fixture();
    try {
      writeAt(join(root, 'src', 'main.tsx'), OLD);
      // Each of these was invisible to the old `src/`-only scan, so editing one
      // left `distIsCurrent()` reporting a stale bundle as current. The two
      // configs are inputs for non-obvious reasons — `Bun.build()` honours
      // tsconfig `paths`, and route generation reads `tsr.config.json` — which
      // is exactly why dropping either from the allowlist would go unnoticed.
      for (const path of [
        'index.html',
        'build.ts',
        'package.json',
        'tsconfig.json',
        'tsr.config.json',
        join('public', 'logo.svg'),
      ]) {
        writeAt(join(root, path), NEW);
        holdDirs(root);
        expect(newestSourceMtime(root)).toBe(NEW * 1000);
        rmSync(join(root, path));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('ignores dist/, so a rebuild cannot make the tree look newer than itself', () => {
    const root = fixture();
    try {
      writeAt(join(root, 'src', 'main.tsx'), OLD);
      writeAt(join(root, 'dist', 'index.html'), NEW);
      writeAt(join(root, 'dist', 'assets', 'index-abc123.js'), NEW);
      holdDirs(root);
      expect(newestSourceMtime(root)).toBe(OLD * 1000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('ignores node_modules, which is inert between installs', () => {
    const root = fixture();
    try {
      writeAt(join(root, 'src', 'main.tsx'), OLD);
      writeAt(join(root, 'node_modules', 'pkg', 'index.js'), NEW);
      holdDirs(root);
      expect(newestSourceMtime(root)).toBe(OLD * 1000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('ignores dist-metafile.json, which the build writes beside dist/ and not inside it', () => {
    const root = fixture();
    try {
      writeAt(join(root, 'src', 'main.tsx'), OLD);
      // The last write of every build, at the frontend root — so a `dist`-and-
      // `node_modules` denylist could not prune it, and counting it would make
      // `distIsCurrent()` false on every API restart while the watcher rebuilt
      // in a loop.
      writeAt(join(root, 'dist-metafile.json'), NEW);
      holdDirs(root);
      expect(newestSourceMtime(root)).toBe(OLD * 1000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('ignores workspace entries the bundler never reads', () => {
    const root = fixture();
    try {
      writeAt(join(root, 'src', 'main.tsx'), OLD);
      // None of these is a build input, and each one used to read as one: a
      // saved test or a turbo log left the tree newer than `dist/`, so the next
      // API hot reload rebuilt from scratch and the watcher fired a rebuild
      // that removed `dist/` out from under the running dev server. `bun run
      // check` — mandated after every change — writes the turbo logs.
      for (const path of [
        join('tests', 'unit', 'thing.test.tsx'),
        join('.turbo', 'turbo-typecheck.log'),
        join('.tanstack', 'tmp', 'scratch'),
        'AGENTS.md',
        'tsconfig.test.json',
        'turbo.json',
      ]) {
        mkdirSync(join(root, dirname(path)), { recursive: true });
        writeAt(join(root, path), NEW);
        holdDirs(root);
        expect(newestSourceMtime(root)).toBe(OLD * 1000);
        rmSync(join(root, path));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('ignores the generated route tree the build writes back into src/', () => {
    const root = fixture();
    try {
      writeAt(join(root, 'src', 'main.tsx'), OLD);
      writeAt(join(root, 'src', 'routeTree.gen.ts'), NEW);
      // `tsr generate` rewrites this file in place, which leaves `src/`'s own
      // mtime alone — so holding the directories at OLD is what the real build
      // does, not a convenience for the assertion.
      holdDirs(root);
      expect(newestSourceMtime(root)).toBe(OLD * 1000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('sees a deleted input, which advances no file mtime at all', () => {
    const root = fixture();
    try {
      // A route removed while `bun run dev` was stopped. Nothing under `src/`
      // gets a new file mtime — only `src/routes/` does — so a file-only scan
      // reported the newest *surviving* file, `distIsCurrent()` called the old
      // bundle current, and the next `bun run dev` served the deleted route.
      writeAt(join(root, 'src', 'routes', 'keep.tsx'), OLD);
      writeAt(join(root, 'src', 'routes', 'gone.tsx'), OLD);
      rmSync(join(root, 'src', 'routes', 'gone.tsx'));
      utimesSync(join(root, 'src', 'routes'), NEW, NEW);
      holdDirs(root);
      expect(newestSourceMtime(root)).toBe(NEW * 1000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('ignores directories the allowlist prunes, mtime included', () => {
    const root = fixture();
    try {
      writeAt(join(root, 'src', 'main.tsx'), OLD);
      // Counting directory mtimes must not reopen what the allowlist closed:
      // `dist/` is recreated by every build and `node_modules/` by every
      // install, and either one reading as an input is a rebuild loop.
      for (const directory of ['dist', join('dist', 'assets'), 'node_modules']) {
        utimesSync(join(root, directory), NEW, NEW);
      }
      holdDirs(root);
      expect(newestSourceMtime(root)).toBe(OLD * 1000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reports 0 for a directory that does not exist, which reads as stale', () => {
    expect(newestSourceMtime(join(tmpdir(), 'dev-frontend-absent-fixture'))).toBe(0);
  });
});

describe('distIsCurrent', () => {
  test('treats a shared source edit as stale', () => {
    const root = fixture();
    const shared = sharedFixture(root);
    const repository = dependencyFixture(root);
    try {
      writeAt(join(root, 'src', 'main.tsx'), OLD);
      writeAt(join(shared, 'src', 'i18n', 'en.ts'), OLD);
      writeAt(join(root, 'dist', 'index.html'), NEW);
      writeBuildState(root, effectiveApiUrl());
      holdDirs(root);
      utimesSync(join(shared, 'src', 'i18n'), OLD, OLD);
      utimesSync(join(shared, 'src'), OLD, OLD);

      expect(distIsCurrent(root, shared, repository)).toBe(true);

      writeAt(join(shared, 'src', 'i18n', 'en.ts'), NEW + 1);
      expect(distIsCurrent(root, shared, repository)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('treats shared package metadata changes as stale', () => {
    const root = fixture();
    const shared = sharedFixture(root);
    const repository = dependencyFixture(root);
    try {
      writeAt(join(root, 'src', 'main.tsx'), OLD);
      writeAt(join(root, 'dist', 'index.html'), NEW);
      writeBuildState(root, effectiveApiUrl());
      holdDirs(root);

      expect(distIsCurrent(root, shared, repository)).toBe(true);

      writeAt(join(shared, 'package.json'), NEW + 1);
      expect(distIsCurrent(root, shared, repository)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('treats root manifest and lockfile changes as stale dependency inputs', () => {
    const root = fixture();
    const shared = sharedFixture(root);
    const repository = dependencyFixture(root);
    try {
      writeAt(join(root, 'src', 'main.tsx'), OLD);
      writeAt(join(root, 'dist', 'index.html'), NEW);
      writeBuildState(root, effectiveApiUrl());
      holdDirs(root);

      expect(distIsCurrent(root, shared, repository)).toBe(true);

      writeAt(join(repository, 'bun.lock'), NEW + 1);
      expect(distIsCurrent(root, shared, repository)).toBe(false);

      writeAt(join(repository, 'bun.lock'), OLD);
      writeAt(join(repository, 'package.json'), NEW + 1);
      expect(distIsCurrent(root, shared, repository)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails closed when a required dependency input is missing', () => {
    const root = fixture();
    const shared = sharedFixture(root);
    const repository = dependencyFixture(root);
    try {
      writeAt(join(root, 'src', 'main.tsx'), OLD);
      writeAt(join(root, 'dist', 'index.html'), NEW);
      writeBuildState(root, effectiveApiUrl());
      holdDirs(root);

      expect(distIsCurrent(root, shared, repository)).toBe(true);

      rmSync(join(repository, 'bun.lock'));
      expect(distIsCurrent(root, shared, repository)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('requires index.html even when an emitted asset is current', () => {
    const root = fixture();
    const shared = sharedFixture(root);
    const repository = dependencyFixture(root);
    try {
      writeAt(join(root, 'src', 'main.tsx'), OLD);
      writeAt(join(root, 'dist', 'assets', 'index-abc123.js'), NEW);
      writeBuildState(root, effectiveApiUrl());
      holdDirs(root);

      expect(distIsCurrent(root, shared, repository)).toBe(false);

      writeAt(join(root, 'dist', 'index.html'), NEW);
      expect(distIsCurrent(root, shared, repository)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('requires a valid build state matching the effective API URL', () => {
    const root = fixture();
    const shared = sharedFixture(root);
    const repository = dependencyFixture(root);
    const originalApiUrl = process.env.MANGO_API_URL;
    const originalDeprecatedApiUrl = process.env.VITE_API_URL;
    try {
      process.env.MANGO_API_URL = 'https://current.example';
      process.env.VITE_API_URL = 'https://deprecated.example';
      writeAt(join(root, 'src', 'main.tsx'), OLD);
      writeAt(join(root, 'dist', 'index.html'), NEW);
      holdDirs(root);

      expect(distIsCurrent(root, shared, repository)).toBe(false);

      writeAt(join(root, 'dist', BUILD_STATE_FILE), NEW);
      expect(distIsCurrent(root, shared, repository)).toBe(false);

      writeBuildState(root, 'https://previous.example');
      expect(distIsCurrent(root, shared, repository)).toBe(false);

      writeBuildState(root, 'https://current.example');
      expect(distIsCurrent(root, shared, repository)).toBe(true);

      // A production bundle is not a reason to rebuild. It is the same app built
      // more carefully, and treating it as stale is what let an unrelated
      // `apps/api` save replace it with an unminified dev build.
      writeBuildState(root, 'https://current.example', 'production');
      expect(distIsCurrent(root, shared, repository)).toBe(true);

      delete process.env.MANGO_API_URL;
      expect(distIsCurrent(root, shared, repository)).toBe(false);

      writeBuildState(root, 'https://deprecated.example');
      expect(distIsCurrent(root, shared, repository)).toBe(true);
    } finally {
      if (originalApiUrl === undefined) delete process.env.MANGO_API_URL;
      else process.env.MANGO_API_URL = originalApiUrl;
      if (originalDeprecatedApiUrl === undefined) delete process.env.VITE_API_URL;
      else process.env.VITE_API_URL = originalDeprecatedApiUrl;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * The reader `distIsCurrent` and the production-downgrade warning share.
 *
 * Every rejection below has to answer null rather than throw or return a
 * half-populated object: the caller treats null as "nothing is known about
 * dist/", which rebuilds, and that is the only safe answer to a stamp this
 * version cannot read.
 */
describe('readBuildState', () => {
  function writeState(root: string, contents: string): string {
    const dist = join(root, 'dist');
    writeFileSync(join(dist, BUILD_STATE_FILE), contents);
    return dist;
  }

  test('reads a complete stamp', () => {
    const root = fixture();
    try {
      const dist = writeState(root, JSON.stringify({ apiUrl: '', mode: 'production' }));
      expect(readBuildState(dist)).toEqual({ apiUrl: '', mode: 'production' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects a missing, unparseable or incomplete stamp', () => {
    const root = fixture();
    try {
      expect(readBuildState(join(root, 'dist'))).toBeNull();
      for (const contents of [
        'not json',
        'null',
        '"a string"',
        JSON.stringify({ mode: 'dev' }),
        JSON.stringify({ apiUrl: '' }),
        // The pre-stamp shape, and the one a future mode name would take.
        JSON.stringify({ apiUrl: '', mode: 'staging' }),
        JSON.stringify({ apiUrl: 42, mode: 'dev' }),
      ]) {
        expect(readBuildState(writeState(root, contents))).toBeNull();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
