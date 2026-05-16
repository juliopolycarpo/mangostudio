import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../../lib/config';

const MIME_TO_EXTENSION = {
  'image/avif': '.avif',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
} as const;

type SupportedMimeType = keyof typeof MIME_TO_EXTENSION;

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

  return `/images/${filename}`;
}
