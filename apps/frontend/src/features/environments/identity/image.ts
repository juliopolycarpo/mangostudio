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

export function toolImageDisplay(
  subjectKey: string,
  image: ToolImage | null,
  updatedAt: number
): ToolImageDisplay | null {
  if (!image) return null;

  if (image.cached) {
    // The address never changes when the image does, so the identity's
    // `updatedAt` is what retires the copy a browser is already holding.
    return {
      // Subject keys are lowercase alphanumerics, hyphens, and one colon, all
      // legal in a path segment — encoding them would only obscure the URL.
      src: `${getApiBaseUrl()}/api/tool-identities/${subjectKey}/image?v=${updatedAt}`,
      remote: false,
    };
  }

  return image.url ? { src: image.url, remote: true } : null;
}
