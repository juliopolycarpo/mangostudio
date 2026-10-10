import { describe, expect, test } from 'bun:test';
import { join, posix, win32 } from 'node:path';
import { asGitPath, gitSpelling } from '../../support/git-path';

describe('gitSpelling', () => {
  test('writes a Windows path with the forward slashes Git prints', () => {
    const hostPath = win32.join('C:\\Users\\runneradmin\\AppData\\Local\\Temp', 'repo', 'feature');
    const received = gitSpelling(hostPath, win32.sep);

    expect(
      received,
      `expected git spelling: C:/Users/runneradmin/AppData/Local/Temp/repo/feature | received: ${received}`
    ).toBe('C:/Users/runneradmin/AppData/Local/Temp/repo/feature');
  });

  test('keeps a UNC path rooted at two slashes', () => {
    expect(gitSpelling('\\\\server\\share\\repo', win32.sep)).toBe('//server/share/repo');
  });

  test('leaves a POSIX path alone, including a backslash that is part of a name', () => {
    const hostPath = posix.join('/tmp', 'repo', 'odd\\name');

    expect(gitSpelling(hostPath, posix.sep)).toBe('/tmp/repo/odd\\name');
  });
});

describe('asGitPath', () => {
  test('spells a host-joined path with forward slashes on every host', () => {
    // `join` uses the separator of the host running the test, so the answer is the same
    // forward-slash string on a POSIX host and on a Windows one.
    expect(asGitPath(join('tmp', 'repo', 'feature'))).toBe('tmp/repo/feature');
  });

  test('can be passed to map, which also hands it an index and the array', () => {
    const hostPaths = [join('tmp', 'main'), join('tmp', 'feature')];

    expect(hostPaths.map(asGitPath)).toEqual(['tmp/main', 'tmp/feature']);
  });
});
