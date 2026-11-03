import { normalizeMonogram, type ToolIdentityUpdate } from '@mangostudio/shared/tool-identity';

import type { ResolvedToolIdentity } from './resolve';
import type { ToolImageMode } from './ToolImageFields';

interface IdentityDraft {
  readonly name: string;
  readonly monogram: string;
  readonly imageMode: ToolImageMode;
  readonly imageUrl: string;
  readonly cacheImage: boolean;
}

/**
 * Sends only overrides changed since the dialog opened, preserving concurrent edits.
 *
 * @example buildToolIdentityPatch(openingIdentity, { name: 'New name', monogram: '', imageMode: 'monogram', imageUrl: '', cacheImage: true })
 */
export function buildToolIdentityPatch(
  opening: ResolvedToolIdentity,
  draft: IdentityDraft
): ToolIdentityUpdate {
  const patch: ToolIdentityUpdate = {};
  const name = draft.name.trim() || null;
  const monogram = draft.monogram.trim() ? normalizeMonogram(draft.monogram.trim()) : null;
  const originalName = opening.storedName?.trim() || null;
  const originalMonogram = opening.storedMonogram
    ? normalizeMonogram(opening.storedMonogram.trim())
    : null;
  if (name !== originalName) patch.displayName = name;
  if (monogram !== originalMonogram) patch.monogram = monogram;

  if (draft.imageMode === 'monogram' && opening.storedImage !== null) {
    patch.image = null;
  } else if (draft.imageMode === 'url') {
    const url = draft.imageUrl.trim();
    if (
      opening.storedImage?.source !== 'url' ||
      opening.storedImage.url !== url ||
      opening.storedImage.cached !== draft.cacheImage
    ) {
      patch.image = { source: 'url', url, cache: draft.cacheImage };
    }
  }
  return patch;
}
