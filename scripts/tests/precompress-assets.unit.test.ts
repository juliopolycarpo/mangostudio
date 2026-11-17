import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

import { contentEtag } from '@mangostudio/api/internal/lib/http-cache';
import { listDistFiles } from '@mangostudio/shared/utils/dist-files';

import {
  compress,
  isCompressible,
  isWorthwhile,
  MIN_INPUT_BYTES,
  type VariantCoding,
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

  test('records the length and server ETag of the original bytes on every variant', () => {
    const variants = writePrecompressedVariants(distDir, variantsDir, listDistFiles(distDir));

    for (const variant of variants) {
      const identity = readFileSync(join(distDir, ...variant.urlPath.split('/').filter(Boolean)));
      expect(variant.originalBytes).toBe(identity.byteLength);
      expect(variant.originalEtag).toBe(contentEtag(identity));
    }
  });

  test.each(['gzip', 'br'] as const)(
    'fails the build when a freshly produced %s copy does not decode to the original',
    (brokenCoding) => {
      // Truncated: a plausible-looking, smaller output that is not the file.
      const truncating = (coding: VariantCoding, bytes: Uint8Array<ArrayBuffer>): Uint8Array =>
        coding === brokenCoding ? compress(coding, bytes).subarray(0, 20) : compress(coding, bytes);

      expect(() =>
        writePrecompressedVariants(distDir, variantsDir, listDistFiles(distDir), {
          compressor: truncating,
        })
      ).toThrow(
        new RegExp(
          `precompress /assets/main-AbCd1234\\.js: the ${brokenCoding} copy \\(20 bytes\\) does not decode back to the ${Buffer.byteLength(COMPRESSIBLE_JS)} original bytes`
        )
      );
    }
  );

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

/** Wraps `compress` and records each call, so a test can see what a cache skipped. */
function createCountingCompressor() {
  const calls: Array<{ coding: VariantCoding; bytes: number }> = [];
  return {
    calls,
    compressor: (coding: VariantCoding, bytes: Uint8Array<ArrayBuffer>) => {
      calls.push({ coding, bytes: bytes.byteLength });
      return compress(coding, bytes);
    },
  };
}

describe('writePrecompressedVariants with a compression cache', () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'precompress-cache-'));
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  test('compresses nothing on a rebuild of unchanged files, with identical output', () => {
    const urlPaths = listDistFiles(distDir);
    const first = createCountingCompressor();
    const firstRun = writePrecompressedVariants(distDir, variantsDir, urlPaths, {
      cacheDir,
      compressor: first.compressor,
    });
    const firstBytes = firstRun.map((variant) => readFileSync(variant.filePath));
    const second = createCountingCompressor();

    const secondRun = writePrecompressedVariants(distDir, variantsDir, urlPaths, {
      cacheDir,
      compressor: second.compressor,
    });

    expect(
      second.calls.length,
      `expected compressor calls on an unchanged rebuild: 0 | received: ${second.calls.length}`
    ).toBe(0);
    expect(
      first.calls.length,
      'expected the first build to compress every candidate'
    ).toBeGreaterThan(0);
    expect(secondRun.map((variant) => `${variant.urlPath}:${variant.coding}`)).toEqual(
      firstRun.map((variant) => `${variant.urlPath}:${variant.coding}`)
    );
    secondRun.forEach((variant, index) => {
      expect(readFileSync(variant.filePath).equals(firstBytes[index] as Buffer)).toBe(true);
    });
  });

  test('recompresses only the file whose content changed', () => {
    const urlPaths = listDistFiles(distDir);
    writePrecompressedVariants(distDir, variantsDir, urlPaths, { cacheDir });
    writeFileSync(join(distDir, 'assets', 'main-AbCd1234.js'), `${COMPRESSIBLE_JS}// edited\n`);
    const counting = createCountingCompressor();

    const variants = writePrecompressedVariants(distDir, variantsDir, urlPaths, {
      cacheDir,
      compressor: counting.compressor,
    });

    const expectedBytes = Buffer.byteLength(`${COMPRESSIBLE_JS}// edited\n`);
    expect(counting.calls.map((call) => `${call.coding}:${call.bytes}`).sort()).toEqual([
      `br:${expectedBytes}`,
      `gzip:${expectedBytes}`,
    ]);
    const main = variants.find(
      (variant) => variant.urlPath === '/assets/main-AbCd1234.js' && variant.coding === 'br'
    );
    expect(Buffer.from(brotliDecompressSync(readFileSync(main?.filePath ?? ''))).toString()).toBe(
      `${COMPRESSIBLE_JS}// edited\n`
    );
  });

  test('recompresses an entry whose cached bytes do not decode to the input', () => {
    const urlPaths = listDistFiles(distDir);
    writePrecompressedVariants(distDir, variantsDir, urlPaths, { cacheDir });
    for (const name of readdirSync(cacheDir)) writeFileSync(join(cacheDir, name), 'truncated');
    const counting = createCountingCompressor();

    const variants = writePrecompressedVariants(distDir, variantsDir, urlPaths, {
      cacheDir,
      compressor: counting.compressor,
    });

    expect(
      counting.calls.length,
      'expected every corrupt entry to be recompressed'
    ).toBeGreaterThan(0);
    for (const variant of variants) {
      const identity = readFileSync(join(distDir, ...variant.urlPath.split('/').filter(Boolean)));
      const stored = readFileSync(variant.filePath);
      const decoded = variant.coding === 'gzip' ? gunzipSync(stored) : brotliDecompressSync(stored);
      expect(Buffer.from(decoded).equals(identity)).toBe(true);
    }
  });

  test('fails on a broken fresh copy and does not cache it', () => {
    const urlPaths = listDistFiles(distDir);
    const truncating = (coding: VariantCoding, bytes: Uint8Array<ArrayBuffer>): Uint8Array =>
      compress(coding, bytes).subarray(0, 20);

    expect(() =>
      writePrecompressedVariants(distDir, variantsDir, urlPaths, {
        cacheDir,
        compressor: truncating,
      })
    ).toThrow(/does not decode back to the \d+ original bytes; refusing to embed it/);
    expect(readdirSync(cacheDir)).toEqual([]);
  });

  test('drops cache entries the build no longer uses', () => {
    const urlPaths = listDistFiles(distDir);
    writePrecompressedVariants(distDir, variantsDir, urlPaths, { cacheDir });
    const before = readdirSync(cacheDir).length;
    writeFileSync(join(distDir, 'assets', 'main-AbCd1234.js'), `${COMPRESSIBLE_JS}// edited\n`);

    writePrecompressedVariants(distDir, variantsDir, urlPaths, { cacheDir });

    expect(
      readdirSync(cacheDir).length,
      `expected cache entries to stay at one build's worth: ${before} | received: ${readdirSync(cacheDir).length}`
    ).toBe(before);
  });

  test('neither compresses nor caches a file below the minimum input size', () => {
    writeFileSync(join(distDir, 'assets', 'tiny-AbCd1234.js'), 'x'.repeat(MIN_INPUT_BYTES - 1));
    const counting = createCountingCompressor();

    writePrecompressedVariants(distDir, variantsDir, listDistFiles(distDir), {
      cacheDir,
      compressor: counting.compressor,
    });

    expect(
      counting.calls.filter((call) => call.bytes === MIN_INPUT_BYTES - 1),
      `expected no compressor call for a ${MIN_INPUT_BYTES - 1}-byte file`
    ).toEqual([]);
    expect(readdirSync(cacheDir).length).toBe(counting.calls.length);
  });

  test('sweeps a temporary file an interrupted build left behind', () => {
    const urlPaths = listDistFiles(distDir);
    writePrecompressedVariants(distDir, variantsDir, urlPaths, { cacheDir });
    writeFileSync(join(cacheDir, 'br-abandoned.99999.tmp'), 'half written');

    writePrecompressedVariants(distDir, variantsDir, urlPaths, { cacheDir });

    expect(
      readdirSync(cacheDir).filter((name) => name.endsWith('.tmp')),
      'expected no .tmp files in the cache after a completed build'
    ).toEqual([]);
  });

  test('keeps cached copies of a file that is not worth shipping, so it is not retried', () => {
    const urlPaths = listDistFiles(distDir);
    writePrecompressedVariants(distDir, variantsDir, urlPaths, { cacheDir });
    const counting = createCountingCompressor();

    writePrecompressedVariants(distDir, variantsDir, urlPaths, {
      cacheDir,
      compressor: counting.compressor,
    });

    expect(
      counting.calls.filter((call) => call.bytes === 2048),
      'expected no recompression of the 2048-byte noise file that failed isWorthwhile'
    ).toEqual([]);
  });
});
