/* global document */
import { buildGeneratedImageFilename } from './download-filenames';

/**
 * Triggers a browser download of an image URL using a provider-neutral filename.
 *
 * Usage: triggerImageDownload('/images/generated-1.png', 'mangostudio')
 */
export function triggerImageDownload(imageUrl: string, filenamePrefix: string): void {
  const link = document.createElement('a');
  link.href = imageUrl;
  link.download = buildGeneratedImageFilename(filenamePrefix, Date.now());
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
