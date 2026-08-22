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
import { newestSourceMtime } from '../../../src/server/dev-frontend';

/** Seconds since the epoch, so mtimes are far enough apart to compare. */
const OLD = 1_000_000;
const NEW = 2_000_000;

function writeAt(path: string, seconds: number): void {
  writeFileSync(path, 'x');
  utimesSync(path, seconds, seconds);
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
