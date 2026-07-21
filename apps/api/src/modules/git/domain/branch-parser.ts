import type { GitBranch } from '@mangostudio/shared/git';

const TRACKING_COUNT = /(ahead|behind) (\d+)/g;

/** Parses NUL-delimited local refs emitted by `git for-each-ref`. */
export function parseBranchList(output: string): GitBranch[] {
  return output
    .split('\0')
    .map((record) => record.trimStart())
    .filter(Boolean)
    .map((record) => {
      const [name = '', head = '', upstream = '', tracking = ''] = record.split('\x1f');
      const counts = { ahead: 0, behind: 0 };
      for (const match of tracking.matchAll(TRACKING_COUNT)) {
        counts[match[1] as 'ahead' | 'behind'] = Number(match[2]);
      }
      return {
        name,
        current: head === '*',
        ...(upstream ? { upstream } : {}),
        ...counts,
      };
    })
    .sort((left, right) => {
      if (left.current !== right.current) return left.current ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
}

/** Extracts paths from Git's checkout-overwrite diagnostics. */
export function parseCheckoutBlockedPaths(output: string): string[] {
  const paths: string[] = [];
  let collecting = false;
  for (const line of output.split(/\r?\n/)) {
    if (/following (?:untracked working tree )?files would be overwritten/i.test(line)) {
      collecting = true;
      continue;
    }
    if (!collecting) continue;
    if (/^\s+\S/.test(line)) {
      paths.push(line.trim());
      continue;
    }
    if (paths.length > 0) break;
  }
  return [...new Set(paths)];
}
