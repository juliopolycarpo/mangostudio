/**
 * Library mutations: rescan, the propagation preview/apply/undo triple, and
 * divergence acknowledgements.
 *
 * A 409 from apply is not a bug to swallow — it means the disk moved between
 * the preview and the button, which is exactly the case the state hash exists
 * to catch — so it is surfaced as a typed result the wizard can act on rather
 * than a thrown error the UI would report as a generic failure.
 */

import type {
  LibraryResource,
  PropagationApply,
  PropagationApplyRequest,
  PropagationPreview,
  PropagationPreviewRequest,
  PropagationUndo,
} from '@mangostudio/shared/library';
import { client } from '@/lib/api-client';
import { ApiError } from '@/lib/utils';

export type PropagationApplyResult =
  | { readonly outcome: 'applied'; readonly result: PropagationApply }
  /** The preview no longer describes the disk; the only fix is to preview again. */
  | { readonly outcome: 'stale' };

interface EdenErrorLike {
  readonly status?: number;
  readonly value?: unknown;
}

export async function rescanLibrary(force: boolean): Promise<LibraryResource[]> {
  const { data, error } = await client.api.library.rescan.post(undefined, {
    query: { force: force ? 'true' : 'false' },
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
