import { expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveContainedResourcePath } from '../../../../src/library/machine/path-safety';

it.skipIf(process.platform === 'win32')(
  'resolves and writes beneath the same physical location after a symlink and parent step',
  () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'library-resource-root-')));
    try {
      const physical = join(dir, 'physical');
      const physicalAssets = join(physical, 'assets');
      mkdirSync(join(physical, 'nested'), { recursive: true });
      mkdirSync(physicalAssets);
      mkdirSync(join(dir, 'assets'));
      symlinkSync(join(physical, 'nested'), join(dir, 'redirect'), 'dir');
      const locationRoot = [dir, 'redirect', '..', 'assets'].join('/');
      const lexical = join(dir, 'assets', 'skill');
      writeFileSync(lexical, 'lexical sibling');

      const result = resolveContainedResourcePath(locationRoot, 'skill');
      expect(result).toEqual({
        logicalPath: [locationRoot, 'skill'].join('/'),
        resolvedRoot: physicalAssets,
        resolvedPath: join(physicalAssets, 'skill'),
      });
      writeFileSync(result.logicalPath, 'physical resource');
      expect(readFileSync(result.resolvedPath, 'utf8')).toBe('physical resource');
      expect(readFileSync(lexical, 'utf8')).toBe('lexical sibling');

      const outside = join(dir, 'outside');
      mkdirSync(outside);
      symlinkSync(outside, join(physicalAssets, 'escaping'), 'dir');
      expect(() => resolveContainedResourcePath(locationRoot, 'escaping')).toThrow(
        'resolves outside'
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);
