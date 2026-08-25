/**
 * The sidebar row, the hub's uncommitted list and the workspace breadcrumb all
 * name the same commit. They used to each carry their own `slice(0, 7)`, so the
 * short-hash length was a convention with no owner.
 */

import { describe, expect, it } from 'bun:test';
import { branchLabel } from '../../../src/lib/git-branch';

describe('branchLabel', () => {
  it('prefers the branch name when the worktree is on one', () => {
    expect(branchLabel('main', 'a1b2c3d4e5f6')).toBe('main');
  });

  it('shortens a detached HEAD to seven characters', () => {
    expect(branchLabel(null, 'a1b2c3d4e5f6')).toBe('a1b2c3d');
  });

  it('returns null when the worktree reports neither', () => {
    expect(branchLabel(null, null)).toBeNull();
    expect(branchLabel(undefined, undefined)).toBeNull();
  });

  it('does not pad a hash that is already shorter than the cut', () => {
    expect(branchLabel(null, 'a1b2')).toBe('a1b2');
  });
});
