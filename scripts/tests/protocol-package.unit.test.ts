import { describe, expect, test } from 'bun:test';

import {
  exportTargets,
  type ProtocolManifest,
  publishedExports,
  publishedManifest,
  publishedSubpaths,
  unshippedTargets,
} from '../protocol/package-contents';
import { readText } from './support/read-text';

// npm 11.19.0, measured: `npm pack` copies `publishConfig` into the tarball
// verbatim and does not override `exports` with it. A package that relied on
// that override installs with an `exports` map pointing at files the tarball
// never shipped, and every import fails. These tests pin the swap that replaces
// it and the two shapes that swap has to refuse.

const MANIFEST: ProtocolManifest = {
  name: '@mangostudio/protocol',
  version: '0.2.0',
  files: ['dist', 'schema', 'README.md', 'LICENSE'],
  exports: { '.': './src/index.ts', './stdio': './src/stdio.ts' },
  scripts: { build: 'bun ./build.ts', prepack: 'bun ./build.ts' },
  publishConfig: {
    access: 'public',
    exports: {
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
      './stdio': { types: './dist/stdio.d.ts', default: './dist/stdio.js' },
      './schema/*': './schema/*',
    },
  },
};

describe('publishedExports', () => {
  test('reads the map npm would have applied', () => {
    expect(publishedSubpaths(MANIFEST)).toEqual(['.', './stdio', './schema/*']);
  });

  test('names the package when the published map is missing', () => {
    const { publishConfig: _dropped, ...withoutMap } = MANIFEST;
    expect(() => publishedExports(withoutMap as ProtocolManifest)).toThrow(
      '@mangostudio/protocol declares no publishConfig.exports; expected the published map pointing at dist/, received null.'
    );
  });
});

describe('exportTargets', () => {
  test('flattens string targets and condition objects alike', () => {
    expect(
      exportTargets({
        '.': { types: './dist/index.d.ts', default: './dist/index.js' },
        './schema/*': './schema/*',
      })
    ).toEqual(['./dist/index.d.ts', './dist/index.js', './schema/*']);
  });

  test('ignores a null target rather than throwing on it', () => {
    expect(exportTargets({ './gone': null })).toEqual([]);
  });
});

describe('unshippedTargets', () => {
  test('passes a map whose every root is listed in files', () => {
    expect(unshippedTargets(MANIFEST)).toEqual([]);
  });

  test('names the target whose root files omits', () => {
    // The failure only reaches an installing consumer otherwise: npm publishes
    // an exports map pointing at a path the tarball does not contain.
    const narrowed: ProtocolManifest = { ...MANIFEST, files: ['dist'] };
    expect(unshippedTargets(narrowed)).toEqual(['./schema/*']);
  });

  test('counts package.json as always shipped, whatever files says', () => {
    const manifest: ProtocolManifest = {
      name: 'x',
      version: '1.0.0',
      files: [],
      publishConfig: { exports: { './package.json': './package.json' } },
    };
    expect(unshippedTargets(manifest)).toEqual([]);
  });
});

describe('publishedManifest', () => {
  const staged = publishedManifest(MANIFEST);

  test('replaces exports with the published map', () => {
    expect(staged.exports).toEqual(MANIFEST.publishConfig?.exports);
  });

  test('keeps the publishConfig settings npm does honour and drops its copy of the map', () => {
    // Leaving the map behind would ship a second, now-stale definition.
    expect(staged.publishConfig).toEqual({ access: 'public' });
  });

  test('drops scripts, which reference sources the tarball does not ship', () => {
    // Measured: leaving `prepack` in place makes `npm pack` re-run it inside the
    // staging directory and fail with `Module not found "./build.ts"`.
    expect(staged.scripts).toBeUndefined();
  });

  test('keeps the identity fields provenance and the registry read', () => {
    expect(staged.name).toBe('@mangostudio/protocol');
    expect(staged.version).toBe('0.2.0');
    expect(staged.files).toEqual(['dist', 'schema', 'README.md', 'LICENSE']);
  });

  test('refuses a map that names a root files does not ship', () => {
    expect(() => publishedManifest({ ...MANIFEST, files: ['dist'] })).toThrow(
      'publishConfig.exports points at ./schema/*, which "files" (dist) does not ship.'
    );
  });
});

describe('the real protocol manifest', () => {
  const manifest = JSON.parse(readText('packages/protocol/package.json')) as ProtocolManifest;

  test('offers the same subpaths from the workspace and from the tarball', () => {
    // `./schema/*` is published-only: build.ts copies spec/schema/1 in, and
    // in-repo readers take the spec files directly.
    const workspace = Object.keys(manifest.exports ?? {});
    const published = publishedSubpaths(manifest);
    expect(published.filter((subpath) => !workspace.includes(subpath))).toEqual(['./schema/*']);
    expect(workspace.filter((subpath) => !published.includes(subpath))).toEqual([]);
  });

  test('stages cleanly, so the pack lane cannot be the first to find a bad map', () => {
    expect(() => publishedManifest(manifest)).not.toThrow();
  });

  test('the release workflow publishes from the staging directory, not the package', () => {
    const workflow = readText('.github/workflows/protocol-release.yml');
    expect(workflow).toContain('bun ./scripts/protocol/pack.ts --out .mango/out/protocol');
    expect(workflow).toContain('working-directory: .mango/out/protocol/package');
    // Publishing from packages/protocol would ship the src-pointing map.
    expect(workflow).not.toContain('working-directory: packages/protocol');
  });
});
