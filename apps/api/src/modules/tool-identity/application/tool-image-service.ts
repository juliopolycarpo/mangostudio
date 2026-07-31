/**
 * Turning an upload or a URL into the four stored image columns.
 *
 * Two things decide the shape of this module. Bytes we serve from our own
 * origin must have been validated by us, whatever their provenance — so an
 * uploaded file and a cached remote image go through exactly the same gate.
 * And fetching a URL a user typed is an SSRF primitive, so the fetch is the
 * guarded one and its result is treated as hostile until it has passed that
 * gate.
 */

import { ERROR_CODES } from '@mangostudio/shared/errors';
import type { ToolImageUpdate } from '@mangostudio/shared/tool-identity';
import { TOOL_IMAGE_MAX_BYTES } from '@mangostudio/shared/tool-identity';
import type { ToolIdentitySelect } from '../../../db/types';
import { type SafeFetchDeps, SafeFetchError, safeFetchBytes } from '../../../lib/safe-fetch';
import type { ToolImageFields } from '../infrastructure/tool-identity-repository';
import {
  buildToolImagePath,
  deleteToolImage,
  writeToolImage,
} from '../infrastructure/tool-image-storage';
import { InvalidToolImageError, validateToolImageBytes } from './tool-image-validation';
import { ToolIdentityError } from './tool-subject';

/** Room for a redirect chain that is a CDN doing its job, and no more. */
const MAX_IMAGE_REDIRECTS = 3;
const IMAGE_FETCH_TIMEOUT_MS = 10_000;

/**
 * The remote fetch is capped above the stored limit rather than at it: the cap
 * is what stops a download, and the validator is what decides whether the image
 * is small enough to keep. Refusing at exactly the stored limit would let a
 * response that is one byte over report itself as a network failure.
 */
const MAX_REMOTE_IMAGE_BYTES = 2 * TOOL_IMAGE_MAX_BYTES;

const NO_IMAGE: ToolImageFields = {
  imageSource: null,
  imageUrl: null,
  imagePath: null,
  imageMimeType: null,
};

function toImageFields(row: ToolIdentitySelect | undefined): ToolImageFields {
  if (!row) return NO_IMAGE;
  return {
    imageSource: row.imageSource,
    imageUrl: row.imageUrl,
    imagePath: row.imagePath,
    imageMimeType: row.imageMimeType,
  };
}

/** True when this patch leaves the identity with an image, without fetching one. */
export function patchKeepsImage(
  patch: ToolImageUpdate | null | undefined,
  existing: ToolIdentitySelect | undefined
): boolean {
  if (patch === undefined) return existing?.imageSource != null;
  return patch !== null;
}

/**
 * The image half of an update, with the disk work it implies still pending.
 *
 * The file a change replaces cannot be deleted while resolving it, because the
 * row that stops pointing at that file has not been written yet — and if the
 * write then fails, the identity is left naming bytes that are gone. So the two
 * deletions an update can owe are handed back as the two ways it can end:
 * `commit` drops what was replaced, `rollback` drops what was written.
 */
export interface ResolvedToolImage {
  readonly fields: ToolImageFields;
  /** Call once the row is written: drops the file the update replaced. */
  commit(): Promise<void>;
  /** Call when the row write failed: drops the file the update wrote. */
  rollback(): Promise<void>;
}

const NOTHING_TO_CLEAN = (): Promise<void> => Promise.resolve();

/** No file changed hands, so neither ending has anything to clean up. */
function unchanged(fields: ToolImageFields): ResolvedToolImage {
  return { fields, commit: NOTHING_TO_CLEAN, rollback: NOTHING_TO_CLEAN };
}

function replacing(
  fields: ToolImageFields,
  existing: ToolIdentitySelect | undefined
): ResolvedToolImage {
  const replaced = existing?.imagePath ?? null;
  // Keeping the new file would strand it: nothing else records its name.
  const written = fields.imagePath !== replaced ? fields.imagePath : null;
  return {
    fields,
    commit: () => deleteToolImage(replaced),
    rollback: () => deleteToolImage(written),
  };
}

/**
 * Resolves the image half of an update, performing the one-time fetch when the
 * user asked for a cached URL.
 */
export async function resolveToolImageFields(
  patch: ToolImageUpdate | null | undefined,
  existing: ToolIdentitySelect | undefined,
  userId: string,
  fetchDeps: Partial<SafeFetchDeps> = {}
): Promise<ResolvedToolImage> {
  if (patch === undefined) return unchanged(toImageFields(existing));

  if (patch === null) return replacing(NO_IMAGE, existing);

  if (!patch.cache) {
    // Hotlinked: the browser loads it, so we keep the address and nothing else.
    return replacing(
      { imageSource: 'url', imageUrl: patch.url, imagePath: null, imageMimeType: null },
      existing
    );
  }

  // Saving an unrelated field — a rename — re-sends the image the dialog is
  // showing. Re-downloading it every time would turn every keystroke's worth of
  // editing into a request to someone else's server.
  if (existing?.imagePath && existing.imageUrl === patch.url) {
    return unchanged(toImageFields(existing));
  }

  const stored = await cacheRemoteImage(patch.url, userId, fetchDeps);
  return replacing({ imageSource: 'url', imageUrl: patch.url, ...stored }, existing);
}

/** Stores an uploaded file, replacing whatever the identity had before. */
export async function storeUploadedToolImage(
  file: File,
  existing: ToolIdentitySelect | undefined,
  userId: string
): Promise<ResolvedToolImage> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const validated = await validateToolImage(bytes);

  const imagePath = buildToolImagePath(userId, validated.extension);
  await writeToolImage(imagePath, validated.bytes);

  return replacing(
    { imageSource: 'upload', imageUrl: null, imagePath, imageMimeType: validated.mimeType },
    existing
  );
}

async function cacheRemoteImage(
  url: string,
  userId: string,
  fetchDeps: Partial<SafeFetchDeps>
): Promise<{ imagePath: string; imageMimeType: string }> {
  let bytes: Uint8Array;
  try {
    const result = await safeFetchBytes(
      url,
      {
        maxBytes: MAX_REMOTE_IMAGE_BYTES,
        maxRedirects: MAX_IMAGE_REDIRECTS,
        timeoutMs: IMAGE_FETCH_TIMEOUT_MS,
      },
      fetchDeps
    );
    bytes = result.bytes;
  } catch (error) {
    if (error instanceof SafeFetchError) {
      throw new ToolIdentityError(
        `The image could not be fetched: ${error.message}`,
        422,
        ERROR_CODES.VALIDATION
      );
    }
    throw error;
  }

  // The advertised content type is not consulted: the remote host chose it, and
  // it is exactly what we are refusing to trust by re-deciding from the bytes.
  const validated = await validateToolImage(bytes);
  const imagePath = buildToolImagePath(userId, validated.extension);
  await writeToolImage(imagePath, validated.bytes);

  return { imagePath, imageMimeType: validated.mimeType };
}

/** Validation failures are the user's to fix, so they surface as 422s. */
async function validateToolImage(bytes: Uint8Array) {
  try {
    return await validateToolImageBytes(bytes);
  } catch (error) {
    if (error instanceof InvalidToolImageError) {
      throw new ToolIdentityError(error.message, 422, ERROR_CODES.VALIDATION);
    }
    throw error;
  }
}
