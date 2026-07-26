import { describe, expect, test } from 'bun:test';
import { readText } from './support/read-text';
import { extractJobBlock, extractJobBlocks, extractStepBlocks } from './support/workflow-blocks';
import { compositeActionFiles, workflowFiles } from './support/workflow-files';

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

// Jobs that perform authenticated git network operations and therefore keep the
// checkout credential in `.git/config` for the rest of the job. Adding an entry
// is a security decision: every later step, including transitively installed
// tooling, can read the token. Each allowlisted checkout also carries a comment
// naming the step that needs it.
const CREDENTIAL_ALLOWLIST = new Set([
  '.github/workflows/pr-qa-report.yml::report',
  '.github/workflows/release.yml::prepare',
]);

// A step's `uses: actions/checkout@<sha>` line, in either the `- uses:` or the
// `name:`-first form.
const CHECKOUT_USES = /^\s*(?:-\s+)?uses:\s*actions\/checkout@/m;

// The setting as a real YAML key on its own line, never as free text: a step
// whose comment merely mentions `persist-credentials: false` while omitting the
// key would satisfy a substring match and inherit the token anyway.
function persistCredentials(value: 'false' | 'true'): RegExp {
  return new RegExp(`^\\s+persist-credentials: ${value}\\s*(?:#.*)?$`, 'm');
}

/** Every `actions/checkout` step block of a job, in declaration order. */
function checkoutSteps(jobBlock: string): string[] {
  return extractStepBlocks(jobBlock).filter((step) => CHECKOUT_USES.test(step));
}

/** Every `actions/checkout` line in a file, however the job or step is shaped. */
function checkoutLineCount(text: string): number {
  return text.split('\n').filter((line) => CHECKOUT_USES.test(line)).length;
}

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

  test('checkouts drop the Actions token unless the job does git network work', () => {
    let asserted = 0;
    for (const file of workflowFiles()) {
      const text = readText(file);
      let walked = 0;
      for (const { job, block } of extractJobBlocks(text)) {
        const steps = checkoutSteps(block);
        walked += steps.length;
        if (CREDENTIAL_ALLOWLIST.has(`${file}::${job}`)) continue;
        // Per step, never a byte window around the `uses:` line: a fixed slice
        // straddles neighbouring steps, so a checkout missing the setting could
        // be satisfied by the next one's text.
        for (const step of steps) {
          expect(step, `${file} → ${job}`).toMatch(persistCredentials('false'));
          asserted += 1;
        }
      }
      // The job and step walks key off exact indentation. A workflow written
      // outside that shape yields zero steps, so its checkouts would be exempt
      // from the policy while the suite stayed green — the omission this test
      // exists to catch. Per file, because one unreachable workflow cannot move
      // a repo-wide total off zero.
      expect(walked, `${file}: checkouts the step walk never reached`).toBe(
        checkoutLineCount(text)
      );
    }
    expect(asserted).toBeGreaterThan(0);
  });

  test('allowlisted jobs opt into the credential explicitly, never by default', () => {
    // No checkout anywhere relies on the action's persist-credentials default,
    // so `grep -rn persist-credentials .github/workflows/` reads as the full
    // policy and a new checkout cannot inherit the token by omission.
    for (const entry of CREDENTIAL_ALLOWLIST) {
      const [file, job] = entry.split('::');
      const steps = checkoutSteps(extractJobBlock(readText(file), job));
      // A stale entry — renamed or deleted job — must fail loudly rather than
      // silently exempting nothing.
      expect(steps.length, entry).toBeGreaterThan(0);
      for (const step of steps) {
        expect(step, entry).toMatch(persistCredentials('true'));
      }
    }
  });

  test('no composite action checks out the repository', () => {
    // The job-block walk above cannot see steps inside `.github/actions/*`.
    // Callers check out first (see setup-mango's description), so recording the
    // absence here keeps the gap a fact rather than an oversight.
    const files = compositeActionFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(readText(file), file).not.toMatch(CHECKOUT_USES);
    }
  });

  test('pull-request workflows key concurrency on the PR number, not the SHA', () => {
    for (const file of workflowFiles()) {
      const workflow = readText(file);
      if (!/\non:\n(?:.|\n)*?\n {2}pull_request:/.test(workflow)) continue;
      if (!workflow.includes('\nconcurrency:')) continue;
      expect(workflow, file).toContain('github.event.pull_request.number');
      expect(workflow, file).not.toContain('github.sha');
    }
  });
});
