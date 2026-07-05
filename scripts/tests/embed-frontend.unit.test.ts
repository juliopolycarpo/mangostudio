import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listDistFiles,
  renderEmbedEntryModule,
  renderFrontendManifestModule,
  writeEmbedModules,
} from '../lib/embed-frontend';

let distDir: string;
let embedDir: string;

beforeEach(() => {
  distDir = mkdtempSync(join(tmpdir(), 'embed-dist-'));
  embedDir = mkdtempSync(join(tmpdir(), 'embed-out-'));

  writeFileSync(join(distDir, 'index.html'), '<html></html>');
  writeFileSync(join(distDir, 'build-info.json'), '{}');
  mkdirSync(join(distDir, 'assets', 'nested'), { recursive: true });
  writeFileSync(join(distDir, 'assets', 'index-AbCd1234.js'), 'js');
  writeFileSync(join(distDir, 'assets', 'nested', 'font.woff2'), 'font');
});

afterEach(() => {
  rmSync(distDir, { recursive: true, force: true });
  rmSync(embedDir, { recursive: true, force: true });
});

describe('listDistFiles', () => {
  test('maps every file to a sorted URL path with / separators', () => {
    expect(listDistFiles(distDir)).toEqual([
      '/assets/index-AbCd1234.js',
      '/assets/nested/font.woff2',
      '/build-info.json',
      '/index.html',
    ]);
  });
});

describe('renderFrontendManifestModule', () => {
  test('emits one file-loader import per file keyed by URL path', () => {
    const urlPaths = listDistFiles(distDir);
    const source = renderFrontendManifestModule(distDir, urlPaths);

    expect(source).toContain(
      `import f0 from ${JSON.stringify(join(distDir, 'assets', 'index-AbCd1234.js'))} with { type: 'file' };`
    );
    expect(source).toContain('export const embeddedFrontend: Record<string, string> = {');
    expect(source).toContain('"/index.html": f3,');
    expect(source).toContain('"/assets/nested/font.woff2": f1,');
  });
});

describe('renderEmbedEntryModule', () => {
  test('registers the manifest before dynamically importing the CLI entry', () => {
    const source = renderEmbedEntryModule(
      '/repo/apps/api/src/server/embedded-frontend.ts',
      '/repo/apps/api/src/index.ts'
    );

    const registerIndex = source.indexOf('registerEmbeddedFrontend(embeddedFrontend);');
    const bootIndex = source.indexOf('await import("/repo/apps/api/src/index.ts");');
    expect(registerIndex).toBeGreaterThan(-1);
    expect(bootIndex).toBeGreaterThan(registerIndex);
  });
});

describe('writeEmbedModules', () => {
  test('writes manifest and entry modules and reports the file count', () => {
    const result = writeEmbedModules({
      distDir,
      embedDir,
      registryModulePath: '/repo/apps/api/src/server/embedded-frontend.ts',
      apiEntryPath: '/repo/apps/api/src/index.ts',
    });

    expect(result.fileCount).toBe(4);
    expect(result.entryPath).toBe(join(embedDir, 'entry.ts'));
    expect(readFileSync(result.manifestPath, 'utf8')).toContain('"/build-info.json"');
    expect(readFileSync(result.entryPath, 'utf8')).toContain("from './frontend-manifest'");
  });
});
