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

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';
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

const GZIP_LEVEL = 6;
const BROTLI_QUALITY = 6;

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
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_GENERIC,
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
  urlPaths: readonly string[]
): PrecompressedVariant[] {
  const variants: PrecompressedVariant[] = [];
  for (const urlPath of urlPaths) {
    if (!isCompressible(urlPath)) continue;
    const original = new Uint8Array(readFileSync(distFilePath(distDir, urlPath)));
    for (const coding of VARIANT_CODINGS) {
      const compressed = compress(coding, original);
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
  return variants;
}
