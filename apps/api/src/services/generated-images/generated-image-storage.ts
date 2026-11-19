import { mkdirSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { getConfig } from '../../lib/config';
import { resolveContainedPath } from '../../utils/paths';

const MIME_TO_EXTENSION = {
  'image/avif': '.avif',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
} as const;

type SupportedMimeType = keyof typeof MIME_TO_EXTENSION;

/** `/images/<name>` as it appears in rows, message parts and tool results. */
const IMAGE_URL_PREFIX = '/images/';

export interface SaveGeneratedImageInput {
  data: ArrayBuffer | Uint8Array | Buffer | string;
  mimeType: SupportedMimeType;
  encoding?: 'base64';
  filenamePrefix?: string;
}

function getExtensionForMimeType(mimeType: SupportedMimeType): string {
  return MIME_TO_EXTENSION[mimeType];
}

function createFilename(mimeType: SupportedMimeType, filenamePrefix: string): string {
  return `${filenamePrefix}-${Date.now()}-${crypto.randomUUID()}${getExtensionForMimeType(mimeType)}`;
}

function toWritableData(input: SaveGeneratedImageInput): string | Uint8Array | Buffer {
  if (input.encoding === 'base64') {
    return Buffer.from(input.data as string, 'base64');
  }

  if (input.data instanceof ArrayBuffer) {
    return new Uint8Array(input.data);
  }

  return input.data;
}

export function normalizeGeneratedImageMimeType(mimeType: string): SupportedMimeType {
  if (mimeType in MIME_TO_EXTENSION) {
    return mimeType as SupportedMimeType;
  }

  throw new Error(`Unsupported generated image MIME type: ${mimeType}`);
}

export async function saveGeneratedImage(input: SaveGeneratedImageInput): Promise<string> {
  const directory = getConfig().images.dir;
  mkdirSync(directory, { recursive: true });

  const filename = createFilename(input.mimeType, input.filenamePrefix ?? 'generated');
  const outputPath = join(directory, filename);

  await Bun.write(outputPath, toWritableData(input));

  return `${IMAGE_URL_PREFIX}${filename}`;
}

/**
 * The shape `createFilename` writes: `<prefix>-<epoch ms>-<uuid>.<ext>`. The
 * images directory is user-configurable, so reclaiming only names that match
 * keeps a sweep away from files the app did not write.
 */
const GENERATED_IMAGE_FILENAME_PATTERN = new RegExp(
  `^[A-Za-z0-9_-]+-\\d{10,}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:${Object.values(
    MIME_TO_EXTENSION
  )
    .map((extension) => extension.replace('.', '\\.'))
    .join('|')})$`
);

/** True for a bare file name this module could have written. */
export function isGeneratedImageFilename(filename: string): boolean {
  return GENERATED_IMAGE_FILENAME_PATTERN.test(filename);
}

/**
 * The file name behind an `/images/<name>` URL, or null for anything else
 * (another route, a nested path, a name this module never writes).
 *
 * @example
 * generatedImageFilenameFromUrl('/images/generated-1700000000000-<uuid>.png');
 */
export function generatedImageFilenameFromUrl(imageUrl: string): string | null {
  if (!imageUrl.startsWith(IMAGE_URL_PREFIX)) return null;
  const filename = imageUrl.slice(IMAGE_URL_PREFIX.length);
  return isGeneratedImageFilename(filename) ? filename : null;
}

/** Every generated image file name mentioned as `/images/<name>` anywhere in `text`. */
export function findGeneratedImageFilenames(text: string): string[] {
  const filenames: string[] = [];
  for (const match of text.matchAll(/\/images\/([A-Za-z0-9._-]+)/g)) {
    const filename = match[1];
    if (filename && isGeneratedImageFilename(filename)) filenames.push(filename);
  }
  return filenames;
}

export interface StoredGeneratedImageFile {
  filename: string;
  modifiedAtMs: number;
}

/**
 * Lists the generated image files in the configured images directory. An
 * absent directory is empty, not an error: nothing has been generated yet.
 */
export async function listStoredGeneratedImages(): Promise<StoredGeneratedImageFile[]> {
  const directory = getConfig().images.dir;
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const files: StoredGeneratedImageFile[] = [];
  for (const filename of names) {
    if (!isGeneratedImageFilename(filename)) continue;
    try {
      const info = await stat(join(directory, filename));
      if (info.isFile()) files.push({ filename, modifiedAtMs: info.mtimeMs });
    } catch (error) {
      // Removed between the listing and the stat (another sweep, the user).
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return files;
}

/**
 * Removes one generated image file. A file that is already gone is not an
 * error. Returns false, touching nothing, for a name this module never writes.
 */
export async function deleteStoredGeneratedImage(filename: string): Promise<boolean> {
  if (!isGeneratedImageFilename(filename)) return false;
  const absolutePath = resolveContainedPath(getConfig().images.dir, filename);
  if (!absolutePath) return false;
  await rm(absolutePath, { force: true });
  return true;
}
