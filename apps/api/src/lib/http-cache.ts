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
 * The validator for content whose bytes are its only stable identity.
 *
 * A file embedded in a compiled binary stats as `mtimeMs: 0`, and the shell's
 * byte *size* barely moves between builds because hashed asset names are
 * fixed-length — so `fileEtag` there collapses to the same string in every
 * release, and an upgraded binary answers 304 to the previous build's shell.
 * Hashing the bytes makes the tag change exactly when the content does.
 */
export function contentEtag(content: string | Uint8Array): string {
  return `"${Bun.hash(content).toString(16)}"`;
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

/**
 * Whether a conditional GET for a representation with `etag` and `mtimeMs` can
 * be answered 304.
 *
 * `If-None-Match` wins when present: RFC 9110 §13.1.3 says a recipient must
 * ignore `If-Modified-Since` then. The mtime is truncated to whole seconds
 * before comparing, because `Last-Modified` is sent at second precision — a
 * raw millisecond compare would make the echoed date look older than the file
 * and never match.
 *
 * @example
 * if (isNotModified(request.headers, fileEtag(stats), stats.mtimeMs)) return new Response(null, { status: 304 });
 */
export function isNotModified(headers: Headers, etag: string, mtimeMs: number): boolean {
  const ifNoneMatch = headers.get('if-none-match');
  if (ifNoneMatch !== null) return matchesEtag(ifNoneMatch, etag);

  const since = Date.parse(headers.get('if-modified-since') ?? '');
  if (Number.isNaN(since)) return false;
  return Math.floor(mtimeMs / 1000) * 1000 <= since;
}
