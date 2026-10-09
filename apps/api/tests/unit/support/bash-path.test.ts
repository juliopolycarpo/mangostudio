import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { bashPath } from '../../support/bash-path';

describe('bashPath', () => {
  test('leaves a path of plain characters bare, spelled with forward slashes', () => {
    expect(bashPath(join('tmp', 'check-1', 'out.txt'))).toBe('tmp/check-1/out.txt');
  });

  test('single-quotes a path with a space and escapes an apostrophe inside it', () => {
    const received = bashPath(join('tmp', "it's here", 'out file.txt'));

    expect(received, `expected one single-quoted word | received: ${received}`).toBe(
      `'tmp/it'"'"'s here/out file.txt'`
    );
  });
});
