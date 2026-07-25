import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import {
  QA_METRICS_ARTIFACT_NAME,
  QA_METRICS_FILE_NAME,
  QA_METRICS_MAX_BYTES,
} from '../qa-gate/metrics-envelope';
import { readText } from './support/read-text';

// Trust-boundary policy for the PR QA pipeline: workflows that execute
// pull-request code must stay read-only, and the write-capable publisher must
// never execute anything a PR controls. These tests pin that split so a
// workflow edit cannot silently reintroduce the privileged-PR-code pattern.

const COLLECTION_WORKFLOWS = [
  '.github/workflows/ci.yml',
  '.github/workflows/test.yml',
  '.github/workflows/build.yml',
  '.github/workflows/qa-metrics.yml',
] as const;

describe('unprivileged collection side', () => {
  test('the old PR QA gate workflow (PR code with a write token) stays deleted', () => {
    expect(existsSync(join(ROOT_DIR, '.github/workflows/pr-qa-gate.yml'))).toBe(false);
  });

  test.each([...COLLECTION_WORKFLOWS])('%s runs PR code with contents: read only', (path) => {
    const workflow = readText(path);

    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow).not.toContain('pull-requests: write');
    expect(workflow).not.toContain('github-script');
  });

  test('test.yml hands the fragment off with 1-day retention and failure-only coverage', () => {
    const workflow = readText('.github/workflows/test.yml');

    expect(workflow).toContain('name: qa-test-metrics');
    expect(workflow).toMatch(
      /name: qa-test-metrics\n\s+path: test-metrics\.json\n\s+retention-days: 1\n/
    );
    expect(workflow).toMatch(/- name: Upload coverage\n\s+if: failure\(\)/);
  });

  test('qa-metrics.yml uploads the envelope under the shared artifact name', () => {
    const workflow = readText('.github/workflows/qa-metrics.yml');

    expect(workflow).toContain(`name: ${QA_METRICS_ARTIFACT_NAME}\n`);
    expect(workflow).toContain(`> ${QA_METRICS_FILE_NAME}`);
    // Main-push envelopes are the long-lived baselines; PR envelopes are not.
    expect(workflow).toContain("github.event_name == 'push' && 90 || 7");
  });

  test('ci.yml collects metrics only for PRs and main pushes, after test and build', () => {
    const workflow = readText('.github/workflows/ci.yml');

    expect(workflow).toContain('uses: ./.github/workflows/qa-metrics.yml');
    expect(workflow).toMatch(/qa-metrics:\n(.*\n)*?\s+needs: \[test, build\]/);
    expect(workflow).toContain(
      "!cancelled() && (github.event_name == 'pull_request' || (github.event_name == 'push' && github.ref == 'refs/heads/main'))"
    );
  });

  test('qa-metrics measures the build job artifact rather than rebuilding', () => {
    const build = readText('.github/workflows/build.yml');
    const qaMetrics = readText('.github/workflows/qa-metrics.yml');
    const ci = readText('.github/workflows/ci.yml');

    expect(build).toContain('name: frontend-dist');
    expect(qaMetrics).toContain('name: frontend-dist');
    expect(qaMetrics).toContain('QA_FRONTEND_DIST: ./frontend-dist');
    expect(qaMetrics).not.toContain('cache-scoped');
    expect(ci).toContain('needs: [test, build]');
  });
});

describe('privileged publisher side (pr-qa-report.yml)', () => {
  const workflow = readText('.github/workflows/pr-qa-report.yml');

  test('is a workflow_run consumer with an empty top-level permission set', () => {
    expect(workflow).toContain('workflow_run:\n    workflows: [CI]\n    types: [completed]');
    expect(workflow).toContain('permissions: {}');
    expect(workflow).toContain(`if: \${{ github.event.workflow_run.event == 'pull_request' }}`);
  });

  test('grants writes only at job scope, limited to pull-requests', () => {
    // Each scope carries an explanatory comment (zizmor
    // undocumented-permissions), so match line-by-line rather than the block.
    expect(workflow).toMatch(
      /permissions:\n {6}actions: read #.*\n {6}contents: read #.*\n {6}pull-requests: write #/
    );
    expect(workflow).not.toContain('contents: write');
  });

  test('never checks out or executes pull-request code', () => {
    // The only checkout is the default branch: no ref pointing at the
    // triggering run's head, no PR-controlled path imported or executed.
    expect(workflow).not.toMatch(/ref:\s*\$\{\{\s*github\.event\.workflow_run/);
    expect(workflow).not.toMatch(/ref:.*head\.sha/);
    // Artifact payloads are extracted as data with hard bounds, not unpacked
    // onto disk where archive-controlled paths or symlinks could land.
    expect(workflow).toContain('unzip -p');
    expect(workflow).toContain('head -c');
    expect(workflow).not.toContain('actions/download-artifact');
  });

  test('mirrors the payload bounds pinned in metrics-envelope.ts', () => {
    expect(workflow).toContain(`METRICS_MAX_BYTES: ${QA_METRICS_MAX_BYTES}`);
    expect(workflow).toContain(`METRICS_FILE_NAME: ${QA_METRICS_FILE_NAME}`);
  });

  test('fetches PR history as git data only', () => {
    expect(workflow).toContain(`git fetch --no-tags origin "refs/pull/\${PR_NUMBER}/head"`);
    expect(workflow).not.toContain('git checkout');
  });
});

describe('browser smoke artifact policy', () => {
  test('report uploads are failure-only with a manual dispatch escape hatch', () => {
    const workflow = readText('.github/workflows/browser-smoke.yml');

    expect(workflow).toContain('always_upload_report');
    expect(workflow).toContain(`if: \${{ failure() || inputs.always_upload_report }}`);
    expect(workflow).toMatch(
      /- name: Upload traces and screenshots on failure\n\s+if: failure\(\)/
    );
    expect(workflow).not.toMatch(/if: always\(\)/);
  });
});
