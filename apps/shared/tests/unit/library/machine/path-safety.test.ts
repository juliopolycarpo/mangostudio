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

it.skipIf(process.platform === 'win32').each(['raw', 'symlink'])(
  'resolves a missing directory root with a trailing slash through a %s path',
  (kind) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'library-resource-root-')));
    try {
      const resolvedRoot = join(dir, 'missing');
      const link = join(dir, 'linked');
      symlinkSync('missing/', link, 'dir');
      const locationRoot = kind === 'raw' ? `${resolvedRoot}/` : link;

      const result = resolveContainedResourcePath(locationRoot, 'skill');
      expect(result).toEqual({
        logicalPath: join(locationRoot, 'skill'),
        resolvedRoot,
        resolvedPath: join(resolvedRoot, 'skill'),
      });
      mkdirSync(result.resolvedRoot);
      writeFileSync(result.logicalPath, 'new resource');
      expect(readFileSync(result.resolvedPath, 'utf8')).toBe('new resource');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);

it.skipIf(process.platform === 'win32')(
  'resolves a dangling resource symlink with a trailing slash when planning a directory',
  () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'library-resource-root-')));
    try {
      const logicalPath = join(root, 'gh');
      const resolvedPath = join(root, 'new-gh');
      symlinkSync('new-gh/', logicalPath, 'dir');

      expect(() => resolveContainedResourcePath(root, 'gh')).toThrow('ENOENT');
      const result = resolveContainedResourcePath(root, 'gh', 'directory');
      expect(result).toEqual({ logicalPath, resolvedRoot: root, resolvedPath });
      mkdirSync(result.resolvedPath);
      expect(realpathSync(result.logicalPath)).toBe(result.resolvedPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);
