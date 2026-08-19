import { describe, expect, it } from 'bun:test';
import {
  directoryHashDomainOf,
  directoryHashDomainVersion,
  hashLibraryDirectory,
  hashLibraryFile,
  type LibraryHashPathStyle,
  type LibraryHashReader,
  normalizeHashPath,
} from '../../../src/library';

interface FakeFile {
  readonly bytes: string;
  readonly modifiedAtMs?: number;
  readonly realPath?: string;
}

function fakeReader(
  files: Readonly<Record<string, FakeFile>>,
  order = Object.keys(files),
  pathStyle: LibraryHashPathStyle = 'posix'
): LibraryHashReader {
  return {
    pathStyle,
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
      contentHash: '3af450f69d1128b79fc09951e5e732c9408870c8004dd4e34e37a798d54abf1f',
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
      pathStyle: 'posix',
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
      pathStyle: 'posix',
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

  it('does not let a POSIX backslash in a directory name invent a separator', async () => {
    // `/home/user/lib\rary` is one real directory whose name contains a
    // backslash. A symlink inside it resolves to `/home/user/lib/rary/secret.md`
    // — a genuinely unrelated directory that only looks contained if `\` is
    // rewritten to `/` first.
    let targetRead = false;
    const reader: LibraryHashReader = {
      pathStyle: 'posix',
      listFiles: () => ['secret.md'],
      realPath: (path) =>
        path === '/home/user/lib\\rary' ? path : '/home/user/lib/rary/secret.md',
      readFile: () => {
        targetRead = true;
        return new Uint8Array();
      },
    };

    await expect(hashLibraryDirectory('/home/user/lib\\rary', reader)).resolves.toEqual({
      valid: false,
      invalidReason: 'path-escape',
    });
    expect(targetRead).toBe(false);
  });

  it('does not let a POSIX directory contain a same-prefix sibling', async () => {
    let targetRead = false;
    const reader: LibraryHashReader = {
      pathStyle: 'posix',
      listFiles: () => ['secret.md'],
      realPath: (path) => (path === '/a/lib' ? path : '/a/library/secret.md'),
      readFile: () => {
        targetRead = true;
        return new Uint8Array();
      },
    };

    await expect(hashLibraryDirectory('/a/lib', reader)).resolves.toEqual({
      valid: false,
      invalidReason: 'path-escape',
    });
    expect(targetRead).toBe(false);
  });

  it('normalizes a win32 drive path and keeps containment working', async () => {
    const reader: LibraryHashReader = {
      pathStyle: 'win32',
      listFiles: () => ['note.md'],
      realPath: (path) => (path === 'C:\\a\\b' ? path : 'C:\\a\\b\\note.md'),
      readFile: () => new TextEncoder().encode('hi\n'),
    };

    const result = await hashLibraryDirectory('C:\\a\\b', reader);
    expect(result.valid).toBe(true);
  });

  it('normalizes a win32 UNC path and keeps containment working', async () => {
    const reader: LibraryHashReader = {
      pathStyle: 'win32',
      listFiles: () => ['note.md'],
      realPath: (path) =>
        path === '\\\\server\\share\\a' ? path : '\\\\server\\share\\a\\note.md',
      readFile: () => new TextEncoder().encode('hi\n'),
    };

    const result = await hashLibraryDirectory('\\\\server\\share\\a', reader);
    expect(result.valid).toBe(true);
  });

  it('rejects a relative path that carries a newline as unsafe-name, not hashed', async () => {
    let targetRead = false;
    const reader: LibraryHashReader = {
      pathStyle: 'posix',
      listFiles: () => ['a\nb.md'],
      realPath: (path) => path,
      readFile: () => {
        targetRead = true;
        return new Uint8Array();
      },
    };

    await expect(hashLibraryDirectory('/library', reader)).resolves.toEqual({
      valid: false,
      invalidReason: 'unsafe-name',
    });
    expect(targetRead).toBe(false);
  });

  it('rejects the adversarial one-entry-manifest filename as unsafe-name', async () => {
    // Under the old `\0`/`\n`-delimited manifest, a file named exactly
    // `x\0<hash-of-x>\ny` would spell the same manifest line as a genuinely
    // different single-file directory named `x`. The length-prefixed encoding
    // closes that hole structurally; this name is also refused outright before
    // it ever reaches the manifest.
    const innerHash = await hashLibraryFile(
      '/library/x',
      fakeReader({ x: { bytes: 'x-content' } })
    );
    const adversarialName = `x\0${innerHash.contentHash}\ny`;
    let targetRead = false;
    const reader: LibraryHashReader = {
      pathStyle: 'posix',
      listFiles: () => [adversarialName],
      realPath: (path) => path,
      readFile: () => {
        targetRead = true;
        return new Uint8Array();
      },
    };

    await expect(hashLibraryDirectory('/library', reader)).resolves.toEqual({
      valid: false,
      invalidReason: 'unsafe-name',
    });
    expect(targetRead).toBe(false);
  });

  it('strips trailing slashes without treating `/` as empty', () => {
    expect(normalizeHashPath('/', 'posix')).toBe('/');
    expect(normalizeHashPath('/library/', 'posix')).toBe('/library');
    expect(normalizeHashPath('/library///', 'posix')).toBe('/library');
    expect(normalizeHashPath('C:\\a\\b\\', 'win32')).toBe('C:/a/b');
    expect(normalizeHashPath('\\\\server\\share\\a\\', 'win32')).toBe('//server/share/a');
  });

  it('strips a long run of trailing slashes in linear time', () => {
    const hostile = `/library${'/'.repeat(50_000)}`;
    const start = performance.now();
    expect(normalizeHashPath(hostile, 'posix')).toBe('/library');
    expect(performance.now() - start).toBeLessThan(100);
  });

  it('hashes the same tree when realPath returns a trailing slash', async () => {
    const files = { 'SKILL.md': { bytes: '# Skill\n' } };
    const withSlash: LibraryHashReader = {
      pathStyle: 'posix',
      listFiles: () => ['SKILL.md'],
      realPath: (path) => (path === '/library' ? '/library/' : path),
      readFile: (path) => {
        if (path !== '/library/SKILL.md') throw new Error(`Unexpected read: ${path}`);
        return new TextEncoder().encode('# Skill\n');
      },
    };

    expect(await hashLibraryDirectory('/library', withSlash)).toEqual(
      await hashLibraryDirectory('/library', fakeReader(files))
    );
  });
});

describe('directory hash domain version', () => {
  it('derives the advertised version from DIRECTORY_HASH_DOMAIN', () => {
    expect(directoryHashDomainVersion()).toBe(2);
    expect(directoryHashDomainVersion('mangostudio/library/dir/v3\0')).toBe(3);
  });

  it('treats an omitted advertised domain as v1', () => {
    expect(directoryHashDomainOf(undefined)).toBe(1);
    expect(directoryHashDomainOf(2)).toBe(2);
  });

  it('refuses a domain string that does not carry a version', () => {
    expect(() => directoryHashDomainVersion('mangostudio/library/dir\0')).toThrow(
      /must end in \/v<n>/
    );
  });
});
