import { describe, expect, it } from 'bun:test';
import {
  hashLibraryDirectory,
  hashLibraryFile,
  type LibraryHashReader,
} from '../../../src/library';

interface FakeFile {
  readonly bytes: string;
  readonly modifiedAtMs?: number;
  readonly realPath?: string;
}

function fakeReader(
  files: Readonly<Record<string, FakeFile>>,
  order = Object.keys(files)
): LibraryHashReader {
  return {
    listFiles() {
      return order;
    },
    realPath(path) {
      const relativePath = path.replace(/^\/library\/?/, '');
      return files[relativePath]?.realPath ?? path;
    },
    readFile(path) {
      const relativePath = path.replace(/^\/library\/?/, '');
      const file = files[relativePath];
      if (!file) throw new Error(`Unexpected read: ${path}`);
      return new TextEncoder().encode(file.bytes);
    },
  };
}

describe('library hashing', () => {
  it('hashes single-file resources from their exact bytes', async () => {
    const reader = fakeReader({ 'AGENTS.md': { bytes: 'line one\r\nline two\r\n' } });

    const crlf = await hashLibraryFile('/library/AGENTS.md', reader);
    const lf = await hashLibraryFile(
      '/library/AGENTS.md',
      fakeReader({ 'AGENTS.md': { bytes: 'line one\nline two\n' } })
    );

    expect(crlf.contentHash).toHaveLength(64);
    expect(crlf.sizeBytes).toBe(20);
    expect(crlf.contentHash).not.toBe(lf.contentHash);
  });

  it('is stable under directory-entry ordering and identical trees', async () => {
    const files = {
      'SKILL.md': { bytes: '# Skill\n' },
      'references/guide.md': { bytes: '# Guide\n' },
    };

    const first = await hashLibraryDirectory(
      '/library',
      fakeReader(files, ['references/guide.md', 'SKILL.md'])
    );
    const second = await hashLibraryDirectory(
      '/library',
      fakeReader(files, ['SKILL.md', 'references/guide.md'])
    );

    expect(first).toEqual(second);
    expect(first).toEqual({
      contentHash: '8043d74bf3554c1ce55088c39a1ee8e7506f644a5dcc08939baf9d2a160293e8',
      sizeBytes: 16,
      valid: true,
    });
  });

  it('changes when file bytes change, a file is added, or a file is renamed', async () => {
    const original = await hashLibraryDirectory(
      '/library',
      fakeReader({ 'SKILL.md': { bytes: '# Skill\n' } })
    );
    const edited = await hashLibraryDirectory(
      '/library',
      fakeReader({ 'SKILL.md': { bytes: '# Edited\n' } })
    );
    const added = await hashLibraryDirectory(
      '/library',
      fakeReader({
        'SKILL.md': { bytes: '# Skill\n' },
        'reference.md': { bytes: 'Reference\n' },
      })
    );
    const renamed = await hashLibraryDirectory(
      '/library',
      fakeReader({ 'RENAMED.md': { bytes: '# Skill\n' } })
    );

    expect(original.valid).toBe(true);
    expect(edited).not.toEqual(original);
    expect(added).not.toEqual(original);
    expect(renamed).not.toEqual(original);
  });

  it('does not depend on file metadata', async () => {
    const first = await hashLibraryDirectory(
      '/library',
      fakeReader({ 'SKILL.md': { bytes: '# Skill\n', modifiedAtMs: 1 } })
    );
    const second = await hashLibraryDirectory(
      '/library',
      fakeReader({ 'SKILL.md': { bytes: '# Skill\n', modifiedAtMs: 2 } })
    );

    expect(first).toEqual(second);
  });

  it('rejects a symlink escaping the resource root without reading its target', async () => {
    let targetRead = false;
    const reader: LibraryHashReader = {
      listFiles() {
        return ['outside.md'];
      },
      realPath(path) {
        return path.endsWith('outside.md') ? '/outside/secret.md' : '/library';
      },
      readFile() {
        targetRead = true;
        return new Uint8Array();
      },
    };

    await expect(hashLibraryDirectory('/library', reader)).resolves.toEqual({
      valid: false,
      invalidReason: 'path-escape',
    });
    expect(targetRead).toBe(false);
  });

  it('separates file and directory hash namespaces', async () => {
    const directory = await hashLibraryDirectory(
      '/library',
      fakeReader({ 'SKILL.md': { bytes: '# Skill\n' } })
    );
    const entryHash = await hashLibraryFile(
      '/library/SKILL.md',
      fakeReader({ 'SKILL.md': { bytes: '# Skill\n' } })
    );
    // A file whose bytes are exactly the one-entry manifest of the directory above.
    const manifestShapedFile = await hashLibraryFile(
      '/library/manifest.txt',
      fakeReader({ 'manifest.txt': { bytes: `SKILL.md\0${entryHash.contentHash}\n` } })
    );

    expect(directory.valid).toBe(true);
    expect(manifestShapedFile.contentHash).not.toBe(
      directory.valid ? directory.contentHash : undefined
    );
  });

  it('resolves an in-root symlink and hashes the target bytes', async () => {
    const regular = await hashLibraryDirectory(
      '/library',
      fakeReader({ 'alias.md': { bytes: 'content\n' } })
    );
    const symlink = await hashLibraryDirectory('/library', {
      listFiles() {
        return ['alias.md'];
      },
      realPath(path) {
        return path.endsWith('alias.md') ? '/library/target.md' : '/library';
      },
      readFile(path) {
        if (path !== '/library/target.md') throw new Error(`Unexpected read: ${path}`);
        return new TextEncoder().encode('content\n');
      },
    });

    expect(symlink).toEqual(regular);
  });
});
