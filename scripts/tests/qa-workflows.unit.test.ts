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
import { extractJobBlock } from './support/workflow-blocks';

// Trust-boundary policy for the PR QA pipeline: workflows that execute
// pull-request code must stay read-only, and the write-capable publisher must
// never execute anything a PR controls. These tests pin that split so a
// workflow edit cannot silently reintroduce the privileged-PR-code pattern.

const COLLECTION_WORKFLOWS = [
  '.github/workflows/ci.yml',
  '.github/workflows/test.yml',
  '.github/workflows/build.yml',
  '.github/workflows/rust-coverage.yml',
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

  test('qa-metrics.yml holds only contents: read at workflow scope', () => {
    const workflow = readText('.github/workflows/qa-metrics.yml');

    expect(workflow).toContain('permissions:\n  contents: read\n\njobs:');
  });

  test('test.yml hands the fragment off with 1-day retention and failure-only coverage', () => {
    const workflow = readText('.github/workflows/test.yml');

    expect(workflow).toContain('name: qa-test-metrics');
    expect(workflow).toMatch(
      /name: qa-test-metrics\n\s+path: test-metrics\.json\n\s+retention-days: 1\n/
    );
    expect(workflow).toContain(
      'bun ./scripts/qa-gate/render-coverage-summary.ts test-metrics.json'
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
    expect(workflow).toMatch(
      /qa-metrics:\n(.*\n)*?\s+needs: \[test, build, changes, rust-coverage\]/
    );
    expect(workflow).toContain(
      "!cancelled() && (github.event_name == 'pull_request' || (github.event_name == 'push' && github.ref == 'refs/heads/main'))"
    );
  });

  test("the Test job's result reaches the collector through an env var, not an inline expression", () => {
    const ci = readText('.github/workflows/ci.yml');
    const qaMetrics = readText('.github/workflows/qa-metrics.yml');

    expect(ci).toContain('test_result: ${{ needs.test.result }}');
    expect(qaMetrics).toContain('test_result:');
    expect(qaMetrics).toContain('QA_TEST_RESULT: ${{ inputs.test_result }}');
    // Only the env mapping interpolates it: never a script body (zizmor template-injection).
    expect(qaMetrics.split('inputs.test_result').length - 1).toBe(1);
  });

  test('qa-metrics measures the build job artifact rather than rebuilding', () => {
    const build = readText('.github/workflows/build.yml');
    const qaMetrics = readText('.github/workflows/qa-metrics.yml');
    const ci = readText('.github/workflows/ci.yml');

    expect(build).toContain('name: frontend-dist');
    expect(qaMetrics).toContain('name: frontend-dist');
    expect(qaMetrics).toContain('QA_FRONTEND_DIST: ./frontend-dist');
    expect(qaMetrics).not.toContain('cache-scoped');
    expect(ci).toContain('needs: [test, build, changes, rust-coverage]');
  });

  test('qa-metrics still runs when Rust Coverage is skipped: its condition holds a status-check function', () => {
    // A job whose `needs` include a skipped job is skipped too, unless its `if`
    // contains a status-check function (`!cancelled()` counts). Without it a
    // docs-only PR would get no envelope, and CI / Gate would fail on the skip.
    const block = extractJobBlock(readText('.github/workflows/ci.yml'), 'qa-metrics');

    expect(block).toContain('needs: [test, build, changes, rust-coverage]');
    expect(block).toMatch(/if: \$\{\{ !cancelled\(\) && /);
  });

  test("the Rust job's relevance and result reach the collector through env vars, not inline expressions", () => {
    const ci = readText('.github/workflows/ci.yml');
    const qaMetrics = readText('.github/workflows/qa-metrics.yml');

    expect(ci).toContain('rust_relevant: ${{ needs.changes.outputs.rust }}');
    expect(ci).toContain('rust_result: ${{ needs.rust-coverage.result }}');
    expect(qaMetrics).toContain('QA_RUST_RELEVANT: ${{ inputs.rust_relevant }}');
    expect(qaMetrics).toContain('QA_RUST_RESULT: ${{ inputs.rust_result }}');
    // Only the env mappings interpolate them: never a script body (zizmor template-injection).
    expect(qaMetrics.split('inputs.rust_relevant').length - 1).toBe(1);
    expect(qaMetrics.split('inputs.rust_result').length - 1).toBe(1);
  });

  test('qa-metrics reads the Rust coverage artifact of its own run, downloaded as data', () => {
    const qaMetrics = readText('.github/workflows/qa-metrics.yml');
    const rustCoverage = readText('.github/workflows/rust-coverage.yml');

    expect(rustCoverage).toContain('name: qa-rust-coverage');
    expect(qaMetrics).toContain('name: qa-rust-coverage');
    // Same-run download: no `run-id`, so it can never read another run's bytes.
    expect(qaMetrics).not.toContain('run-id:');
    expect(qaMetrics).toContain('--rust-coverage ./qa-rust-coverage');
  });
});

describe('rust-coverage.yml (instrumented ubuntu Rust tests, PR code)', () => {
  const workflow = readText('.github/workflows/rust-coverage.yml');
  const shim = readText('.github/workflows/cargo-shim.yml');

  test('is a reusable workflow with contents: read only and no privileged trigger', () => {
    expect(workflow).toContain('on:\n  workflow_call:\n\npermissions:\n  contents: read\n\njobs:');
    expect(workflow).not.toContain('pull_request_target');
    expect(workflow).not.toContain('secrets:');
    expect(workflow).not.toMatch(/: write\b/);
  });

  test('installs cargo-llvm-cov at an exact version through the SHA-pinned install action', () => {
    expect(workflow).toMatch(
      /uses: taiki-e\/install-action@[0-9a-f]{40} # v[\d.]+\n\s+with:\n\s+tool: cargo-llvm-cov@\d+\.\d+\.\d+\n/
    );
    expect(workflow).toContain('rustup component add llvm-tools-preview');
  });

  test('runs exactly the test set the plain Ubuntu step ran, with the libtest runner', () => {
    const plain = shim.match(/cargo test (--workspace --all-targets --all-features --locked)/)?.[1];

    expect(plain, 'the plain cargo test step in cargo-shim.yml').toBeDefined();
    expect(workflow).toContain(`cargo llvm-cov --no-report ${plain}`);
    expect(workflow).not.toContain('nextest');
  });

  test('exports the receipt even when the tests failed, never when the run was cancelled', () => {
    expect(workflow).toMatch(
      /name: Export coverage and receipt\n\s+if: \$\{\{ !cancelled\(\) \}\}/
    );
    expect(workflow).toMatch(/name: Upload Rust coverage\n\s+if: \$\{\{ !cancelled\(\) \}\}/);
    expect(workflow).toContain('retention-days: 1');
  });

  test('cargo-shim keeps the plain run on macOS and Windows only', () => {
    expect(shim).toMatch(
      /- name: Run tests\n\s+if: matrix\.os != 'ubuntu-latest'\n\s+run: cargo test --workspace --all-targets --all-features --locked/
    );
    expect(shim.match(/cargo test --workspace --all-targets/g)).toHaveLength(1);
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

  test('hands privileged Actions job timings to the report renderer', () => {
    expect(workflow).toContain(`writeFile('ci-durations.json'`);
    expect(workflow).toContain('args+=(--ci ci-durations.json)');
  });

  test('renders and publishes the two comments independently', () => {
    // Separate renderer steps, each tolerating failure, so a crashed QA
    // render still leaves commits.md (and vice versa) for the publish step.
    expect(workflow).toContain('args=(report-context.json --part metrics)');
    expect(workflow).toContain('report-context.json --part commits > commits.md');
    expect(workflow.match(/continue-on-error: true/g)).toHaveLength(2);
    expect(workflow).toContain(`readReportBody('metrics.md', 'metrics')`);
    expect(workflow).toContain(`readReportBody('commits.md', 'commits')`);
    expect(workflow).toContain('publishQaComments');
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
