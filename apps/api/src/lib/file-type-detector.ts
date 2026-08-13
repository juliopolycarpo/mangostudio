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
import { fileTypeFromBlob } from 'file-type';

let registered = false;

/** Register the detector once per process. Safe to call from several modules. */
export function registerFileTypeDetector(): void {
  if (registered) return;
  registered = true;
  setFileTypeDetector(fileTypeFromBlob);
}
