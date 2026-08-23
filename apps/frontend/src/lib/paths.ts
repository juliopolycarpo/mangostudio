/**
 * Last path segment of a workdir, tolerant of trailing separators and Windows
 * paths. Workdirs are server paths, so both separator families can arrive.
 */
export function workdirBasename(workdir: string | null | undefined): string | null {
  if (!workdir) return null;
  const segments = workdir.split(/[\\/]/).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? null;
}
