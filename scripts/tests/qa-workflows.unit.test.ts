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
import {
  extractJobBlock,
  extractOnBlock,
  extractStepBlock,
  extractStepBlocks,
  extractStepBlocksUsing,
  extractTopLevelBlock,
  parseNeedsList,
  sectionKeys,
} from './support/workflow-blocks';

// Trust-boundary policy for the PR QA pipeline: workflows that execute
// pull-request code must stay read-only, and the write-capable publisher must
// never execute anything a PR controls. These tests pin that split so a
// workflow edit cannot silently reintroduce the privileged-PR-code pattern.
//
// A guard names the job or step that must carry a line and reads only that
// block: several of these workflows repeat the same artifact, env and
// permission lines in sibling jobs, so a whole-file match would stay green
// after the line left the job it guards.

const QA_METRICS_PATH = '.github/workflows/qa-metrics.yml';
const COLLECT_STEP = 'Collect QA metrics envelope';
const qaCollectStep = (name: string) =>
  extractStepBlock(extractJobBlock(readText(QA_METRICS_PATH), 'collect'), name);

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

    expect(extractTopLevelBlock(workflow, 'permissions'), `${path}: workflow permissions`).toMatch(
      /^ {2}contents: read$/m
    );
    expect(workflow).not.toContain('pull-requests: write');
    expect(workflow).not.toContain('github-script');
  });

  test('qa-metrics.yml holds only contents: read at workflow scope', () => {
    const workflow = readText(QA_METRICS_PATH);

    expect(sectionKeys(extractTopLevelBlock(workflow, 'permissions'))).toEqual(['contents']);
    expect(extractTopLevelBlock(workflow, 'permissions')).toMatch(/^ {2}contents: read$/m);
    expect(extractJobBlock(workflow, 'collect')).not.toMatch(/^\s+permissions:/m);
  });

  test('qa-metrics consumes canonical Check evidence without restoring a duplicate check cache', () => {
    const workflow = readText(QA_METRICS_PATH);
    const collect = extractJobBlock(workflow, 'collect');
    const cacheSteps = extractStepBlocks(collect).filter((step) =>
      /uses: [.$]\/\.github\/actions\/cache-scoped\b/.test(step)
    );
    expect(cacheSteps).toHaveLength(0);
    expect(extractStepBlock(collect, 'Download canonical Check evidence')).toContain(
      'qa-check-evidence-'
    );
    expect(extractStepBlock(collect, COLLECT_STEP)).toContain('QA_CHECK_INVOCATION_ID:');
    expect(extractJobBlock(readText('.github/workflows/ci.yml'), 'qa-metrics')).toContain(
      'needs.check.outputs.invocation_id'
    );
  });

  test('test.yml keeps the metrics fragment for reruns and uploads coverage on failure', () => {
    const merge = extractJobBlock(readText('.github/workflows/test.yml'), 'merge');

    const upload = extractStepBlock(merge, 'Upload test metrics fragment');
    expect(upload).toMatch(/^ {10}name: qa-test-metrics$/m);
    expect(upload).toMatch(/^ {10}path: test-metrics\.json$/m);
    expect(upload).toMatch(/^ {10}retention-days: 30$/m);
    expect(extractStepBlock(merge, 'Coverage summary')).toContain(
      'bun ./scripts/qa-gate/render-coverage-summary.ts test-metrics.json'
    );
    expect(extractStepBlock(merge, 'Upload coverage')).toMatch(/^ {8}if: failure\(\)$/m);
  });

  test('qa-metrics.yml uploads the envelope under the shared artifact name', () => {
    const upload = qaCollectStep('Upload qa-metrics envelope');

    expect(upload).toMatch(new RegExp(`^ {10}name: ${QA_METRICS_ARTIFACT_NAME}$`, 'm'));
    expect(qaCollectStep(COLLECT_STEP)).toContain(`> ${QA_METRICS_FILE_NAME}`);
    // Main-push envelopes are the long-lived baselines; PR envelopes are not.
    expect(upload).toContain("github.event_name == 'push' && 90 || 7");
  });

  test('collector timing upload is advisory, failure-preserving and separate from the QA envelope', () => {
    const collect = extractJobBlock(readText(QA_METRICS_PATH), 'collect');
    const upload = extractStepBlock(collect, 'Upload collector timings');
    expect(extractStepBlock(collect, COLLECT_STEP)).toContain(
      '--timings .mango/artifacts/qa-collector-timings.json > metrics.json'
    );
    // eslint-disable-next-line no-template-curly-in-string -- GitHub expressions and shell placeholders are literal fixture input.
    expect(upload).toContain('if: ${{ !cancelled() }}');
    expect(upload).toContain('continue-on-error: true');
    expect(upload).toContain('name: qa-collector-timings');
    expect(upload).toContain('overwrite: true');
    const envelopeUpload = extractStepBlock(collect, 'Upload qa-metrics envelope');
    expect(upload.match(/uses: (actions\/upload-artifact@\S+)/)?.[1]).toBe(
      envelopeUpload.match(/uses: (actions\/upload-artifact@\S+)/)?.[1]
    );
    expect(upload).toContain('retention-days: 7');
    expect(upload).toContain('if-no-files-found: warn');
    expect(readText('.github/workflows/pr-qa-report.yml')).not.toContain('qa-collector-timings');
  });

  test('ci.yml collects metrics only for PRs and main pushes, after test and build', () => {
    const caller = extractJobBlock(readText('.github/workflows/ci.yml'), 'qa-metrics');

    expect(caller).toContain('uses: $/.github/workflows/qa-metrics.yml');
    expect(parseNeedsList(caller)).toEqual(['test', 'build', 'changes', 'rust-coverage', 'check']);
    expect(caller).toContain(
      "!cancelled() && (github.event_name == 'pull_request' || (github.event_name == 'push' && github.ref == 'refs/heads/main'))"
    );
  });

  test("the Test job's result reaches the collector through an env var, not an inline expression", () => {
    const caller = extractJobBlock(readText('.github/workflows/ci.yml'), 'qa-metrics');
    const qaMetrics = readText(QA_METRICS_PATH);

    // eslint-disable-next-line no-template-curly-in-string -- GitHub expressions and shell placeholders are literal fixture input.
    expect(caller).toContain('test_result: ${{ needs.test.result }}');
    expect(extractOnBlock(qaMetrics)).toMatch(/^ {6}test_result:$/m);
    // eslint-disable-next-line no-template-curly-in-string -- GitHub expressions and shell placeholders are literal fixture input.
    expect(qaCollectStep(COLLECT_STEP)).toContain('QA_TEST_RESULT: ${{ inputs.test_result }}');
    // Only the env mapping interpolates it: never a script body (zizmor template-injection).
    expect(qaMetrics.split('inputs.test_result').length - 1).toBe(1);
  });

  test('qa-metrics measures the build job artifact rather than rebuilding', () => {
    const build = extractJobBlock(readText('.github/workflows/build.yml'), 'build');
    const qaMetrics = readText(QA_METRICS_PATH);
    const [upload, ...otherUploads] = extractStepBlocksUsing(build, 'actions/upload-artifact');

    expect(otherUploads, 'build job: expected exactly one upload-artifact step').toEqual([]);
    expect(upload).toContain(
      `name: frontend-${'$'}{{ inputs.source_sha }}-${'$'}{{ github.run_attempt }}`
    );
    expect(qaCollectStep('Download frontend dist')).toContain('name: frontend-dist');
    expect(qaCollectStep(COLLECT_STEP)).toContain(
      "steps.frontend.outcome == 'success' && './apps/frontend/dist' || './frontend-unavailable'"
    );
    expect(qaMetrics).not.toContain('bun run build');
    expect(
      parseNeedsList(extractJobBlock(readText('.github/workflows/ci.yml'), 'qa-metrics'))
    ).toEqual(['test', 'build', 'changes', 'rust-coverage', 'check']);
  });

  test('qa-metrics still runs when Rust Coverage is skipped: its condition holds a status-check function', () => {
    // A job whose `needs` include a skipped job is skipped too, unless its `if`
    // contains a status-check function (`!cancelled()` counts). Without it a
    // docs-only PR would get no envelope, and CI / Gate would fail on the skip.
    const block = extractJobBlock(readText('.github/workflows/ci.yml'), 'qa-metrics');

    expect(block).toContain('needs: [test, build, changes, rust-coverage, check]');
    expect(block).toMatch(/if: \$\{\{ !cancelled\(\) && /);
  });

  test("the Rust job's relevance and result reach the collector through env vars, not inline expressions", () => {
    const caller = extractJobBlock(readText('.github/workflows/ci.yml'), 'qa-metrics');
    const qaMetrics = readText(QA_METRICS_PATH);
    const collector = qaCollectStep(COLLECT_STEP);

    // eslint-disable-next-line no-template-curly-in-string -- GitHub expressions and shell placeholders are literal fixture input.
    expect(caller).toContain('rust_relevant: ${{ needs.changes.outputs.rust }}');
    // eslint-disable-next-line no-template-curly-in-string -- GitHub expressions and shell placeholders are literal fixture input.
    expect(caller).toContain('rust_result: ${{ needs.rust-coverage.result }}');
    // eslint-disable-next-line no-template-curly-in-string -- GitHub expressions and shell placeholders are literal fixture input.
    expect(collector).toContain('QA_RUST_RELEVANT: ${{ inputs.rust_relevant }}');
    // eslint-disable-next-line no-template-curly-in-string -- GitHub expressions and shell placeholders are literal fixture input.
    expect(collector).toContain('QA_RUST_RESULT: ${{ inputs.rust_result }}');
    expect(qaMetrics.split('inputs.rust_relevant').length - 1).toBe(1);
    expect(qaMetrics.split('inputs.rust_result').length - 1).toBe(1);
  });

  test('qa-metrics downloads the artifact ID returned by the Rust coverage producer', () => {
    const caller = extractJobBlock(readText('.github/workflows/ci.yml'), 'qa-metrics');
    const qaMetrics = readText(QA_METRICS_PATH);
    const rustCoverage = readText('.github/workflows/rust-coverage.yml');

    // The job output and the reusable workflow's own output, each where it is declared.
    expect(extractJobBlock(rustCoverage, 'coverage')).toMatch(
      /^ {6}artifact_id: \$\{\{ steps\.upload\.outputs\.artifact-id \}\}$/m
    );
    expect(extractOnBlock(rustCoverage)).toMatch(
      /^ {8}value: \$\{\{ jobs\.coverage\.outputs\.artifact_id \}\}$/m
    );
    expect(caller).toMatch(
      /rust_artifact_id: \$\{\{ needs\.rust-coverage\.outputs\.artifact_id \}\}/
    );
    expect(qaCollectStep('Download Rust coverage')).toMatch(
      /artifact-ids: \$\{\{ inputs\.rust_artifact_id \}\}/
    );
    expect(qaMetrics).not.toContain('name: qa-rust-coverage');
    // Same-run download: no `run-id`, so it can never read another run's bytes.
    expect(qaMetrics).not.toContain('run-id:');
    expect(qaCollectStep(COLLECT_STEP)).toContain('--rust-coverage ./qa-rust-coverage');
  });

  test('skips the Rust coverage download when the producer returned no artifact ID', () => {
    const download = qaCollectStep('Download Rust coverage');

    expect(download).toContain("if: inputs.rust_artifact_id != ''");
    expect(download).toContain('continue-on-error: true');
  });
});

describe('rust-coverage.yml (instrumented ubuntu Rust tests, PR code)', () => {
  const workflow = readText('.github/workflows/rust-coverage.yml');
  const shim = readText('.github/workflows/cargo-shim.yml');

  test('is a reusable workflow with contents: read only and no privileged trigger', () => {
    expect(sectionKeys(extractOnBlock(workflow))).toEqual(['workflow_call']);
    expect(extractTopLevelBlock(workflow, 'permissions')).toMatch(/^ {2}contents: read$/m);
    expect(sectionKeys(extractTopLevelBlock(workflow, 'permissions'))).toEqual(['contents']);
    expect(workflow).not.toContain('pull_request_target');
    expect(workflow).not.toContain('secrets:');
    expect(workflow).not.toMatch(/: write\b/);
  });

  test('installs cargo-llvm-cov at an exact version through the SHA-pinned install action', () => {
    const coverage = extractJobBlock(workflow, 'coverage');
    const installs = extractStepBlocksUsing(coverage, 'taiki-e/install-action');

    expect(installs, 'coverage job: taiki-e/install-action steps').toHaveLength(1);
    expect(installs[0]).toMatch(
      /uses: taiki-e\/install-action@[0-9a-f]{40} # v[\d.]+\n\s+with:\n\s+tool: cargo-llvm-cov@\d+\.\d+\.\d+\n/
    );
    expect(coverage).toContain('rustup component add llvm-tools-preview');
  });

  test('runs exactly the test set the plain macOS and Windows step runs, with the libtest runner', () => {
    const plain = shim.match(
      /cargo nextest run (--workspace --all-targets --all-features --locked) --retries 0/
    )?.[1];

    expect(plain, 'the plain cargo nextest step in cargo-shim.yml').toBeDefined();
    expect(
      extractStepBlock(extractJobBlock(workflow, 'coverage'), 'Run tests with coverage')
    ).toContain(`cargo llvm-cov --no-report ${plain}`);
    expect(workflow).not.toContain('nextest');
  });

  test('exports only after the test command records an exit code, including failures', () => {
    const coverage = extractJobBlock(workflow, 'coverage');
    const tests = extractStepBlock(coverage, 'Run tests with coverage');
    const coverageExport = extractStepBlock(coverage, 'Export coverage and receipt');
    const upload = extractStepBlock(coverage, 'Upload Rust coverage');

    expect(tests).toContain('id: tests');
    expect(tests).toContain('printf \'exit_code=%s\\n\' "$status" >> "$GITHUB_OUTPUT"');
    expect(tests).toContain('exit "$status"');
    expect(coverageExport).toMatch(
      /if: \$\{\{ !cancelled\(\) && steps\.tests\.outputs\.exit_code != '' \}\}/
    );
    expect(coverageExport).toMatch(/TESTS_EXIT_CODE: \$\{\{ steps\.tests\.outputs\.exit_code \}\}/);
    expect(upload).toMatch(
      /if: \$\{\{ !cancelled\(\) && steps\.export_coverage\.outcome == 'success' \}\}/
    );
    expect(upload).toContain('retention-days: 1');
  });

  test('cargo-shim keeps the plain run on macOS and Windows only', () => {
    const run = extractStepBlock(extractJobBlock(shim, 'workspace'), 'Run tests');
    expect(run).toContain("!cancelled() && matrix.os != 'ubuntu-latest'");
    expect(run).toContain(
      'run: cargo nextest run --workspace --all-targets --all-features --locked --retries 0'
    );
    expect(shim.match(/cargo nextest run --workspace --all-targets/g)).toHaveLength(1);
    expect(shim.match(/cargo test --workspace --all-targets/g)).toBeNull();
  });
});

describe('privileged publisher side (pr-qa-report.yml)', () => {
  const workflow = readText('.github/workflows/pr-qa-report.yml');
  const reportStep = (name: string) => extractStepBlock(extractJobBlock(workflow, 'report'), name);

  test('is a workflow_run consumer with an empty top-level permission set', () => {
    expect(sectionKeys(extractOnBlock(workflow))).toEqual(['workflow_run']);
    expect(extractOnBlock(workflow)).toContain('workflows: [CI]\n    types: [completed]');
    expect(workflow).toMatch(/^permissions: \{\}$/m);
    expect(extractJobBlock(workflow, 'report')).toContain(
      `if: \${{ github.event.workflow_run.event == 'pull_request' }}`
    );
  });

  test('grants writes only at job scope, limited to pull-requests', () => {
    // Each scope carries an explanatory comment (zizmor
    // undocumented-permissions), so match line-by-line rather than the block.
    expect(extractJobBlock(workflow, 'report')).toMatch(
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
    const extract = reportStep('Extract metrics payloads');
    expect(extract).toContain('unzip -p');
    expect(extract).toContain('head -c');
    expect(workflow).not.toContain('actions/download-artifact');
  });

  test('mirrors the payload bounds pinned in metrics-envelope.ts', () => {
    // Workflow-level env, read by the extract step; a job or step copy would not be the pin.
    const env = extractTopLevelBlock(workflow, 'env');
    expect(env).toMatch(new RegExp(`^ {2}METRICS_MAX_BYTES: ${QA_METRICS_MAX_BYTES}$`, 'm'));
    expect(env).toMatch(new RegExp(`^ {2}METRICS_FILE_NAME: ${QA_METRICS_FILE_NAME}$`, 'm'));
  });

  test('hands privileged Actions job timings to the report renderer', () => {
    expect(reportStep('Resolve PR and download metrics archives')).toContain(
      `writeFile('ci-durations.json'`
    );
    expect(reportStep('Render QA metrics comment')).toContain('args+=(--ci ci-durations.json)');
  });

  test('renders and publishes the two comments independently', () => {
    // Separate renderer steps, each tolerating failure, so a crashed QA
    // render still leaves commits.md (and vice versa) for the publish step.
    const metrics = reportStep('Render QA metrics comment');
    const commits = reportStep('Render commits and changelog comment');
    const publish = reportStep('Publish comments');

    expect(metrics).toContain('args=(report-context.json --part metrics)');
    expect(metrics).toMatch(/^ {8}continue-on-error: true$/m);
    expect(commits).toContain('report-context.json --part commits > commits.md');
    expect(commits).toMatch(/^ {8}continue-on-error: true$/m);
    // The publish step must see a render failure, not paper over it.
    expect(publish).not.toContain('continue-on-error');
    expect(workflow.match(/continue-on-error: true/g)).toHaveLength(2);
    expect(publish).toContain(`readReportBody('metrics.md', 'metrics')`);
    expect(publish).toContain(`readReportBody('commits.md', 'commits')`);
    expect(publish).toContain('publishQaComments');
  });

  test('fetches PR history as git data only', () => {
    expect(reportStep('Fetch PR head commits')).toContain(
      `git fetch --no-tags origin "refs/pull/\${PR_NUMBER}/head"`
    );
    expect(workflow).not.toContain('git checkout');
  });
});

describe('browser smoke artifact policy', () => {
  test('report uploads are failure-only with a manual dispatch escape hatch', () => {
    const workflow = readText('.github/workflows/browser-smoke.yml');
    const job = extractJobBlock(workflow, 'browser-smoke');

    // The dispatch input is declared under `on:`, and only the HTML report step reads it.
    expect(extractOnBlock(workflow)).toContain('always_upload_report:');
    expect(extractStepBlock(job, 'Upload Playwright HTML report')).toContain(
      `if: \${{ failure() || inputs.always_upload_report }}`
    );
    expect(extractStepBlock(job, 'Upload traces and screenshots on failure')).toMatch(
      /^ {8}if: failure\(\)$/m
    );
    expect(workflow).not.toMatch(/if: always\(\)/);
  });
});
