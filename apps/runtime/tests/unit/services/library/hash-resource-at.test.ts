import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hashResourceAt,
  LibraryHashInvalidError,
  PathEscapeError,
} from '../../../../src/services/library/instance-reader';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mango-hash-resource-at-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('hashResourceAt', () => {
  it('fails post-write hashing of a newline filename with unsafe-name, not a path escape', async () => {
    const skillDir = join(root, 'newline-skill');
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: newline-skill\ndescription: d\n---\n');
    writeFileSync(join(skillDir, 'a\nb.md'), 'content');

    try {
      await hashResourceAt(skillDir, 'directory');
      throw new Error('Expected hashing to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(LibraryHashInvalidError);
      expect(error).not.toBeInstanceOf(PathEscapeError);
      expect((error as LibraryHashInvalidError).invalidReason).toBe('unsafe-name');
    }
  });

  it('still throws PathEscapeError when a directory symlink leaves the tree', async () => {
    const skillDir = join(root, 'escaped-skill');
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: escaped-skill\ndescription: d\n---\n');
    const outside = mkdtempSync(join(tmpdir(), 'mango-hash-outside-'));
    try {
      symlinkSync(outside, join(skillDir, 'out'));
      await expect(hashResourceAt(skillDir, 'directory')).rejects.toBeInstanceOf(PathEscapeError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
