import { describe, expect, it } from 'bun:test';
import {
  GitPathValidationError,
  validateRepoPaths,
} from '../../../../src/modules/git/domain/path-validation';

describe('validateRepoPaths', () => {
  it('keeps safe repository-relative paths in request order', () => {
    expect(validateRepoPaths('/srv/repo', ['src/index.ts', 'docs/file name.md'])).toEqual([
      'src/index.ts',
      'docs/file name.md',
    ]);
  });

  it.each([
    '/etc/passwd',
    '../outside',
    'src/../../outside',
    'C:\\Windows\\system.ini',
    '..\\outside',
    '',
    'bad\0path',
  ])('rejects paths outside the repository boundary: %s', (path) => {
    expect(() => validateRepoPaths('/srv/repo', [path])).toThrow(GitPathValidationError);
  });
});
