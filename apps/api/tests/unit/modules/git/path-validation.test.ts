import { describe, expect, it } from 'bun:test';
import {
  GitPathValidationError,
  validateRepoPaths,
} from '../../../../src/modules/git/domain/path-validation';

describe('validateRepoPaths', () => {
  it('keeps safe repository-relative paths in request order', () => {
    expect(validateRepoPaths('/srv/repo', ['src/index.ts', 'docs/file name.md'])).toEqual([
      ':(literal)src/index.ts',
      ':(literal)docs/file name.md',
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

  // These resolve inside the root, so a purely lexical containment check passes
  // them. Without `:(literal)` they reach Git as magic pathspecs and widen the
  // operation to files the caller never selected — `--` does not disable magic.
  it.each([
    ':/',
    ':!a.txt',
    ':(exclude)a.txt',
    ':(glob)**/*.ts',
    ':(top)a.txt',
  ])('neutralizes pathspec magic that lexical containment cannot reject: %s', (path) => {
    expect(validateRepoPaths('/srv/repo', [path])).toEqual([`:(literal)${path}`]);
  });
});
