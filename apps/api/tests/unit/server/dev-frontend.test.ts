/**
 * The dev rebuild loop's staleness scan. `newestSourceMtime` decides whether
 * `bun run dev` rebuilds or reports the existing bundle as current, so a
 * subtree it fails to see is a bundle that never rebuilds — and a subtree it
 * wrongly *does* see (`dist/`) is a rebuild that triggers the next one forever.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newestSourceMtime } from '../../../src/server/dev-frontend';

/** Seconds since the epoch, so mtimes are far enough apart to compare. */
const OLD = 1_000_000;
const NEW = 2_000_000;

function writeAt(path: string, seconds: number): void {
  writeFileSync(path, 'x');
  utimesSync(path, seconds, seconds);
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dev-frontend-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'public'), { recursive: true });
  mkdirSync(join(root, 'dist', 'assets'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  return root;
}

describe('newestSourceMtime', () => {
  test('sees index.html, public/ and build config, not just src/', () => {
    const root = fixture();
    try {
      writeAt(join(root, 'src', 'main.tsx'), OLD);
      // Each of these was invisible to the old `src/`-only scan, so editing one
      // left `distIsCurrent()` reporting a stale bundle as current.
      for (const path of ['index.html', 'build.ts', join('public', 'logo.svg')]) {
        writeAt(join(root, path), NEW);
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
      expect(newestSourceMtime(root)).toBe(OLD * 1000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('ignores dist-metafile.json, which the build writes beside dist/ and not inside it', () => {
    const root = fixture();
    try {
      writeAt(join(root, 'src', 'main.tsx'), OLD);
      // The last write of every build, at the frontend root — so `UNWATCHED_DIRS`
      // cannot prune it, and counting it would make `distIsCurrent()` false on
      // every API restart while the watcher rebuilt in a loop.
      writeAt(join(root, 'dist-metafile.json'), NEW);
      expect(newestSourceMtime(root)).toBe(OLD * 1000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('ignores the generated route tree the build writes back into src/', () => {
    const root = fixture();
    try {
      writeAt(join(root, 'src', 'main.tsx'), OLD);
      writeAt(join(root, 'src', 'routeTree.gen.ts'), NEW);
      expect(newestSourceMtime(root)).toBe(OLD * 1000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reports 0 for a directory that does not exist, which reads as stale', () => {
    expect(newestSourceMtime(join(tmpdir(), 'dev-frontend-absent-fixture'))).toBe(0);
  });
});
