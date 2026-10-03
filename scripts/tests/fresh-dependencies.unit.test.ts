import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildReceipt,
  classifyFreshRun,
  renderReceiptSummary,
} from '../ci/fresh-dependencies-receipt.mjs';
import { reportFreshDependencies } from '../ci/report-fresh-dependencies.mjs';
import { ROOT_DIR } from '../lib/config';
import { readText } from './support/read-text';
import { extractJobBlock, extractOnBlock, sectionKeys } from './support/workflow-blocks';

interface Issue {
  number: number;
  body: string;
  user: { login: string };
  state?: string;
  pull_request?: object;
}

class FakeIssueClient {
  readonly issues: Issue[] = [];
  readonly requests: object[] = [];
  readonly rest = {
    issues: {
      listForRepo: 'issues',
      create: (request: { body: string }) => {
        this.requests.push(request);
        const issue = {
          number: this.issues.length + 1,
          body: request.body,
          user: { login: 'github-actions[bot]' },
        };
        this.issues.push(issue);
        return Promise.resolve({ data: issue });
      },
      update: (request: { issue_number: number; body: string; state: string }) => {
        this.requests.push(request);
        const issue = this.issues.find((entry) => entry.number === request.issue_number);
        if (!issue) throw new Error(`Unknown fake issue ${request.issue_number}`);
        issue.body = request.body;
        issue.state = request.state;
        return Promise.resolve();
      },
    },
  };

  paginate(_route: string, request: object): Promise<Issue[]> {
    this.requests.push(request);
    return Promise.resolve(this.issues);
  }
}

const revision = 'a'.repeat(40);
const runUrl = 'https://github.com/example/project/actions/runs/123';
const context = { repo: { owner: 'example', repo: 'project' } };
const lockSha256 = 'c'.repeat(64);
const stage = { outcome: 'policy-failed', lockSha256 } as const;

describe('fresh dependency reporting', () => {
  test('successive failures update one issue and preserve maintainer notes', async () => {
    const github = new FakeIssueClient();
    expect(await reportFreshDependencies({ github, context, revision, runUrl, ...stage })).toBe(1);
    const issue = github.issues[0];
    issue.body = `Maintainer decision\n\n${issue.body}\n\nInvestigation notes`;
    issue.state = 'closed';
    const nextRevision = 'b'.repeat(40);
    expect(
      await reportFreshDependencies({ github, context, revision: nextRevision, runUrl, ...stage })
    ).toBe(1);
    expect(github.issues).toHaveLength(1);
    expect(issue.state).toBe('open');
    expect(issue.body).toStartWith('Maintainer decision\n\n');
    expect(issue.body).toEndWith('\n\nInvestigation notes');
    expect(issue.body).toContain(nextRevision);
    expect(issue.body).not.toContain(revision);
    expect(github.requests[0]).toMatchObject({ state: 'all', per_page: 100 });
    expect(github.requests[1]).toMatchObject({
      labels: ['type: dependencies', 'status: needs triage'],
    });
  });

  test('ignores pull requests and issues whose marker was quoted by a user', async () => {
    const github = new FakeIssueClient();
    github.issues.push(
      { number: 10, body: '<!-- rust-fresh-dependencies -->', user: { login: 'maintainer' } },
      {
        number: 11,
        body: '<!-- rust-fresh-dependencies -->',
        user: { login: 'github-actions[bot]' },
        pull_request: {},
      }
    );
    await reportFreshDependencies({ github, context, revision, runUrl, ...stage });
    expect(github.issues).toHaveLength(3);
    expect(github.issues[0].body).toBe('<!-- rust-fresh-dependencies -->');
  });

  test('refuses ambiguous or malformed managed issues before writing', async () => {
    const github = new FakeIssueClient();
    github.issues.push({
      number: 4,
      body: '<!-- rust-fresh-dependencies --> no closing marker',
      user: { login: 'github-actions[bot]' },
    });
    await expect(
      reportFreshDependencies({ github, context, revision, runUrl, ...stage })
    ).rejects.toThrow('Invalid managed section in issue 4; expected exactly one ordered');
    expect(github.requests).toHaveLength(1);
    github.issues.push({ ...github.issues[0], number: 5 });
    await expect(
      reportFreshDependencies({ github, context, revision, runUrl, ...stage })
    ).rejects.toThrow('Received compatibility issues 4, 5; expected at most one managed issue');
    expect(github.requests).toHaveLength(2);
  });

  test('rejects a malformed source revision before external I/O', async () => {
    const github = new FakeIssueClient();
    await expect(
      reportFreshDependencies({ github, context, revision: 'main', runUrl, ...stage })
    ).rejects.toThrow('Invalid revision "main"; expected a 40-character Git SHA');
    expect(github.requests).toHaveLength(0);
  });

  test('says which stage failed, and links a lock only when one was produced', async () => {
    const github = new FakeIssueClient();
    await reportFreshDependencies({
      github,
      context,
      revision,
      runUrl,
      outcome: 'resolution-failed',
      lockSha256: null,
    });
    const resolution = github.issues[0].body;
    expect(resolution, 'resolution failure must say so').toContain('Dependency resolution failed');
    expect(resolution, 'no lock exists to link after a resolution failure').not.toContain(
      'resolved lockfile'
    );
    expect(resolution).not.toContain('SHA-256');

    await reportFreshDependencies({ github, context, revision, runUrl, ...stage });
    const policy = github.issues[0].body;
    expect(policy, 'a policy failure must not read as a resolution failure').toContain(
      'dependency policy failed'
    );
    expect(policy).not.toContain('Dependency resolution failed');
    expect(policy).toContain(`SHA-256 \`${lockSha256}\``);
  });

  test('rejects an unknown outcome or a malformed lock hash before external I/O', async () => {
    const github = new FakeIssueClient();
    await expect(
      reportFreshDependencies({ github, context, revision, runUrl, outcome: 'boom', lockSha256 })
    ).rejects.toThrow('Invalid outcome "boom"; expected one of');
    await expect(
      reportFreshDependencies({
        github,
        context,
        revision,
        runUrl,
        outcome: 'policy-failed',
        lockSha256: 'abc',
      })
    ).rejects.toThrow('Invalid lock SHA-256 "abc"; expected 64 lowercase hex characters or null');
    expect(github.requests).toHaveLength(0);
  });
});

const policyFailedNeeds = {
  resolve: {
    result: 'success',
    outputs: {
      generation: 'success',
      lock_sha256: lockSha256,
      rustc: 'rustc 1.99.0 (abcdef 2026-08-27)',
      cargo: 'cargo 1.99.0 (5f94df478 2026-08-27)',
    },
  },
  policy: { result: 'failure', outputs: {} },
  fresh: { result: 'success', outputs: {} },
};

describe('fresh dependency receipt', () => {
  test.each([
    ['success', 'success', 'success', 'passed'],
    ['success', 'failure', 'success', 'policy-failed'],
    ['success', 'success', 'failure', 'platform-checks-failed'],
    ['success', 'failure', 'failure', 'policy-and-platform-checks-failed'],
    ['failure', 'skipped', 'skipped', 'resolution-failed'],
    ['success', 'skipped', 'success', 'incomplete'],
    ['cancelled', 'skipped', 'skipped', 'incomplete'],
  ] as const)('resolve %s, policy %s, fresh %s -> %s', (resolve, policy, fresh, expected) => {
    const needs = {
      resolve: {
        result: resolve,
        outputs: {
          ...policyFailedNeeds.resolve.outputs,
          generation: resolve === 'success' ? 'success' : 'failure',
        },
      },
      policy: { result: policy, outputs: {} },
      fresh: { result: fresh, outputs: {} },
    };
    expect(classifyFreshRun(needs)).toBe(expected);
  });

  test('a lock that was generated but not retained is its own outcome', () => {
    const needs = {
      ...policyFailedNeeds,
      resolve: { ...policyFailedNeeds.resolve, result: 'failure' },
      policy: { result: 'skipped', outputs: {} },
      fresh: { result: 'skipped', outputs: {} },
    };
    expect(classifyFreshRun(needs)).toBe('lock-not-retained');

    // The hash is kept, but no artifact exists to point at: the receipt must not
    // name `fresh-rust-lockfile` as if a reader could download it.
    const receipt = buildReceipt({
      needs,
      sourceSha: revision,
      ref: 'refs/heads/main',
      event: 'schedule',
      runUrl,
    });
    expect(
      receipt.lock,
      'lock-not-retained must not name a lock artifact that was never uploaded'
    ).toEqual({
      produced: true,
      retained: false,
      sha256: lockSha256,
      artifact: null,
    });
    const summary = renderReceiptSummary(receipt);
    expect(summary, 'summary must label the hash as not retained').toContain(
      `\`${lockSha256}\` (not retained`
    );
    expect(summary).not.toContain('artifact `fresh-rust-lockfile`');
  });

  test('the issue report does not link a lockfile that was not retained', async () => {
    const github = new FakeIssueClient();
    await reportFreshDependencies({
      github,
      context,
      revision,
      runUrl,
      outcome: 'lock-not-retained',
      lockSha256,
    });
    const body = github.issues[0].body;
    expect(body, 'lock-not-retained report must not link a resolved lockfile').not.toContain(
      'Workflow logs and resolved lockfile'
    );
    expect(body).toContain(`[Workflow logs](${runUrl})`);
    expect(body).toContain(`lockfile SHA-256 \`${lockSha256}\` (not retained)`);
  });

  test('a failed policy gate still preserves lock, hash, source, compiler and every outcome', () => {
    const receipt = buildReceipt({
      needs: policyFailedNeeds,
      sourceSha: revision,
      ref: 'refs/heads/main',
      event: 'schedule',
      runUrl,
    });
    expect(receipt).toEqual({
      schema: 1,
      outcome: 'policy-failed',
      source: { sha: revision, ref: 'refs/heads/main', event: 'schedule' },
      run: { url: runUrl },
      toolchain: {
        rustc: 'rustc 1.99.0 (abcdef 2026-08-27)',
        cargo: 'cargo 1.99.0 (5f94df478 2026-08-27)',
      },
      lock: { produced: true, retained: true, sha256: lockSha256, artifact: 'fresh-rust-lockfile' },
      jobs: { resolve: 'success', policy: 'failure', fresh: 'success' },
    });
  });

  test('a resolution failure records that no lock exists instead of a hash', () => {
    const receipt = buildReceipt({
      needs: {
        resolve: {
          result: 'failure',
          outputs: { generation: 'failure', lock_sha256: '', rustc: 'rustc 1.99.0', cargo: '' },
        },
        policy: { result: 'skipped', outputs: {} },
        fresh: { result: 'skipped', outputs: {} },
      },
      sourceSha: revision,
      ref: 'refs/heads/main',
      event: 'schedule',
      runUrl,
    });
    expect(receipt.outcome).toBe('resolution-failed');
    expect(receipt.lock).toEqual({
      produced: false,
      retained: false,
      sha256: null,
      artifact: null,
    });
    expect(receipt.jobs).toEqual({ resolve: 'failure', policy: 'skipped', fresh: 'skipped' });
  });

  test('refuses malformed inputs and names the invalid value', () => {
    const base = { sourceSha: revision, ref: 'refs/heads/main', event: 'schedule', runUrl };
    expect(() => buildReceipt({ ...base, needs: {} })).toThrow(
      'needs.resolve is missing; expected the toJSON(needs) object with resolve, policy and fresh'
    );
    expect(() => buildReceipt({ ...base, needs: policyFailedNeeds, sourceSha: 'main' })).toThrow(
      'Invalid source SHA "main"; expected a 40-character Git SHA'
    );
    const badHash = {
      ...policyFailedNeeds,
      resolve: {
        ...policyFailedNeeds.resolve,
        outputs: { ...policyFailedNeeds.resolve.outputs, lock_sha256: 'zz' },
      },
    };
    expect(() => buildReceipt({ ...base, needs: badHash })).toThrow(
      'Invalid lock SHA-256 "zz"; expected 64 lowercase hex characters or empty'
    );
    const claimedLock = {
      ...policyFailedNeeds,
      resolve: {
        ...policyFailedNeeds.resolve,
        outputs: { ...policyFailedNeeds.resolve.outputs, lock_sha256: '' },
      },
    };
    expect(() => buildReceipt({ ...base, needs: claimedLock })).toThrow(
      'resolve reported generation "success" without a lock SHA-256; expected 64 lowercase hex characters'
    );
  });

  test('the command writes the receipt file and the step summary from the environment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fresh-receipt-'));
    const receiptPath = join(dir, 'receipt.json');
    const summaryPath = join(dir, 'summary.md');
    const run = Bun.spawnSync(['bun', './scripts/ci/fresh-dependencies-receipt.mjs', receiptPath], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        NEEDS: JSON.stringify(policyFailedNeeds),
        SOURCE_SHA: revision,
        REF: 'refs/heads/main',
        EVENT: 'schedule',
        RUN_URL: runUrl,
        GITHUB_STEP_SUMMARY: summaryPath,
      },
    });
    expect(run.exitCode, `receipt command failed: ${run.stderr.toString()}`).toBe(0);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    expect(receipt.outcome).toBe('policy-failed');
    expect(receipt.lock.sha256).toBe(lockSha256);
    expect(readFileSync(summaryPath, 'utf8')).toContain('policy-failed');
  });

  test('the command refuses to run without its inputs and says what is missing', () => {
    const run = Bun.spawnSync(['bun', './scripts/ci/fresh-dependencies-receipt.mjs'], {
      cwd: ROOT_DIR,
      env: { ...process.env, NEEDS: '' },
    });
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain(
      'Missing receipt path; expected: fresh-dependencies-receipt.mjs <receipt.json>'
    );
  });

  test('the step summary leads with the stage and carries the identity', () => {
    const summary = renderReceiptSummary(
      buildReceipt({
        needs: policyFailedNeeds,
        sourceSha: revision,
        ref: 'refs/heads/main',
        event: 'schedule',
        runUrl,
      })
    );
    expect(summary).toContain('policy-failed');
    expect(summary).toContain(lockSha256);
    expect(summary).toContain(revision);
    expect(summary).toContain('rustc 1.99.0 (abcdef 2026-08-27)');
    expect(summary).toContain('| policy | failure |');
  });
});

describe('fresh dependency workflow', () => {
  const workflow = readText('.github/workflows/rust-fresh-dependencies.yml');

  test('is advisory, scheduled, manually dispatchable and validates its own PR edits', () => {
    expect(sectionKeys(extractOnBlock(workflow))).toEqual([
      'schedule',
      'workflow_dispatch',
      'pull_request',
    ]);
    expect(workflow).not.toContain('name: Gate');
    expect(workflow).not.toContain('contents: write');
    expect(workflow).not.toContain('git push');
  });

  test('shares one freshly resolved graph across policy and all supported OS checks', () => {
    const resolution = extractJobBlock(workflow, 'resolve');
    expect(resolution.indexOf('rm Cargo.lock')).toBeLessThan(
      resolution.indexOf('cargo generate-lockfile')
    );
    expect(resolution).toContain('name: fresh-rust-lockfile');
    expect(resolution).toContain('path: Cargo.lock');
    const fresh = extractJobBlock(workflow, 'fresh');
    expect(fresh).toContain('needs: [resolve]');
    expect(fresh).toContain('os: [ubuntu-latest, macos-latest, windows-latest]');
    expect(fresh).toContain('fail-fast: false');
    expect(fresh).toContain('name: fresh-rust-lockfile');
    expect(fresh.indexOf('actions/download-artifact@')).toBeLessThan(
      fresh.indexOf('cargo clippy --workspace')
    );
    expect(fresh).not.toContain('cargo build');
    expect(fresh).not.toContain('cargo generate-lockfile');
    const policy = extractJobBlock(workflow, 'policy');
    expect(policy).toContain('needs: [resolve]');
    expect(policy).toContain('name: fresh-rust-lockfile');
    expect(policy).toContain('cargo deny check bans licenses sources');
    expect(policy).not.toContain('cargo generate-lockfile');
    expect(fresh).toContain(
      'cargo clippy --workspace --all-targets --all-features --locked -- -D warnings'
    );
    expect(fresh).toContain('cargo test --workspace --all-targets --all-features --locked');
    expect(fresh).toContain('cargo test --doc --workspace --all-features --locked');
    expect(fresh).not.toContain('issues: write');
  });

  test('only reports a genuine failed scheduled or dispatched run of main', () => {
    const report = extractJobBlock(workflow, 'report');
    const condition = report.split('\n').find((line) => line.startsWith('    if: ')) ?? '';
    expect(report).toContain('needs: [resolve, policy, fresh]');
    expect(condition).toContain("contains(needs.*.result, 'failure')");
    expect(condition).toContain("github.event_name != 'pull_request'");
    // A dispatch on another ref says nothing about main, so it must not rewrite the shared issue.
    expect(condition).toContain("&& github.ref == 'refs/heads/main'");
    expect(report).toContain('issues: write');
    expect(report).toContain('reportFreshDependencies');
  });

  test('the resolver exposes its identity so resolution failure is distinguishable', () => {
    const resolution = extractJobBlock(workflow, 'resolve');
    expect(resolution).toContain('id: generate');
    expect(resolution).toContain(`generation: ${'$'}{{ steps.generate.outcome }}`);
    expect(resolution).toContain(`lock_sha256: ${'$'}{{ steps.identity.outputs.lock_sha256 }}`);
    expect(resolution).toContain(`rustc: ${'$'}{{ steps.toolchain.outputs.rustc }}`);
    expect(resolution).toContain(`cargo: ${'$'}{{ steps.toolchain.outputs.cargo }}`);
    // The hash is of the file the artifact uploads, taken before the upload.
    expect(resolution.indexOf('sha256sum Cargo.lock')).toBeGreaterThan(
      resolution.indexOf('cargo generate-lockfile')
    );
    expect(resolution.indexOf('sha256sum Cargo.lock')).toBeLessThan(
      resolution.indexOf('actions/upload-artifact@')
    );
    // The toolchain is recorded before the resolver can fail.
    expect(resolution.indexOf('id: toolchain')).toBeLessThan(
      resolution.indexOf('cargo generate-lockfile')
    );
  });

  test('a receipt job records every terminal outcome even when a gate failed', () => {
    const receipt = extractJobBlock(workflow, 'receipt');
    expect(receipt, 'receipt job missing: failed runs keep no terminal outcome').not.toBe('');
    expect(receipt).toContain('needs: [resolve, policy, fresh]');
    // Not `always()`: a cancelled run records nothing, but every failure does.
    expect(receipt).toContain(`if: ${'$'}{{ !cancelled() }}`);
    expect(receipt).toContain('bun ./scripts/ci/fresh-dependencies-receipt.mjs');
    expect(receipt).toContain(`NEEDS: ${'$'}{{ toJSON(needs) }}`);
    expect(receipt).toContain('name: fresh-rust-receipt');
    expect(receipt).toContain('if-no-files-found: error');
    expect(receipt).toContain('$GITHUB_STEP_SUMMARY');
    expect(receipt).toContain('permissions:\n      contents: read');
    expect(receipt).not.toContain('contents: write');
    expect(receipt).not.toContain('issues: write');
  });

  test('the report names the stage that failed from the same classification', () => {
    const report = extractJobBlock(workflow, 'report');
    expect(report).toContain(`NEEDS: ${'$'}{{ toJSON(needs) }}`);
    expect(report).toContain('classifyFreshRun');
    expect(report).toContain('outcome');
    expect(report).toContain('lockSha256');
  });

  test('editing any script the workflow runs validates it on a pull request', () => {
    const paths = extractOnBlock(workflow);
    for (const file of [
      '.github/workflows/rust-fresh-dependencies.yml',
      'scripts/ci/report-fresh-dependencies.mjs',
      'scripts/ci/fresh-dependencies-receipt.mjs',
    ]) {
      expect(paths, file).toContain(`- ${file}`);
    }
  });

  test('serializes issue writers across refs without canceling an active update', () => {
    const report = extractJobBlock(workflow, 'report');
    expect(report).toContain('group: rust-fresh-dependencies-report-${{ github.repository }}');
    expect(report).toContain('cancel-in-progress: false');
    const groups = report.split('\n').filter((line) => line.trimStart().startsWith('group: '));
    expect(groups).toHaveLength(1);
    expect(groups[0]).not.toContain('github.ref');
  });
});
