import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { importClosure } from './support/import-closure';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** Writes named import sources without evaluating them, as Turbo's source census does. */
function sources(files: Record<string, string>) {
  const parent = join(ROOT_DIR, '.mango', 'artifacts');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'import-closure-'));
  directories.push(directory);
  for (const [file, source] of Object.entries(files)) {
    const path = join(directory, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
  }
  return (file: string) => relative(ROOT_DIR, join(directory, file)).replaceAll('\\', '/');
}

describe('the cache source import closure', () => {
  it('follows static, side-effect and dynamic imports transitively without repeating a cycle', () => {
    const file = sources({
      'entry.ts':
        "import { value } from './shared';\nimport './side-effect';\nawait import('./dynamic');",
      'shared.ts': "import { root } from './entry';",
      'side-effect.ts': "import { value } from './shared';",
      'dynamic.ts': "export { leaf } from './deep/leaf';",
      'deep/leaf.ts': 'export const leaf = 1;',
    });

    expect(importClosure([file('entry.ts'), file('shared.ts')]).sort()).toEqual(
      ['entry.ts', 'shared.ts', 'side-effect.ts', 'dynamic.ts', 'deep/leaf.ts'].map(file).sort()
    );
  });

  it('keeps leaf entries and leaves builtin and package imports outside the closure', () => {
    const file = sources({
      'leaf.ts': "import { readFileSync } from 'node:fs';\nawait import('bun');",
    });

    expect(importClosure([file('leaf.ts')])).toEqual([file('leaf.ts')]);
  });
});
