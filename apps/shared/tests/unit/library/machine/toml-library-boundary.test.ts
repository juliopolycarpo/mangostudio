import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SHARED_ROOT = resolve(import.meta.dir, '../../../..');
const TOML_LIBRARIES = ['smol-toml', 'toml', '@iarna/toml', '@ltd/j-toml', '@std/toml'];
const TOML_LIBRARY_IMPORT =
  /\b(?:from|import|require)\s*\(?\s*['"](?:@[^/'"]+\/)?[^./'"]*toml[^/'"]*(?:\/[^'"]*)?['"]/;

describe('shared TOML library boundary', () => {
  it.each(TOML_LIBRARIES)('recognizes imports of %s and its subpaths', (library) => {
    const sources = [
      `import { parse } from '${library}'`,
      `import type { TomlDate } from '${library}'`,
      `import '${library}'`,
      `export * from '${library}'`,
      `await import('${library}')`,
      `require('${library}')`,
      `import parser = require('${library}')`,
      `import { parse } from '${library}/parse'`,
    ];
    for (const source of sources) expect(TOML_LIBRARY_IMPORT.test(source), source).toBe(true);
  });

  it('allows local helpers and Bun builtins', () => {
    const sources = [
      "import { tomlNestingWithinLimit } from './toml-nesting'",
      "await import('../toml')",
      "require('./toml')",
      "import { TOML } from 'bun'",
    ];
    for (const source of sources) expect(TOML_LIBRARY_IMPORT.test(source), source).toBe(false);
  });

  it('has no TOML library imports in shared source or tests', () => {
    const paths = [
      ...new Bun.Glob('{src,tests}/**/*.{ts,tsx}').scanSync({
        cwd: SHARED_ROOT,
        onlyFiles: true,
      }),
    ].map((path) => path.replaceAll('\\', '/'));
    expect(paths).toContain('src/library/machine/instance-reader.ts');
    expect(paths).toContain('tests/unit/library/machine/toml-library-boundary.test.ts');
    const offenders = paths.filter((path) =>
      TOML_LIBRARY_IMPORT.test(readFileSync(join(SHARED_ROOT, path), 'utf8'))
    );
    expect(offenders, 'Use the host-only library/machine Bun TOML boundary.').toEqual([]);
  });

  it('declares no TOML library in any dependency section', async () => {
    const manifest = await Bun.file(join(SHARED_ROOT, 'package.json')).json();
    const declared = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    });
    expect(declared.filter((name) => name.includes('toml'))).toEqual([]);
  });
});
