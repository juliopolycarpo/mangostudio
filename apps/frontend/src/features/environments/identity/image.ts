/**
 * Where an avatar's pixels come from.
 *
 * Two very different loads hide behind one field. Bytes we hold are fetched
 * from our own API with the session that is already open; an uncached address
 * is fetched by the browser from a stranger, and every attribute on that
 * request is a decision about what the stranger gets to learn.
 */

import type { ToolImage } from '@mangostudio/shared/tool-identity';

import type { ToolImageDisplay } from '@/components/ui/ToolAvatar';
import { getApiBaseUrl } from '@/lib/api-base-url';

/** Resolve cached bytes through our API and hotlinks through their remote URL.
 * @example const image = toolImageDisplay(identity.subjectKey, identity.image, identity.updatedAt);
 */
export function toolImageDisplay(
  subjectKey: string,
  image: ToolImage | null,
  updatedAt: number
): ToolImageDisplay | null {
  if (!image) return null;

  if (image.cached) {
    // Image identity survives metadata edits and changes even when two uploads
    // share a timestamp. Legacy responses still use their timestamp version.
    return {
      // Subject keys are lowercase alphanumerics, hyphens, and one colon, all
      // legal in a path segment — encoding them would only obscure the URL.
      src: `${getApiBaseUrl()}/api/tool-identities/${subjectKey}/image?v=${encodeURIComponent(image.cacheKey ?? String(updatedAt))}`,
      remote: false,
    };
  }

  return image.url ? { src: image.url, remote: true } : null;
}
