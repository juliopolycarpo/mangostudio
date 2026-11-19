import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { walkRuntimeImports } from './support/runtime-imports';

const WORKSPACE_SPECIFIER = '@mangostudio/api/test-support/chatgpt/fake-server';
const LEAF = 'scripts/lib/leaf.ts';
let fixtureRoot: string;

function writeFixture(path: string, source: string): void {
  const target = join(fixtureRoot, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source);
}

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'mangostudio-runtime-imports-'));
  writeFixture('scripts/entry.ts', "import { fixture } from './lib/middle';\n");
  writeFixture('scripts/lib/middle.ts', "export * from './leaf';\n");
  writeFixture(LEAF, 'export const fixture = 1;\n');
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('runtime import walker', () => {
  test('follows relative imports and still reports a transitive external runtime dependency', () => {
    writeFixture(
      LEAF,
      "import 'external-runtime';\nimport type { Model } from 'type-only-model';\n"
    );

    const walk = walkRuntimeImports('scripts/entry.ts', fixtureRoot);

    expect(walk.files.has(join(fixtureRoot, 'scripts/lib/middle.ts'))).toBe(true);
    expect([...walk.externalSpecifiers]).toEqual([['external-runtime', [LEAF]]]);
  });

  test('reports an unused external binding in a transitively imported file', () => {
    writeFixture(LEAF, "import { unused } from 'external-runtime';\n");

    expect([...walkRuntimeImports('scripts/entry.ts', fixtureRoot).externalSpecifiers]).toEqual([
      ['external-runtime', [LEAF]],
    ]);
  });

  // Planted violations: each form must surface `planted-runtime-package` against
  // `scripts/lib/leaf.ts`. The regex scanner this replaced missed
  // the wrapped loader and `module['require']`, and counted `import('x').Type` and
  // `other.require('x')` as runtime edges.
  test.each([
    "const loaded = module.require('planted-runtime-package');",
    "const loaded = (require as NodeRequire)('planted-runtime-package');",
    "const loaded = module['require']('planted-runtime-package');",
    "import loaded = require('planted-runtime-package');",
    "import 'planted-runtime-package';",
    "export * from 'planted-runtime-package';",
    "const loaded = await import('planted-runtime-package');",
    "import { type Model, value } from 'planted-runtime-package';",
  ])('reports the planted runtime edge in %s', (source) => {
    writeFixture(LEAF, `${source}\n`);

    expect([...walkRuntimeImports('scripts/entry.ts', fixtureRoot).externalSpecifiers]).toEqual([
      ['planted-runtime-package', [LEAF]],
    ]);
  });

  test.each([
    "import type { Model } from 'planted-runtime-package';",
    "import { type Model } from 'planted-runtime-package';",
    "export type { Model } from 'planted-runtime-package';",
    "type Model = import('planted-runtime-package').Model;",
    "// import 'planted-runtime-package';",
    "/* const loaded = require('planted-runtime-package'); */",
    'const example = "import loaded from \'planted-runtime-package\';";',
    "const loaded = other.require('planted-runtime-package');",
  ])('ignores the type-only, commented or unrelated edge in %s', (source) => {
    writeFixture(LEAF, `${source}\n`);

    expect([...walkRuntimeImports('scripts/entry.ts', fixtureRoot).externalSpecifiers]).toEqual([]);
  });

  test('accepts a relative fixture root while following the same original source', () => {
    const walk = walkRuntimeImports('scripts/entry.ts', relative(process.cwd(), fixtureRoot));

    expect(walk.files.size).toBe(3);
    expect([...walk.externalSpecifiers]).toEqual([]);
  });

  // A workspace package name needs `node_modules`, which a `--no-install` script lacks.
  test('reports a workspace package import as external, with no alias to follow', () => {
    writeFixture(LEAF, `import { fixture } from '${WORKSPACE_SPECIFIER}';\n`);

    expect([...walkRuntimeImports('scripts/entry.ts', fixtureRoot).externalSpecifiers]).toEqual([
      [WORKSPACE_SPECIFIER, [LEAF]],
    ]);
  });
});
