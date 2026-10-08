import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  hashResourceAt,
  LibraryHashInvalidError,
  type LibraryInstanceReaderFs,
  PathEscapeError,
} from '../../../../src/library/machine/instance-reader';

let root: string;

/** A filename Windows cannot create, supplied through the existing reader seam. */
class NewlineNameFileSystem implements LibraryInstanceReaderFs {
  readCount = 0;

  readDirectory() {
    return Promise.resolve([new NewlineFileEntry()]);
  }

  realPath(path: string) {
    return Promise.resolve(resolve(path));
  }

  stat() {
    return Promise.resolve({ size: 7, mtimeMs: 0, isFile: true, isDirectory: false });
  }

  readFile() {
    this.readCount += 1;
    return Promise.resolve(Buffer.from('content'));
  }
}

class NewlineFileEntry {
  readonly name = 'a\nb.md';

  isFile() {
    return true;
  }

  isDirectory() {
    return false;
  }

  isSymbolicLink() {
    return false;
  }
}

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
    const fs = new NewlineNameFileSystem();

    // Captured rather than matched, because the claim is about which error this
    // is: `unsafe-name` and specifically not the path escape it used to raise.
    // A resolved hash lands here too and fails the first assertion.
    const error = await hashResourceAt(skillDir, 'directory', fs).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(LibraryHashInvalidError);
    expect(error).not.toBeInstanceOf(PathEscapeError);
    expect((error as LibraryHashInvalidError).invalidReason).toBe('unsafe-name');
    expect(fs.readCount).toBe(0);
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
