import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { removeFixtureDirSync } from '../../support/remove-fixture-dir';
import { scanSourcePaths, toPosixSourcePath } from '../../support/source-scan';

describe('toPosixSourcePath', () => {
  test('writes a Windows scan result with the slashes a source scan compares against', () => {
    const received = toPosixSourcePath('server\\nested\\start-server.ts', '\\');

    expect(
      received,
      `expected posix path: server/nested/start-server.ts | received: ${received}`
    ).toBe('server/nested/start-server.ts');
  });

  test('leaves a POSIX path alone, including a backslash that is part of a name', () => {
    expect(toPosixSourcePath('lib/odd\\name.ts', '/')).toBe('lib/odd\\name.ts');
  });
});

describe('scanSourcePaths', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'source-scan-'));
    mkdirSync(join(root, 'lib', 'deep'), { recursive: true });
    writeFileSync(join(root, 'lib', 'deep', 'a.ts'), '');
    writeFileSync(join(root, 'b.ts'), '');
  });

  afterEach(() => {
    removeFixtureDirSync({ role: 'source-scan', path: root });
  });

  test('lists nested files relative to the root with forward slashes', async () => {
    const received = (await scanSourcePaths(root, '**/*.ts')).sort();

    expect(received, `expected relative posix paths | received: ${received.join(', ')}`).toEqual([
      'b.ts',
      'lib/deep/a.ts',
    ]);
  });
});
