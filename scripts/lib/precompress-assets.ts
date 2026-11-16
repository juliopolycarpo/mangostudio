/**
 * Build-time gzip and Brotli variants of the frontend bundle, for the embedded
 * (standalone binary) serving path.
 *
 * The server never compresses a response: a ready representation is chosen from
 * `Accept-Encoding` and streamed as stored. That moves the whole CPU cost here,
 * to the one place that runs once per release, and makes the output
 * deterministic (same bytes in, same bytes out), so a variant never changes
 * without its source changing.
 *
 * Variants are written under a build scratch directory, never into `dist/`:
 * `dist/` also feeds the `frontend-dist` tarball and the bundle report, and
 * neither wants sidecars.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, constants, gunzipSync } from 'node:zlib';

import { distFilePath } from '@mangostudio/shared/utils/dist-files';

/** Codings a variant can be stored in. Order is the server's tie-break preference. */
const VARIANT_CODINGS = ['br', 'gzip'] as const;
export type VariantCoding = (typeof VARIANT_CODINGS)[number];

/** File extension appended to a variant's file name on disk. */
const VARIANT_EXTENSION: Readonly<Record<VariantCoding, string>> = { br: '.br', gzip: '.gz' };

/**
 * Text formats only. Fonts, images and other already-compressed media gain
 * nothing and would only grow the binary, so they are never even tried.
 */
const COMPRESSIBLE_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.css',
  '.html',
  '.json',
  '.svg',
  '.webmanifest',
  '.txt',
  '.xml',
]);

/** Below this a variant's framing overhead and extra route are not worth it. */
export const MIN_INPUT_BYTES = 256;
/** A variant must save at least this many bytes ... */
const MIN_SAVING_BYTES = 128;
/** ... and at least this fraction of the original. */
const MIN_SAVING_RATIO = 0.05;

/**
 * Maximum effort, because it is paid once per build and the bytes are paid on
 * every download. On the pinned bundle (123 text files, 6.05 MB) Brotli 11 takes
 * about 11 s against 0.3 s at quality 6, and the copies are about 6 % smaller in
 * total (2.51 MB against 2.67 MB). Gzip 9 is nearly free by comparison.
 */
const GZIP_LEVEL = 9;
const BROTLI_QUALITY = 11;
const BROTLI_MODE = constants.BROTLI_MODE_GENERIC;

export interface PrecompressedVariant {
  /** URL path of the identity file this variant encodes ('/assets/main-x.js'). */
  urlPath: string;
  coding: VariantCoding;
  /** Absolute path of the stored variant. */
  filePath: string;
  originalBytes: number;
  compressedBytes: number;
}

/** True when a file's extension names a compressible text format. // Usage: isCompressible('/assets/a.js') */
export function isCompressible(urlPath: string): boolean {
  const dot = urlPath.lastIndexOf('.');
  if (dot === -1 || urlPath.lastIndexOf('/') > dot) return false;
  return COMPRESSIBLE_EXTENSIONS.has(urlPath.slice(dot).toLowerCase());
}

/** Compresses `bytes` as `coding`, deterministically. // Usage: compress('gzip', bytes) */
export function compress(coding: VariantCoding, bytes: Uint8Array<ArrayBuffer>): Uint8Array {
  if (coding === 'gzip') return Bun.gzipSync(bytes, { level: GZIP_LEVEL });
  // Generic mode and an explicit size hint, spelled out because Bun accepted an
  // out-of-range quality without complaint: this is not validated for us.
  return brotliCompressSync(bytes, {
    params: {
      [constants.BROTLI_PARAM_MODE]: BROTLI_MODE,
      [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
      [constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength,
    },
  });
}

/**
 * Whether a compressed copy is worth shipping: the input is big enough, and the
 * saving clears both an absolute and a relative floor.
 * // Usage: isWorthwhile(1000, 400)
 */
export function isWorthwhile(originalBytes: number, compressedBytes: number): boolean {
  if (originalBytes < MIN_INPUT_BYTES) return false;
  const saving = originalBytes - compressedBytes;
  return saving >= MIN_SAVING_BYTES && saving >= originalBytes * MIN_SAVING_RATIO;
}

/**
 * Compresses every compressible file in `urlPaths` and writes each worthwhile
 * variant to `<variantsDir>/<coding>/<urlPath><ext>`. Returns what was written,
 * in `urlPaths` order then coding order, so the generated manifest is stable.
 *
 * @example
 * const variants = writePrecompressedVariants(distDir, variantsDir, listDistFiles(distDir));
 */
export function writePrecompressedVariants(
  distDir: string,
  variantsDir: string,
  urlPaths: readonly string[],
  options: PrecompressOptions = {}
): PrecompressedVariant[] {
  const { cacheDir, compressor = compress } = options;
  const usedCacheKeys = new Set<string>();
  const variants: PrecompressedVariant[] = [];
  for (const urlPath of urlPaths) {
    if (!isCompressible(urlPath)) continue;
    const original = new Uint8Array(readFileSync(distFilePath(distDir, urlPath)));
    // Same verdict `isWorthwhile` would give, reached before compressing, so a
    // tiny file costs neither a compressor call nor a cache entry.
    if (original.byteLength < MIN_INPUT_BYTES) continue;
    for (const coding of VARIANT_CODINGS) {
      const compressed = cacheDir
        ? compressThroughCache(cacheDir, coding, original, compressor, usedCacheKeys)
        : compressor(coding, original);
      if (!isWorthwhile(original.byteLength, compressed.byteLength)) continue;
      const filePath = distFilePath(
        join(variantsDir, coding),
        `${urlPath}${VARIANT_EXTENSION[coding]}`
      );
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, compressed);
      variants.push({
        urlPath,
        coding,
        filePath,
        originalBytes: original.byteLength,
        compressedBytes: compressed.byteLength,
      });
    }
  }
  if (cacheDir) pruneCache(cacheDir, usedCacheKeys);
  return variants;
}

export interface PrecompressOptions {
  /**
   * A directory that outlives the build, holding compressed output by content
   * hash. Brotli 11 on the bundle is ~11 s, and an unchanged file compresses to
   * the same bytes, so a rebuild reads the copy back instead of redoing it.
   * Unset: every file is compressed every time.
   */
  cacheDir?: string;
  /** The compressor, replaceable so a test can count calls. Defaults to {@link compress}. */
  compressor?: (coding: VariantCoding, bytes: Uint8Array<ArrayBuffer>) => Uint8Array;
}

/**
 * The cache key for one (coding, bytes) pair. It names everything the output
 * is a function of: the coding, every encoder parameter {@link compress} sets
 * (built from the same constants, so changing one retires old entries), and the
 * Bun build that ships the zlib and Brotli code (an upgrade can change the
 * bytes), then the input.
 */
function cacheKey(coding: VariantCoding, bytes: Uint8Array): string {
  const parameters =
    coding === 'gzip'
      ? `level=${GZIP_LEVEL}`
      : `quality=${BROTLI_QUALITY},mode=${BROTLI_MODE},sizeHint=input`;
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(`${coding}:${parameters}:${Bun.revision}\0`);
  hasher.update(bytes);
  return `${coding}-${hasher.digest('hex')}`;
}

/** True when `compressed` decodes back to exactly `original`. */
function roundTrips(coding: VariantCoding, compressed: Uint8Array, original: Uint8Array): boolean {
  try {
    const decoded = coding === 'gzip' ? gunzipSync(compressed) : brotliDecompressSync(compressed);
    return Buffer.compare(decoded, original) === 0;
  } catch {
    return false;
  }
}

/**
 * Returns the cached copy of `original` as `coding`, compressing and storing it
 * on a miss.
 *
 * A hit is trusted only after it decodes back to the input. The key already
 * says what the entry should contain; the decode answers the other question,
 * whether the file on disk still does (a truncated write, bit rot, a hand
 * edit), and a bad entry would ship a broken asset inside the binary. It needs
 * no sidecar to go stale, and costs tens of milliseconds for the whole bundle
 * against seconds of Brotli. A stored output hash would be a little cheaper
 * and prove less: it would catch damage to the file but not a wrong entry.
 */
function compressThroughCache(
  cacheDir: string,
  coding: VariantCoding,
  original: Uint8Array<ArrayBuffer>,
  compressor: NonNullable<PrecompressOptions['compressor']>,
  usedKeys: Set<string>
): Uint8Array {
  const key = cacheKey(coding, original);
  usedKeys.add(key);
  const cachedPath = join(cacheDir, key);
  const cached = readCachedEntry(cachedPath);
  if (cached && roundTrips(coding, cached, original)) return cached;
  const compressed = compressor(coding, original);
  mkdirSync(cacheDir, { recursive: true });
  // Written under a temporary name and renamed, so an interrupted build never
  // leaves a half-written entry under the real key.
  const pendingPath = `${cachedPath}.${process.pid}.tmp`;
  writeFileSync(pendingPath, compressed);
  renameSync(pendingPath, cachedPath);
  return compressed;
}

/** The stored bytes, or `undefined` when there is no readable entry (a miss, not an error). */
function readCachedEntry(cachedPath: string): Uint8Array | undefined {
  try {
    return new Uint8Array(readFileSync(cachedPath));
  } catch {
    return undefined;
  }
}

/**
 * Drops entries this build did not use, so the cache holds one build's worth,
 * not every build's. Also sweeps `.tmp` files an interrupted build left behind.
 */
function pruneCache(cacheDir: string, usedKeys: ReadonlySet<string>): void {
  if (!existsSync(cacheDir)) return;
  for (const name of readdirSync(cacheDir)) {
    if (!usedKeys.has(name)) rmSync(join(cacheDir, name), { force: true });
  }
}
