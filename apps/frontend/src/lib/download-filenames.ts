/**
 * Builds a generated image download filename.
 *
 * Usage: buildGeneratedImageFilename('mangostudio', 'image-1')
 */
export function buildGeneratedImageFilename(prefix: string, id: string | number): string {
  const safePrefix = sanitizeFilenameSegment(prefix) || 'mangostudio';
  const safeId = sanitizeFilenameSegment(String(id)) || String(Date.now());
  return `${safePrefix}-art-${safeId}.png`;
}

function sanitizeFilenameSegment(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
