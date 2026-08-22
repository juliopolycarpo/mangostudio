/**
 * The validator for a file, derived from its size and mtime.
 *
 * Lives beside `matchesEtag` because the two are one contract: whatever spells
 * a tag has to agree with whatever compares one. Written twice, a change to the
 * format on one path (an added inode component, a `W/` prefix) leaves the other
 * on the old spelling, and the only symptom is a 304 that quietly stops
 * happening — no error, no log, just the asset re-downloaded on every request.
 *
 * Structural rather than `fs.Stats` so a `BunFile.stat()` result fits too.
 */
export function fileEtag(stats: { size: number; mtimeMs: number }): string {
  return `"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}"`;
}

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
