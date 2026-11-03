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

import { safeFetchBytes, type SafeFetchDeps, SafeFetchError } from '../../../lib/safe-fetch';
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

/**
 * Validated fields prepared outside the database transaction. Newly staged
 * bytes belong to the caller until a row write succeeds; a failed write must
 * roll them back. Replaced-file cleanup uses the row changed by the transaction.
 */
export interface PreparedToolImage {
  readonly fields: ToolImageFields;
  rollback(): Promise<void>;
}

function prepared(fields: ToolImageFields): PreparedToolImage {
  return { fields, rollback: () => deleteToolImage(fields.imagePath) };
}

/**
 * Resolves the image half of an update, performing the one-time fetch when the
 * user asked for a cached URL. The caller handles cache reuse under its row lock.
 *
 * @example const image = await resolveToolImageFields(patch, userId);
 */
export async function resolveToolImageFields(
  patch: ToolImageUpdate | null,
  userId: string,
  fetchDeps: Partial<SafeFetchDeps> = {}
): Promise<PreparedToolImage> {
  if (patch === null) return prepared(NO_IMAGE);

  if (!patch.cache) {
    // Hotlinked: the browser loads it, so we keep the address and nothing else.
    return prepared({
      imageSource: 'url',
      imageUrl: patch.url,
      imagePath: null,
      imageMimeType: null,
    });
  }

  const stored = await cacheRemoteImage(patch.url, userId, fetchDeps);
  return prepared({ imageSource: 'url', imageUrl: patch.url, ...stored });
}

/** Stage validated upload bytes before a row write.
 * @example const image = await storeUploadedToolImage(file, userId);
 */
export async function storeUploadedToolImage(
  file: File,
  userId: string
): Promise<PreparedToolImage> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const validated = await validateToolImage(bytes);

  const imagePath = buildToolImagePath(userId, validated.extension);
  await writeToolImage(imagePath, validated.bytes);

  return prepared({
    imageSource: 'upload',
    imageUrl: null,
    imagePath,
    imageMimeType: validated.mimeType,
  });
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
