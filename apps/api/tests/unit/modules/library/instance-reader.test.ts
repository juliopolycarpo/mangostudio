import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getLibraryLocation, type LocationDefinition } from '@mangostudio/shared/library/host';
import {
  type LibraryInstanceReaderFs,
  readLocationInstances,
} from '../../../../src/modules/library/infrastructure/instance-reader';
import { LibraryCache } from '../../../../src/modules/library/infrastructure/library-cache';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mango-library-reader-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function skillLocation(): LocationDefinition {
  const location = getLibraryLocation('mango-skills');
  if (!location) throw new Error('Missing mango-skills test fixture.');
  return location;
}

describe('readLocationInstances', () => {
  it('keeps malformed skills alongside valid siblings', async () => {
    const validDir = join(root, 'valid-skill');
    const invalidDir = join(root, 'broken-skill');
    mkdirSync(validDir);
    mkdirSync(invalidDir);
    writeFileSync(
      join(validDir, 'SKILL.md'),
      '---\nname: valid-skill\ndescription: Valid\n---\nBody\n'
    );

    const result = await readLocationInstances(skillLocation(), root, {
      cache: new LibraryCache(),
      force: false,
    });

    expect(result.instances).toHaveLength(2);
    expect(result.unreadableEntries).toEqual([]);
    expect(result.instances.find(({ ref }) => ref.slug === 'valid-skill')?.instance.valid).toBe(
      true
    );
    expect(result.instances.find(({ ref }) => ref.slug === 'broken-skill')?.instance).toMatchObject(
      {
        valid: false,
        invalidReason: 'missing-entrypoint',
      }
    );
  });

  it('returns an empty result for a missing location', async () => {
    const missingFs: LibraryInstanceReaderFs = {
      readDirectory: () => Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' })),
      readFile: () => Promise.reject(new Error('unused')),
      realPath: (path) => Promise.resolve(path),
      stat: () => Promise.reject(new Error('unused')),
    };

    const result = await readLocationInstances(skillLocation(), '/missing', {
      cache: new LibraryCache(),
      force: false,
      fs: missingFs,
    });

    expect(result).toEqual({ instances: [], unreadableEntries: [] });
  });

  it('reports a file where a skill directory was expected', async () => {
    writeFileSync(join(root, 'not-a-directory'), 'content');

    const result = await readLocationInstances(skillLocation(), root, {
      cache: new LibraryCache(),
      force: false,
    });

    expect(result.instances[0]?.instance).toMatchObject({
      valid: false,
      invalidReason: 'unexpected-entry-type',
    });
  });

  it('rejects a directory symlink that escapes the resource root before hashing it', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'mango-library-outside-'));
    const skillDir = join(root, 'escaped-skill');
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: escaped-skill\ndescription: Escaped\n---\n'
    );
    writeFileSync(join(outside, 'secret.txt'), 'outside');
    symlinkSync(outside, join(skillDir, 'references'));

    try {
      const result = await readLocationInstances(skillLocation(), root, {
        cache: new LibraryCache(),
        force: false,
      });

      expect(result.instances[0]?.instance).toMatchObject({
        valid: false,
        invalidReason: 'path-escape',
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects a resource directory symlink that escapes its location', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'mango-library-outside-resource-'));
    writeFileSync(
      join(outside, 'SKILL.md'),
      '---\nname: escaped-skill\ndescription: Escaped\n---\n'
    );
    symlinkSync(outside, join(root, 'escaped-skill'));

    try {
      const result = await readLocationInstances(skillLocation(), root, {
        cache: new LibraryCache(),
        force: false,
      });

      expect(result.instances[0]?.instance).toMatchObject({
        valid: false,
        invalidReason: 'path-escape',
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('reports a leaf file whose name carries a newline as unsafe-name, not path-escape', async () => {
    const skillDir = join(root, 'newline-skill');
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: newline-skill\ndescription: Newline\n---\n'
    );
    writeFileSync(join(skillDir, 'a\nb.md'), 'content');

    const result = await readLocationInstances(skillLocation(), root, {
      cache: new LibraryCache(),
      force: false,
    });

    expect(result.instances[0]?.instance).toMatchObject({
      valid: false,
      invalidReason: 'unsafe-name',
    });
  });

  it('reports a directory whose name breaks the per-kind slug rule', async () => {
    const badSlugDir = join(root, 'Not_A_Skill');
    mkdirSync(badSlugDir);
    writeFileSync(join(badSlugDir, 'SKILL.md'), '---\nname: Not_A_Skill\ndescription: X\n---\n');

    const result = await readLocationInstances(skillLocation(), root, {
      cache: new LibraryCache(),
      force: false,
    });

    expect(result.instances[0]?.ref.slug).toBe('Not_A_Skill');
    expect(result.instances[0]?.instance).toMatchObject({
      valid: false,
      invalidReason: 'invalid-slug',
    });
  });

  it('reports a directory whose name breaks the library-wide slug pattern as unreadable, not dropped', async () => {
    const spacedDir = join(root, 'my skill');
    mkdirSync(spacedDir);
    writeFileSync(join(spacedDir, 'SKILL.md'), '---\nname: my skill\ndescription: X\n---\n');
    const validDir = join(root, 'valid-skill');
    mkdirSync(validDir);
    writeFileSync(join(validDir, 'SKILL.md'), '---\nname: valid-skill\ndescription: Valid\n---\n');

    const result = await readLocationInstances(skillLocation(), root, {
      cache: new LibraryCache(),
      force: false,
    });

    expect(result.unreadableEntries).toEqual([
      { locationId: skillLocation().id, name: 'my skill', reason: 'invalid-name' },
    ]);
    expect(result.instances.map(({ ref }) => ref.slug)).toEqual(['valid-skill']);
  });

  it('reports an oversized skill entrypoint without reading it', async () => {
    const skillDir = join(root, 'oversized-skill');
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, 'SKILL.md'), 'x'.repeat(256 * 1024 + 1));
    let contentReads = 0;
    const countingFs: LibraryInstanceReaderFs = {
      readDirectory: (path) => readdir(path, { withFileTypes: true }),
      readFile(path) {
        contentReads += 1;
        return readFile(path);
      },
      realPath: (path) => realpath(path),
      async stat(path) {
        const value = await stat(path);
        return {
          size: value.size,
          mtimeMs: value.mtimeMs,
          isFile: value.isFile(),
          isDirectory: value.isDirectory(),
        };
      },
    };

    const result = await readLocationInstances(skillLocation(), root, {
      cache: new LibraryCache(),
      force: false,
      fs: countingFs,
    });

    expect(result.instances[0]?.instance).toMatchObject({
      valid: false,
      invalidReason: 'too-large',
    });
    expect(contentReads).toBe(0);
  });

  it('names a single-file resource from the registry, not from the filename', async () => {
    const location = getLibraryLocation('claude-instructions');
    if (!location) throw new Error('Missing claude-instructions test fixture.');
    const instructionFile = join(root, 'CLAUDE.md');
    writeFileSync(instructionFile, '# Global\n');

    const result = await readLocationInstances(location, instructionFile, {
      cache: new LibraryCache(),
      force: false,
    });

    expect(result.instances[0]?.ref).toEqual({ kind: 'instruction', slug: 'global' });
  });

  it('does not reopen unchanged content when the instance fingerprint is cached', async () => {
    const skillDir = join(root, 'cached-skill');
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: cached-skill\ndescription: Cached\n---\n'
    );
    let contentReads = 0;
    const countingFs: LibraryInstanceReaderFs = {
      readDirectory: (path) => readdir(path, { withFileTypes: true }),
      readFile(path) {
        contentReads += 1;
        return readFile(path);
      },
      realPath: (path) => realpath(path),
      async stat(path) {
        const value = await stat(path);
        return {
          size: value.size,
          mtimeMs: value.mtimeMs,
          isFile: value.isFile(),
          isDirectory: value.isDirectory(),
        };
      },
    };
    const cache = new LibraryCache();

    await readLocationInstances(skillLocation(), root, {
      cache,
      force: false,
      fs: countingFs,
    });
    const readsAfterFirstScan = contentReads;
    await readLocationInstances(skillLocation(), root, {
      cache,
      force: false,
      fs: countingFs,
    });

    expect(readsAfterFirstScan).toBeGreaterThan(0);
    expect(contentReads).toBe(readsAfterFirstScan);
  });
});
