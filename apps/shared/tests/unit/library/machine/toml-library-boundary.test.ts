import { describe, expect, it } from 'bun:test';
import { join, resolve } from 'node:path';

const SHARED_ROOT = resolve(import.meta.dir, '../../../..');

// Import edges are guarded for every workspace by scripts/tests/toml-library-import-guard.unit.test.ts.
describe('shared TOML library boundary', () => {
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
