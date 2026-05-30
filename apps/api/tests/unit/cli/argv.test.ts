import { describe, expect, it } from 'bun:test';
import { extractUserArgs } from '../../../src/cli/argv';

describe('extractUserArgs', () => {
  it('drops the exec and entry prefix in dev', () => {
    expect(extractUserArgs(['bun', '/abs/src/index.ts', 'serve', '3000'])).toEqual([
      'serve',
      '3000',
    ]);
  });

  it('returns an empty array when no command is given', () => {
    expect(extractUserArgs(['bun', '/abs/src/index.ts'])).toEqual([]);
  });

  it('filters injected /$bunfs/ runtime paths', () => {
    const argv = ['bun', '/$bunfs/root/index', '/$bunfs/root/index', 'status'];
    expect(extractUserArgs(argv)).toEqual(['status']);
  });

  it('keeps real positional args and flags', () => {
    const argv = ['mango', '/$bunfs/root/index', 'serve', '3000', '-d'];
    expect(extractUserArgs(argv)).toEqual(['serve', '3000', '-d']);
  });
});
