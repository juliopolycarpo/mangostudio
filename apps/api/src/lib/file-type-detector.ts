/**
 * Teaches Elysia how to read a file's real type from its bytes.
 *
 * Elysia 2 no longer bundles a detector, and `t.File({ type })` fails closed
 * without one: every typed upload is rejected with 422 and a `missing file type
 * detector` warning, valid files included. Registering it on the application
 * instance alone is not enough, because the check belongs to the route schema
 * rather than the app — any composition that mounts a typed-file route without
 * going through `app.ts` (every route test, and any future entrypoint) would
 * reject uploads that production accepts.
 *
 * So this is a function each module owning a typed-file route calls before its
 * routes are declared, rather than an import side effect: an unused-looking
 * import gets removed by tooling, a call does not.
 */

import { setFileTypeDetector } from 'elysia';
import { fileTypeFromBlob, fileTypeFromBuffer } from 'file-type';

export interface DetectedFileType {
  readonly mime: string;
  readonly ext: string;
}

type FileTypeDetector = (bytes: Uint8Array | ArrayBuffer) => Promise<DetectedFileType | undefined>;

/**
 * Detect bytes with the retained file-type package, returning null for an unknown type.
 * Detector errors propagate so callers keep their existing error handling.
 *
 * @example
 * const bytes = await file.arrayBuffer();
 * const detected = await detectFileType(bytes);
 * if (detected?.mime === 'image/png') console.log(detected.ext);
 */
export async function detectFileType(
  bytes: Uint8Array | ArrayBuffer,
  detector: FileTypeDetector = fileTypeFromBuffer
): Promise<DetectedFileType | null> {
  const detected = await detector(bytes);
  return detected ? { mime: detected.mime, ext: detected.ext } : null;
}

let registered = false;

/**
 * Register the Blob detector once per process. Safe to call from several modules.
 *
 * @example
 * registerFileTypeDetector();
 * const schema = t.File({ type: 'image/*' });
 */
export function registerFileTypeDetector(): void {
  if (registered) return;
  registered = true;
  setFileTypeDetector(fileTypeFromBlob);
}
