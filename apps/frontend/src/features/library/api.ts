/**
 * Library mutations: rescan, the propagation preview/apply/undo triple, and
 * divergence acknowledgements.
 *
 * A 409 from apply is not a bug to swallow — it means the disk moved between
 * the preview and the button, which is exactly the case the state hash exists
 * to catch — so it is surfaced as a typed result the wizard can act on rather
 * than a thrown error the UI would report as a generic failure.
 */

import { ERROR_CODES } from '@mangostudio/shared/errors';
import type {
  LibraryResource,
  PropagationApply,
  PropagationApplyRequest,
  PropagationPreview,
  PropagationPreviewRequest,
  PropagationUndo,
  RemovalApply,
  RemovalApplyRequest,
  RemovalPreview,
  RemovalPreviewRequest,
} from '@mangostudio/shared/library';
import { client } from '@/lib/api-client';
import { ApiError } from '@/lib/utils';
import { libraryEnvironmentSearch } from './queries';

export type PropagationApplyResult =
  | { readonly outcome: 'applied'; readonly result: PropagationApply }
  /** The preview no longer describes the disk; the only fix is to preview again. */
  | { readonly outcome: 'stale' };

export type RemovalApplyResult =
  | { readonly outcome: 'removed'; readonly result: RemovalApply }
  | { readonly outcome: 'stale' }
  /**
   * The request would leave no copy of a resource anywhere and did not say so.
   * The wizard gates on this, so reaching it means the two disagreed about what
   * is left on disk — which is the user's cue to look again, not a bug to hide.
   */
  | { readonly outcome: 'last-copy-unacknowledged' };

interface EdenErrorLike {
  readonly status?: number;
  readonly value?: unknown;
}

export async function rescanLibrary(
  force: boolean,
  environmentId?: string
): Promise<LibraryResource[]> {
  const { data, error } = await client.api.library.rescan.post(undefined, {
    query: {
      force: force ? 'true' : 'false',
      ...libraryEnvironmentSearch(environmentId),
    },
  });
  if (error) throw new ApiError(error.value);
  return data as LibraryResource[];
}

export async function previewPropagation(
  request: PropagationPreviewRequest
): Promise<PropagationPreview> {
  const { data, error } = await client.api.library.propagate.preview.post(request);
  if (error) throw new ApiError(error.value);
  return data as PropagationPreview;
}

export async function applyPropagation(
  request: PropagationApplyRequest
): Promise<PropagationApplyResult> {
  const { data, error } = await client.api.library.propagate.apply.post(request);
  if (error) {
    if ((error as EdenErrorLike).status === 409) return { outcome: 'stale' };
    throw new ApiError(error.value);
  }
  return { outcome: 'applied', result: data as PropagationApply };
}

export async function undoPropagation(backupId: string): Promise<PropagationUndo> {
  const { data, error } = await client.api.library.propagate.undo.post({ backupId });
  if (error) throw new ApiError(error.value);
  return data as PropagationUndo;
}

export async function previewRemoval(request: RemovalPreviewRequest): Promise<RemovalPreview> {
  const { data, error } = await client.api.library.removal.preview.post(request);
  if (error) throw new ApiError(error.value);
  return data as RemovalPreview;
}

export async function applyRemoval(request: RemovalApplyRequest): Promise<RemovalApplyResult> {
  const { data, error } = await client.api.library.removal.apply.post(request);
  if (error) {
    if ((error as EdenErrorLike).status === 409) return { outcome: 'stale' };
    const failure = new ApiError(error.value);
    if (failure.code === ERROR_CODES.LAST_COPY_UNACKNOWLEDGED) {
      return { outcome: 'last-copy-unacknowledged' };
    }
    throw failure;
  }
  return { outcome: 'removed', result: data as RemovalApply };
}

/**
 * Deletes one retained backup set. The explicit counterpart to pinning: a set
 * holding someone's only copy of a resource is never evicted automatically, so
 * reclaiming that disk has to be something the user asks for by name.
 */
export async function purgeBackup(backupId: string): Promise<void> {
  const { error } = await client.api.library.propagate.backups({ backupId }).delete();
  if (error) throw new ApiError(error.value);
}
