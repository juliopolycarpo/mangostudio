import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { isTomlLibraryName } from '../lib/dependency-policy';
import { collectModuleSpecifiers } from '../lib/import-specifiers';

const TOML_LIBRARIES = ['smol-toml', 'toml', '@iarna/toml', '@ltd/j-toml', '@std/toml'];
/** Every workspace's source and tests, plus the scripts toolkit. */
const SOURCE_GLOBS = ['{apps,packages}/*/{src,tests}/**/*.{ts,tsx,mts,cts}', 'scripts/**/*.ts'];
const MAY_NAME_TOML_PACKAGE = /toml|\\[ux]/i;
const HOST_BOUNDARIES = 'apps/shared/src/library/machine and apps/api/src/lib/toml.ts';

interface TomlLibraryImport {
  file: string;
  line: number;
  specifier: string;
}

/** The package a specifier resolves to: `@scope/name/sub` -> `@scope/name`, `a/b` -> `a`. */
function packageNameOf(specifier: string): string {
  const [first = '', second] = specifier.split('/');
  return first.startsWith('@') && second ? `${first}/${second}` : first;
}

/**
 * A bare specifier of a package the dependency policy treats as a TOML library.
 * Relative paths and `node:*` never match, so the local `./toml` adapter stays
 * allowed, and neither does the `bun` builtin.
 */
function isTomlLibrarySpecifier(specifier: string): boolean {
  return !/^(?:\.|\/|node:)/.test(specifier) && isTomlLibraryName(packageNameOf(specifier));
}

function findTomlLibraryImports(source: string, file: string): TomlLibraryImport[] {
  return collectModuleSpecifiers(source, file)
    .filter(({ text }) => isTomlLibrarySpecifier(text))
    .map(({ text, line }) => ({ file, line, specifier: text }));
}

function assertNoTomlLibraryImports(imports: readonly TomlLibraryImport[]): void {
  if (imports.length === 0) return;
  const details = imports.map(({ file, line, specifier }) => `${file}:${line} (${specifier})`);
  throw new Error(
    `Unexpected TOML library imports: ${details.join(', ')}. Parse and write TOML through the Bun boundary in ${HOST_BOUNDARIES}.`
  );
}

function scanSourcePaths(): string[] {
  return SOURCE_GLOBS.flatMap((pattern) => [
    ...new Bun.Glob(pattern).scanSync({ cwd: ROOT_DIR, onlyFiles: true }),
  ])
    .map((path) => path.replaceAll('\\', '/'))
    .filter((path) => !path.includes('node_modules/'));
}

describe('TOML library import boundary', () => {
  it('scans every workspace and imports no TOML library anywhere', () => {
    const paths = scanSourcePaths();
    expect(paths.length).toBeGreaterThan(500);
    for (const known of [
      'apps/shared/src/library/machine/instance-reader.ts',
      'apps/api/src/lib/toml.ts',
      'apps/frontend/src/main.tsx',
      'scripts/tests/toml-library-import-guard.unit.test.ts',
    ]) {
      expect(paths, `expected the scan to include ${known}`).toContain(known);
    }
    const imports = paths.flatMap((path) => {
      const source = readFileSync(join(ROOT_DIR, path), 'utf8');
      // Parsing ~3,800 files costs seconds. A specifier naming a TOML package spells
      // `toml` out unless it hides behind a `\u`/`\x` escape, so skip files with neither.
      return MAY_NAME_TOML_PACKAGE.test(source) ? findTomlLibraryImports(source, path) : [];
    });
    assertNoTomlLibraryImports(imports);
  });

  it.each(TOML_LIBRARIES)('recognizes every import form of %s and its subpaths', (library) => {
    const sources = [
      `import { parse } from '${library}'`,
      `import type { TomlDate } from '${library}'`,
      `import { type TomlDate } from '${library}'`,
      `import '${library}'`,
      `export * from '${library}'`,
      `await import('${library}')`,
      `require('${library}')`,
      `module.require('${library}')`,
      `(require as NodeRequire)('${library}')`,
      `import parser = require('${library}')`,
      `type Parsed = import('${library}').TomlPrimitive`,
      `import { parse } from '${library}/parse'`,
    ];
    for (const source of sources) {
      const imports = findTomlLibraryImports(source, 'apps/shared/src/planted.ts');
      expect(
        imports.map(({ specifier }) => packageNameOf(specifier)),
        source
      ).toEqual([library]);
    }
  });

  it('names the file, line and specifier of a planted violation', () => {
    const planted = [
      ...findTomlLibraryImports("\nimport { parse } from 'smol-toml';", 'apps/shared/src/a.ts'),
      ...findTomlLibraryImports("require('@iarna/toml/stringify');", 'apps/api/tests/b.ts'),
    ];

    expect(() => assertNoTomlLibraryImports(planted)).toThrow(
      `Unexpected TOML library imports: apps/shared/src/a.ts:2 (smol-toml), apps/api/tests/b.ts:1 (@iarna/toml/stringify). Parse and write TOML through the Bun boundary in ${HOST_BOUNDARIES}.`
    );
  });

  it('allows local helpers, Bun builtins and unrelated packages', () => {
    const sources = [
      "import { tomlNestingWithinLimit } from './toml-nesting'",
      "await import('../toml')",
      "require('./toml')",
      "import { TOML } from 'bun'",
      "import { read } from 'node:fs'",
      "import { schema } from '@mangostudio/shared/library/machine/toml-nesting'",
      "// import { parse } from 'smol-toml';",
      'const example = "import { parse } from \'smol-toml\'";',
      "other.require('smol-toml')",
    ];
    for (const source of sources) {
      expect(findTomlLibraryImports(source, 'apps/api/src/example.ts'), source).toEqual([]);
    }
  });
});
