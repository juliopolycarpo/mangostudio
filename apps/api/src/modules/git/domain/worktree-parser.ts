import type { GitWorktree } from '@mangostudio/shared/git';

const WORKTREE_ATTRIBUTE = 'worktree';
const BRANCH_REF_PREFIX = 'refs/heads/';
// The contract types `head` as a commit hash. Git only ever prints one there,
// but the parser is the boundary that guarantees it: a record whose HEAD is not
// a hash degrades to `null` rather than reaching the wire and failing response
// validation, which would take the whole list down over one bad entry.
const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,64}$/i;

/**
 * Parses `git worktree list --porcelain -z` into the shared contract shape.
 *
 * The NUL-delimited form is the only unambiguous one. In the newline form Git
 * quotes a lock reason that contains a newline but leaves a *worktree path*
 * that contains one raw, so a record cannot be framed by splitting on blank
 * lines. With `-z` every attribute is its own NUL-terminated field and an empty
 * field ends the record, which no path or reason can forge — argv cannot carry
 * a NUL, so no reason Git echoes back can contain one either.
 *
 * Malformed records are skipped rather than thrown on, so one unreadable entry
 * cannot hide the worktrees the caller can act on.
 *
 * @example
 * parseWorktreeList('worktree /repo\0HEAD abc1234\0branch refs/heads/main\0\0');
 * // [{ path: '/repo', head: 'abc1234', branch: 'main', isMain: true, ... }]
 */
export function parseWorktreeList(output: string): GitWorktree[] {
  const worktrees: GitWorktree[] = [];

  for (const record of splitRecords(output)) {
    // Git lists the main worktree first, so the first record that parses owns
    // that flag. A leading garbage record would promote its successor, which is
    // the least-wrong answer available without a second Git call.
    const worktree = parseRecord(record, worktrees.length === 0);
    if (worktree) worktrees.push(worktree);
  }

  return worktrees;
}

/** Groups NUL-separated fields into records, using the empty field as the terminator. */
function splitRecords(output: string): string[][] {
  const records: string[][] = [];
  let current: string[] = [];

  for (const field of output.split('\0')) {
    if (field.length > 0) {
      current.push(field);
      continue;
    }
    if (current.length > 0) records.push(current);
    current = [];
  }

  // A capture truncated before its final terminator still describes a worktree.
  if (current.length > 0) records.push(current);
  return records;
}

function parseRecord(fields: readonly string[], isMain: boolean): GitWorktree | null {
  // Every real record opens with `worktree <path>`; anything else is garbage
  // from a truncated capture or a future attribute Git grew.
  if (!fields[0]?.startsWith(`${WORKTREE_ATTRIBUTE} `)) return null;

  const attributes = readAttributes(fields);
  const path = attributes.get(WORKTREE_ATTRIBUTE);
  if (!path) return null;

  const head = attributes.get('HEAD');
  const branchRef = attributes.get('branch');
  const lockReason = attributes.get('locked');
  const prunableReason = attributes.get('prunable');

  return {
    path,
    head: head && COMMIT_HASH_PATTERN.test(head) ? head : null,
    branch: branchRef ? (shortBranchName(branchRef) ?? null) : null,
    isMain,
    isBare: attributes.has('bare'),
    isDetached: attributes.has('detached'),
    isLocked: attributes.has('locked'),
    ...(lockReason ? { lockReason } : {}),
    isPrunable: attributes.has('prunable'),
    ...(prunableReason ? { prunableReason } : {}),
  };
}

/**
 * Splits each field into its attribute name and value, where a value-less
 * attribute (`bare`, an unexplained `locked`) maps to the empty string.
 *
 * First occurrence wins: a record that repeats an attribute is malformed, and
 * the opening `worktree` line is the one that must not be overwritten.
 */
function readAttributes(fields: readonly string[]): Map<string, string> {
  const attributes = new Map<string, string>();

  for (const field of fields) {
    const separator = field.indexOf(' ');
    const name = separator < 0 ? field : field.slice(0, separator);
    if (attributes.has(name)) continue;
    attributes.set(name, separator < 0 ? '' : field.slice(separator + 1));
  }

  return attributes;
}

/**
 * `refs/heads/feat/x` is the branch `feat/x`; anything else is reported
 * verbatim. A ref that shortens to nothing is no branch at all — the contract
 * forbids an empty name, and returning one would fail response validation.
 */
function shortBranchName(ref: string): string | undefined {
  const name = ref.startsWith(BRANCH_REF_PREFIX) ? ref.slice(BRANCH_REF_PREFIX.length) : ref;
  return name.length > 0 ? name : undefined;
}
