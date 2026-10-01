import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { listDistFiles } from '@mangostudio/shared/utils/dist-files';
import {
  compress,
  isCompressible,
  isWorthwhile,
  MIN_INPUT_BYTES,
  writePrecompressedVariants,
} from '../lib/precompress-assets';

const COMPRESSIBLE_JS = 'export const greeting = "hello precompressed world";\n'.repeat(80);

let distDir: string;
let variantsDir: string;

beforeEach(() => {
  distDir = mkdtempSync(join(tmpdir(), 'precompress-dist-'));
  variantsDir = mkdtempSync(join(tmpdir(), 'precompress-out-'));
  mkdirSync(join(distDir, 'assets'), { recursive: true });
  mkdirSync(join(distDir, 'fonts'), { recursive: true });
  writeFileSync(join(distDir, 'index.html'), `<html>${'<p>shell</p>'.repeat(60)}</html>`);
  writeFileSync(join(distDir, 'assets', 'main-AbCd1234.js'), COMPRESSIBLE_JS);
  writeFileSync(join(distDir, 'assets', 'tiny-AbCd1234.js'), 'x');
  // Random-looking bytes behind a compressible name: tried, and rejected on size.
  writeFileSync(
    join(distDir, 'assets', 'noise-AbCd1234.js'),
    Buffer.from(crypto.getRandomValues(new Uint8Array(2048)))
  );
  writeFileSync(join(distDir, 'fonts', 'inter.woff2'), COMPRESSIBLE_JS);
  writeFileSync(join(distDir, 'icon.png'), COMPRESSIBLE_JS);
});

afterEach(() => {
  rmSync(distDir, { recursive: true, force: true });
  rmSync(variantsDir, { recursive: true, force: true });
});

describe('isCompressible', () => {
  test.each([
    ['/assets/main-AbCd1234.js', true],
    ['/assets/style-AbCd1234.css', true],
    ['/index.html', true],
    ['/site.webmanifest', true],
    ['/logo.SVG', true],
    ['/build-info.json', true],
    ['/fonts/inter.woff2', false],
    ['/icon.png', false],
    ['/favicon.ico', false],
    ['/assets/main.js.map.bin', false],
    ['/no-extension', false],
    ['/dir.js/no-extension', false],
  ])('%s -> %p', (urlPath, expected) => {
    expect(isCompressible(urlPath)).toBe(expected);
  });
});

describe('isWorthwhile', () => {
  test('refuses an input below the size floor however well it compresses', () => {
    expect(isWorthwhile(MIN_INPUT_BYTES - 1, 1)).toBe(false);
  });

  test('refuses a saving under 128 bytes or under 5 percent', () => {
    expect(isWorthwhile(1000, 900)).toBe(false);
    expect(isWorthwhile(10_000, 9_600)).toBe(false);
  });

  test('accepts a saving that clears both floors', () => {
    expect(isWorthwhile(1000, 800)).toBe(true);
  });
});

describe('compress', () => {
  test.each([
    ['gzip', gunzipSync],
    ['br', brotliDecompressSync],
  ] as const)('%s decodes back to the original bytes', (coding, decode) => {
    const original = Buffer.from(COMPRESSIBLE_JS);
    const compressed = compress(coding, original);

    expect(compressed.byteLength).toBeLessThan(original.byteLength);
    expect(Buffer.from(decode(compressed)).equals(original)).toBe(true);
  });

  test.each(['gzip', 'br'] as const)('%s output is deterministic', (coding) => {
    const original = Buffer.from(COMPRESSIBLE_JS);

    expect(
      Buffer.from(compress(coding, original)).equals(Buffer.from(compress(coding, original)))
    ).toBe(true);
  });
});

describe('writePrecompressedVariants', () => {
  test('writes gzip and Brotli copies of compressible files only', () => {
    const variants = writePrecompressedVariants(distDir, variantsDir, listDistFiles(distDir));

    const written = variants.map((variant) => `${variant.urlPath}:${variant.coding}`);
    expect(written).toEqual([
      '/assets/main-AbCd1234.js:br',
      '/assets/main-AbCd1234.js:gzip',
      '/index.html:br',
      '/index.html:gzip',
    ]);
  });

  test('stores each variant so it decodes to the identity bytes', () => {
    const variants = writePrecompressedVariants(distDir, variantsDir, listDistFiles(distDir));

    for (const variant of variants) {
      const identity = readFileSync(join(distDir, ...variant.urlPath.split('/').filter(Boolean)));
      const stored = readFileSync(variant.filePath);
      const decoded = variant.coding === 'gzip' ? gunzipSync(stored) : brotliDecompressSync(stored);

      expect(stored.byteLength).toBe(variant.compressedBytes);
      expect(identity.byteLength).toBe(variant.originalBytes);
      expect(Buffer.from(decoded).equals(identity)).toBe(true);
      expect(variant.filePath.startsWith(variantsDir)).toBe(true);
    }
  });

  test('never writes into the dist directory', () => {
    const before = listDistFiles(distDir);
    writePrecompressedVariants(distDir, variantsDir, before);

    expect(listDistFiles(distDir)).toEqual(before);
  });

  test('produces byte-identical output on a second run', () => {
    const urlPaths = listDistFiles(distDir);
    const first = writePrecompressedVariants(distDir, variantsDir, urlPaths);
    const firstBytes = first.map((variant) => readFileSync(variant.filePath));
    const second = writePrecompressedVariants(distDir, variantsDir, urlPaths);

    expect(second.map((variant) => variant.filePath)).toEqual(first.map((v) => v.filePath));
    second.forEach((variant, index) => {
      expect(readFileSync(variant.filePath).equals(firstBytes[index] as Buffer)).toBe(true);
    });
  });
});
