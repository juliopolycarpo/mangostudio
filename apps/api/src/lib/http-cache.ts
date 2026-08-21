/**
 * `If-None-Match` carries a list, and a cache is allowed to weaken a tag it
 * stored. Both are handled here rather than by comparing the header whole.
 */
export function matchesEtag(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//, ''))
    .some((candidate) => candidate === '*' || candidate === etag);
}
