import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { distFilePath, listDistFiles } from '../../../src/utils/dist-files';

let distDir: string;

beforeEach(() => {
  distDir = mkdtempSync(join(tmpdir(), 'dist-files-'));

  writeFileSync(join(distDir, 'index.html'), '<html></html>');
  writeFileSync(join(distDir, 'build-info.json'), '{}');
  mkdirSync(join(distDir, 'assets', 'nested'), { recursive: true });
  writeFileSync(join(distDir, 'assets', 'index-AbCd1234.js'), 'js');
  writeFileSync(join(distDir, 'assets', 'nested', 'font.woff2'), 'font');
});

afterEach(() => {
  rmSync(distDir, { recursive: true, force: true });
});

describe('listDistFiles', () => {
  test('maps every file to a sorted URL path with / separators, no filtering', () => {
    expect(listDistFiles(distDir)).toEqual([
      '/assets/index-AbCd1234.js',
      '/assets/nested/font.woff2',
      '/build-info.json',
      '/index.html',
    ]);
  });
});

describe('distFilePath', () => {
  test('resolves a root-level URL path back to its absolute path', () => {
    expect(distFilePath(distDir, '/index.html')).toBe(join(distDir, 'index.html'));
  });

  test('resolves a nested URL path back to its absolute path', () => {
    expect(distFilePath(distDir, '/assets/nested/font.woff2')).toBe(
      join(distDir, 'assets', 'nested', 'font.woff2')
    );
  });

  test('round-trips every path listDistFiles returns', () => {
    for (const urlPath of listDistFiles(distDir)) {
      expect(distFilePath(distDir, urlPath)).toBe(
        join(distDir, ...urlPath.split('/').filter(Boolean))
      );
    }
  });
});
