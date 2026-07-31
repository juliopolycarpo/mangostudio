/**
 * What may become a tool avatar.
 *
 * The same gate runs on an uploaded file and on bytes fetched from a remote URL,
 * because once cached they are served from our origin the same way and a
 * remote host is no more trustworthy than an upload.
 */

import {
  TOOL_IMAGE_MAX_BYTES,
  TOOL_IMAGE_MIME_TYPES,
  type ToolImageMimeType,
} from '@mangostudio/shared/tool-identity';
import { fileTypeFromBuffer } from 'file-type';

export class InvalidToolImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidToolImageError';
  }
}

export interface ValidatedToolImage {
  readonly bytes: Uint8Array;
  readonly mimeType: ToolImageMimeType;
  readonly extension: string;
}

const EXTENSION_BY_MIME: Record<ToolImageMimeType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

function isAllowedMime(mime: string): mime is ToolImageMimeType {
  return (TOOL_IMAGE_MIME_TYPES as readonly string[]).includes(mime);
}

/**
 * SVG is XML, so it has no magic bytes to match and would otherwise fall out of
 * the allowlist as a nameless "unsupported type".
 *
 * It gets its own answer because it is the one format users will reasonably
 * expect to work and the one that must never be accepted: an SVG can carry
 * script, and this image is served from our own origin under the viewer's
 * session. Sniffing the opening tag is enough — nothing is being defended
 * against here except a user's honest attempt to upload a logo.
 */
function looksLikeSvg(bytes: Uint8Array): boolean {
  const prefix = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, Math.min(bytes.byteLength, 256)))
    .trimStart()
    .toLowerCase();
  return prefix.startsWith('<svg') || (prefix.startsWith('<?xml') && prefix.includes('<svg'));
}

/**
 * Decides the type from the bytes, never from a filename or a `Content-Type`.
 * Both of those are supplied by whoever is being validated.
 */
export async function validateToolImageBytes(bytes: Uint8Array): Promise<ValidatedToolImage> {
  if (bytes.byteLength === 0) {
    throw new InvalidToolImageError('The image file is empty.');
  }
  if (bytes.byteLength > TOOL_IMAGE_MAX_BYTES) {
    throw new InvalidToolImageError(
      `The image is larger than the ${Math.floor(TOOL_IMAGE_MAX_BYTES / 1024)} KiB limit.`
    );
  }
  if (looksLikeSvg(bytes)) {
    throw new InvalidToolImageError('SVG images are not accepted. Use PNG, JPEG, or WebP.');
  }

  const detected = await fileTypeFromBuffer(bytes);
  if (!detected || !isAllowedMime(detected.mime)) {
    throw new InvalidToolImageError('The image must be a PNG, JPEG, or WebP file.');
  }

  return { bytes, mimeType: detected.mime, extension: EXTENSION_BY_MIME[detected.mime] };
}
