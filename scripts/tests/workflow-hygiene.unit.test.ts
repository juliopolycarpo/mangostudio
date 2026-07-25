import { describe, expect, test } from 'bun:test';
import { readText } from './support/read-text';
import { extractJobBlocks } from './support/workflow-blocks';
import { workflowFiles } from './support/workflow-files';

// A job that calls a reusable workflow inherits the called workflow's own job
// timeouts, and GitHub rejects `timeout-minutes` on it outright. Anchored at
// indent 4 so a composite-action step's `uses:` cannot satisfy the match; the
// optional quote covers the equally valid `uses: './.github/workflows/x.yml'`.
const CALLS_REUSABLE_WORKFLOW = /^ {4}uses: ['"]?\.\/\.github\/workflows\//m;

// Anchored at indent 4 for the same reason: only a job-level key bounds the
// job. A step's `timeout-minutes` (indent 8) caps one step while the job keeps
// the 6-hour default, and a caller's `with:` may legitimately pass a
// `timeout-minutes` input through to the workflow it calls.
const JOB_TIMEOUT = /^ {4}timeout-minutes: \d+/m;

describe('workflow hygiene', () => {
  test('bounds every job with an explicit timeout', () => {
    for (const file of workflowFiles()) {
      for (const { job, block } of extractJobBlocks(readText(file))) {
        if (CALLS_REUSABLE_WORKFLOW.test(block)) continue;
        expect(block, `${file} → ${job}`).toMatch(JOB_TIMEOUT);
      }
    }
  });

  test('leaves timeouts off reusable-workflow callers, which cannot set them', () => {
    // Keeps the exemption above auditable: a caller that grows a timeout is a
    // workflow GitHub will refuse to run, not a test to loosen.
    const callers: string[] = [];
    for (const file of workflowFiles()) {
      for (const { job, block } of extractJobBlocks(readText(file))) {
        if (!CALLS_REUSABLE_WORKFLOW.test(block)) continue;
        callers.push(`${file} → ${job}`);
        expect(block, `${file} → ${job}`).not.toMatch(JOB_TIMEOUT);
      }
    }
    expect(callers.length).toBeGreaterThan(0);
  });
});
