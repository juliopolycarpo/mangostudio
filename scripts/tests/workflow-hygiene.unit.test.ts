import { describe, expect, test } from 'bun:test';
import { readText } from './support/read-text';
import {
  extractJobBlock,
  extractJobBlocks,
  extractStepBlocks,
  runScriptLines,
} from './support/workflow-blocks';
import { compositeActionFiles, workflowFiles } from './support/workflow-files';

// Split so this file's own text cannot satisfy the scan it performs, the way
// security-workflows.unit.test.ts already does for `matrix.language`.
const EXPRESSION_OPEN = '$' + '{{';

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

  test('no run: script interpolates a workflow expression', () => {
    // GitHub substitutes a `${{ }}` expression into the script *text* before
    // bash ever parses it, so a value carrying shell metacharacters — a tag
    // name, a PR title, an issue body — runs as code on the runner. Every such
    // value must reach the script through `env:` and be read as "$VAR", where
    // it is data. This holds repository-wide with no allowlist; an exemption
    // would need a value proven to be free of metacharacters, which is a claim
    // about GitHub's data, not about this repository.
    const offenders: string[] = [];
    for (const file of [...workflowFiles(), ...compositeActionFiles()]) {
      for (const { line, text } of runScriptLines(readText(file))) {
        if (text.includes(EXPRESSION_OPEN)) offenders.push(`${file}:${line}:${text.trimEnd()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the expression scan reads block scalars, not just inline run: lines', () => {
    // The failure this guards against is silent: a walk that only matched
    // `run: <command>` on one line would report a clean repository while every
    // `run: |` script — the majority form here — went unread. Both forms are
    // asserted against a fixture, then the fixture's conclusion is checked
    // against a real workflow so the two cannot drift apart.
    const fixture = [
      'jobs:',
      '  build:',
      '    steps:',
      '      - name: Inline',
      '        run: echo inline',
      '      - name: Block',
      '        run: |',
      '          echo first',
      '',
      '          echo last',
      '        env:',
      '          NOT_SCRIPT: value',
      '      - run: echo bare',
      '        env:',
      '          ALSO_NOT_SCRIPT: value',
    ].join('\n');

    expect(runScriptLines(fixture).map(({ line }) => line)).toEqual([5, 8, 10, 13]);

    // A `- run:` step's own `env:` block sits deeper than the list marker; only
    // reading the indent of the `run:` key keeps it out of the script.
    expect(runScriptLines(fixture).map(({ text }) => text.trim())).not.toContain(
      'ALSO_NOT_SCRIPT: value'
    );

    // Split for the same reason release-workflows.unit.test.ts splits its own
    // shell expansions: biome reads `${...}` in a plain string as a template
    // literal someone forgot to tag.
    const shellTag = 'tag="v$' + '{VERSION}"';
    const release = runScriptLines(readText('.github/workflows/release.yml'));
    expect(release.map(({ text }) => text.trim())).toContain(shellTag);
  });

  test('pull-request workflows key concurrency on the PR number, not the SHA', () => {
    // Both blocks are matched as "the key line, then its indented body", so the
    // scan cannot run past `on:`/`concurrency:` into the rest of the workflow.
    const ON_BLOCK = /\non:\n(?:[ \t#].*\n)*/;
    const CONCURRENCY_BLOCK = /\nconcurrency:\n(?:[ \t#].*\n)*/;
    let checked = 0;
    for (const file of workflowFiles()) {
      const workflow = readText(file);
      const onBlock = workflow.match(ON_BLOCK)?.[0];
      if (!onBlock?.includes('\n  pull_request:\n')) continue;
      const concurrency = workflow.match(CONCURRENCY_BLOCK)?.[0];
      if (!concurrency) continue;
      checked += 1;
      expect(concurrency, file).toContain('github.event.pull_request.number');
      expect(concurrency, file).not.toContain('github.sha');
    }
    // Guards against the policy silently covering zero workflows.
    expect(checked).toBeGreaterThan(0);
  });
});
