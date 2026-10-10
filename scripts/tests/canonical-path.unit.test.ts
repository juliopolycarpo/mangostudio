import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalPath } from './support/canonical-path';

describe('canonicalPath', () => {
  test('resolves an alias under a missing tail and reports any other failure', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'canonical-path-'));
    try {
      const physical = join(sandbox, 'physical');
      const alias = join(sandbox, 'alias');
      mkdirSync(physical);
      symlinkSync(physical, alias, 'junction');
      writeFileSync(join(physical, 'file.txt'), 'not a directory');
      const expected = realpathSync(physical);

      expect(canonicalPath(alias)).toBe(expected);
      const missing = canonicalPath(join(alias, 'gone', 'deeper'));
      expect(
        missing,
        `expected canonical missing path: ${join(expected, 'gone', 'deeper')} | received: ${missing}`
      ).toBe(join(expected, 'gone', 'deeper'));
      // A file where a directory was expected is not "missing" on POSIX, so the caller must
      // see it. Windows reports that shape as a missing path, like any other absent tail.
      if (process.platform !== 'win32') {
        expect(() => canonicalPath(join(alias, 'file.txt', 'child'))).toThrow('ENOTDIR');
      }
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
