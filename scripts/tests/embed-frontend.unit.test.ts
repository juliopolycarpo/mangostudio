import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listDistFiles } from '@mangostudio/shared/utils/dist-files';

import {
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

describe('renderFrontendManifestModule', () => {
  test('emits one file-loader import per file keyed by URL path', () => {
    const urlPaths = listDistFiles(distDir);
    const source = renderFrontendManifestModule(distDir, urlPaths);

    expect(source).toContain(
      `import f0 from ${JSON.stringify(join(distDir, 'assets', 'index-AbCd1234.js'))} with { type: 'file' };`
    );
    expect(source).toContain('export const embeddedFrontend: Record<string, string | null> = {');
    expect(source).toContain('"/index.html": f3 as unknown as string,');
    expect(source).toContain('"/assets/nested/font.woff2": f1 as unknown as string,');
  });
});

describe('renderFrontendManifestModule variants', () => {
  test('keeps variants out of the route manifest and keys them by identity path', () => {
    const urlPaths = listDistFiles(distDir);
    const source = renderFrontendManifestModule(distDir, urlPaths, [
      {
        urlPath: '/assets/index-AbCd1234.js',
        coding: 'br',
        filePath: '/out/variants/br/assets/index-AbCd1234.js.br',
        originalBytes: 1000,
        compressedBytes: 300,
      },
      {
        urlPath: '/assets/index-AbCd1234.js',
        coding: 'gzip',
        filePath: '/out/variants/gzip/assets/index-AbCd1234.js.gz',
        originalBytes: 1000,
        compressedBytes: 350,
      },
    ]);

    expect(source).toContain(
      `import v0 from "/out/variants/br/assets/index-AbCd1234.js.br" with { type: 'file' };`
    );
    expect(source).toContain(
      `import v1 from "/out/variants/gzip/assets/index-AbCd1234.js.gz" with { type: 'file' };`
    );
    expect(source).toContain(
      '"/assets/index-AbCd1234.js": { "br": v0 as unknown as string, "gzip": v1 as unknown as string },'
    );
    const routes = source.slice(
      source.indexOf('export const embeddedFrontend:'),
      source.indexOf('export const embeddedFrontendEncodings')
    );
    expect(routes).not.toContain('.br');
    expect(routes).not.toContain('v0');
  });

  const gzipCopy = (urlPath: string) => ({
    urlPath,
    coding: 'gzip' as const,
    filePath: `/out/variants/gzip${urlPath}.gz`,
    originalBytes: 1000,
    compressedBytes: 350,
  });
  const brotliCopy = (urlPath: string) => ({
    urlPath,
    coding: 'br' as const,
    filePath: `/out/variants/br${urlPath}.br`,
    originalBytes: 1000,
    compressedBytes: 300,
  });

  test('leaves the identity bytes out of a hashed asset that has a gzip copy', () => {
    const source = renderFrontendManifestModule(distDir, listDistFiles(distDir), [
      brotliCopy('/assets/index-AbCd1234.js'),
      gzipCopy('/assets/index-AbCd1234.js'),
    ]);

    // The key stays, so the route and the doctor's file count do not change.
    expect(source).toContain('"/assets/index-AbCd1234.js": null,');
    expect(source).not.toContain(JSON.stringify(join(distDir, 'assets', 'index-AbCd1234.js')));
  });

  test('keeps identity where the server could not inflate it', () => {
    // Brotli only: no gzip copy to inflate. Root file: the doctor reads /build-info.json from the manifest.
    const source = renderFrontendManifestModule(distDir, listDistFiles(distDir), [
      brotliCopy('/assets/index-AbCd1234.js'),
      gzipCopy('/index.html'),
      gzipCopy('/build-info.json'),
    ]);

    expect(source).toContain(JSON.stringify(join(distDir, 'assets', 'index-AbCd1234.js')));
    expect(source).toContain(JSON.stringify(join(distDir, 'index.html')));
    expect(source).toContain(JSON.stringify(join(distDir, 'build-info.json')));
    expect(source).not.toContain(': null,');
  });

  test('emits an empty encodings table when nothing was compressed', () => {
    const source = renderFrontendManifestModule(distDir, listDistFiles(distDir));

    expect(source).toContain(
      'export const embeddedFrontendEncodings: Record<string, Record<string, string>> = {\n};'
    );
  });
});

describe('renderEmbedEntryModule', () => {
  test('registers the manifest before dynamically importing the CLI entry', () => {
    const source = renderEmbedEntryModule(
      '/repo/apps/api/src/server/embedded-frontend.ts',
      '/repo/apps/api/src/index.ts'
    );

    const registerIndex = source.indexOf(
      'registerEmbeddedFrontend(embeddedFrontend, embeddedFrontendEncodings);'
    );
    const bootIndex = source.indexOf('await import("/repo/apps/api/src/index.ts");');
    expect(source).toContain(
      'registerEmbeddedFrontend(embeddedFrontend, embeddedFrontendEncodings);'
    );
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

  test('embeds precompressed variants beside the identity files, outside dist', () => {
    writeFileSync(
      join(distDir, 'assets', 'big-AbCd1234.js'),
      'console.log("big chunk");\n'.repeat(80)
    );
    const result = writeEmbedModules({
      distDir,
      embedDir,
      registryModulePath: '/repo/apps/api/src/server/embedded-frontend.ts',
      apiEntryPath: '/repo/apps/api/src/index.ts',
    });

    // Identity count is the route count; variants never inflate it.
    expect(result.fileCount).toBe(5);
    expect(result.variantCount).toBe(2);
    expect(result.variantBytes).toBeGreaterThan(0);
    const manifest = readFileSync(result.manifestPath, 'utf8');
    expect(manifest).toContain('"/assets/big-AbCd1234.js": { "br": v');
    expect(listDistFiles(distDir)).toHaveLength(5);
    // Guard: a hashed asset with a gzip copy must not embed its identity bytes again. It keeps its
    // route (`null` value) and its file stays out of the compiled binary (no import of it).
    expect(manifest).toContain('"/assets/big-AbCd1234.js": null,');
    expect(manifest).not.toContain(join(distDir, 'assets', 'big-AbCd1234.js'));
    // `index-AbCd1234.js` is below the compression threshold: no copy, so identity stays.
    expect(manifest).toContain(join(distDir, 'assets', 'index-AbCd1234.js'));
  });

  test('drops variants left behind by an earlier build', () => {
    const options = {
      distDir,
      embedDir,
      registryModulePath: '/repo/apps/api/src/server/embedded-frontend.ts',
      apiEntryPath: '/repo/apps/api/src/index.ts',
    };
    const big = join(distDir, 'assets', 'big-AbCd1234.js');
    writeFileSync(big, 'console.log("big chunk");\n'.repeat(80));
    expect(writeEmbedModules(options).variantCount).toBe(2);

    rmSync(big);
    const second = writeEmbedModules(options);

    expect(second.variantCount).toBe(0);
    expect(existsSync(join(embedDir, 'variants'))).toBe(false);
    expect(readFileSync(second.manifestPath, 'utf8')).not.toContain('big-AbCd1234');
  });

  test('keeps compressed output between builds while clearing the variants directory', () => {
    const options = {
      distDir,
      embedDir,
      registryModulePath: '/repo/apps/api/src/server/embedded-frontend.ts',
      apiEntryPath: '/repo/apps/api/src/index.ts',
    };
    writeFileSync(
      join(distDir, 'assets', 'big-AbCd1234.js'),
      'console.log("big chunk");\n'.repeat(80)
    );
    const first = writeEmbedModules(options);
    const cacheDir = join(embedDir, 'compression-cache');
    const cachedAfterFirst = readdirSync(cacheDir).sort();
    expect(
      cachedAfterFirst.length,
      `expected cache entries after the first build: br + gzip of the 2 KB chunk | received: ${cachedAfterFirst}`
    ).toBe(2);

    const second = writeEmbedModules(options);

    expect(readdirSync(cacheDir).sort()).toEqual(cachedAfterFirst);
    expect(second.variantCount).toBe(first.variantCount);
    expect(second.variantBytes).toBe(first.variantBytes);
  });

  // The binary has no disk fallback, so an unservable manifest has to stop the
  // build. Without this it compiles, boots, and answers every route API-only —
  // a silent failure a release pipeline away from the build that caused it.
  test.each([
    ['the dist has no index.html', () => rmSync(join(distDir, 'index.html'))],
    [
      'the dist is empty',
      () => {
        rmSync(distDir, { recursive: true, force: true });
        mkdirSync(distDir, { recursive: true });
      },
    ],
  ])('refuses to embed when %s', (_label, breakDist) => {
    breakDist();

    expect(() =>
      writeEmbedModules({
        distDir,
        embedDir,
        registryModulePath: '/repo/apps/api/src/server/embedded-frontend.ts',
        apiEntryPath: '/repo/apps/api/src/index.ts',
      })
    ).toThrow(/no \/index\.html/);
  });
});
