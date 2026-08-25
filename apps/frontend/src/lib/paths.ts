/**
 * Last path segment of a workdir, tolerant of trailing separators and Windows
 * paths. Workdirs are server paths, so both separator families can arrive.
 */
export function workdirBasename(workdir: string | null | undefined): string | null {
  if (!workdir) return null;
  const segments = workdir.split(/[\\/]/).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? null;
}

/**
 * The folder name to show for a workdir, falling back to the path itself when
 * it has no segment to take — a root path, or one that is all separators.
 *
 * The display sibling of {@link workdirBasename}: the composer's chip and its
 * collapsed summary must name the same folder, and the fallback was being
 * spelled out at each call site.
 *
 * // Usage: workdirLabel('/srv/projects/mango') // => 'mango'
 */
export function workdirLabel(workdir: string | null | undefined): string | null {
  return workdir ? (workdirBasename(workdir) ?? workdir) : null;
}
