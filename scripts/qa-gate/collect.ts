// QA-gate metrics collector entrypoint. Discovers the repository's components,
// measures each one, assembles every metric (each failing independently into an
// explicit `unavailable` measurement via measure()) and writes the versioned v4
// qa-metrics envelope as JSON to stdout. Collectors live in ./collect/*; shapes
// in ./model and ./metrics-envelope.
//
// Provenance comes from the environment (set by the workflow): the producer
// facts from GITHUB_SHA / GITHUB_RUN_ID / GITHUB_RUN_ATTEMPT (see
// collect/provenance.ts), the repository from GITHUB_REPOSITORY, plus
// QA_PR_NUMBER / QA_BASE_SHA / QA_HEAD_SHA for pull_request runs. Local runs
// fall back to placeholder repository and run identity.
//
// Test-derived metrics (suite outcome + coverage) come from the fragment the
// CI Test job writes via collect-test-metrics.ts (`--test-metrics <path>`), so
// the suite runs exactly once per report. Without the flag, coverage is read
// from local artifacts (dev convenience) and the suite outcome is marked as
// unavailable.

import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { collectFrontendBundle } from './collect/bundle';
import { countCircularDeps } from './collect/circular';
import { collectComponents } from './collect/components';
import { collectDependencyStats } from './collect/dependencies';
import { collectDuplication } from './collect/duplication';
import {
  NO_FRAGMENT,
  parseTestMetricsFragment,
  resolveTestMetrics,
  type TestMetricsInputs,
  unusableTestMetrics,
} from './collect/fragment';
import { readProvenance } from './collect/provenance';
import { discoverComponents } from './collect/registry';
import { getCommitSha, measure, runCapture, stderrLog } from './collect/support';
import { collectToolingStats } from './collect/tooling';
import type { Metrics } from './collect/types';
import { countTsErrors } from './collect/typescript';
import { readWorkspaceCoverageSummary } from './coverage-summary';
import { type QaMetricsEnvelope, serializeQaMetricsEnvelope } from './metrics-envelope';
import { QA_METRICS_SCHEMA_VERSION } from './model/envelope';

const parseTestMetricsPath = (argv: readonly string[]): string | null => {
  const flagIndex = argv.indexOf('--test-metrics');
  if (flagIndex === -1) return null;
  const path = argv[flagIndex + 1];
  if (!path || path.startsWith('--')) {
    process.stderr.write('Usage: bun ./scripts/qa-gate/collect.ts [--test-metrics <path>]\n');
    process.exit(1);
  }
  return path;
};

const loadTestMetrics = async (path: string, sourceSha: string): Promise<TestMetricsInputs> => {
  const file = Bun.file(path);
  if (!(await file.exists())) return NO_FRAGMENT;
  const parsed = parseTestMetricsFragment(await file.text());
  if ('error' in parsed) {
    stderrLog(`${path}: ${parsed.error}`);
    return unusableTestMetrics(`${path}: ${parsed.error}`);
  }
  return resolveTestMetrics(parsed.fragment, sourceSha);
};

const readRepoText = (path: string): Promise<string> => Bun.file(join(ROOT_DIR, path)).text();

const listTrackedFiles = async (): Promise<string[]> => {
  const { stdout, exitCode, stderr } = await runCapture(['git', 'ls-files']);
  if (exitCode !== 0) throw new Error(`git ls-files failed: ${stderr.trim()}`);
  return stdout.split('\n').filter((line) => line.length > 0);
};

const buildMetrics = async (
  sourceSha: string,
  testMetrics: TestMetricsInputs
): Promise<Metrics> => {
  const trackedFiles = await listTrackedFiles();
  // Throws RegistryIntegrityError: a file no component owns must fail the run,
  // not vanish from the totals.
  const specs = await discoverComponents({ trackedFiles, readText: readRepoText });
  const components = await collectComponents(specs, {
    trackedFiles,
    readText: readRepoText,
    deliveredCoverage: testMetrics.deliveredCoverage,
    readCoverage: readWorkspaceCoverageSummary,
    countTsErrors,
  });

  return {
    sha: sourceSha,
    generatedAt: new Date().toISOString(),
    components,
    duplication: await measure('duplication', collectDuplication),
    circularDeps: await measure('circularDeps', countCircularDeps),
    frontendBundle: await measure('frontendBundle', collectFrontendBundle),
    dependencies: await measure('dependencies', collectDependencyStats),
    tests: testMetrics.tests,
    tooling: await measure('tooling', collectToolingStats),
  };
};

const optionalEnv = (name: string): string | null => {
  const value = process.env[name];
  return value && value.length > 0 ? value : null;
};

const envPrNumber = (): number | null => {
  const raw = optionalEnv('QA_PR_NUMBER');
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
};

const rootManifest = JSON.parse(await Bun.file(join(ROOT_DIR, 'package.json')).text()) as {
  version?: string;
};
const provenance = readProvenance(process.env, {
  checkoutHead: getCommitSha(),
  producerVersion: rootManifest.version ?? '0.0.0',
});
const testMetricsPath = parseTestMetricsPath(process.argv.slice(2));
const testMetrics = testMetricsPath
  ? await loadTestMetrics(testMetricsPath, provenance.sourceSha)
  : NO_FRAGMENT;

const envelope: QaMetricsEnvelope = {
  schemaVersion: QA_METRICS_SCHEMA_VERSION,
  repository: optionalEnv('GITHUB_REPOSITORY') ?? 'local/dev',
  prNumber: envPrNumber(),
  baseSha: optionalEnv('QA_BASE_SHA'),
  headSha: optionalEnv('QA_HEAD_SHA') ?? provenance.sourceSha,
  provenance,
  metrics: await buildMetrics(provenance.sourceSha, testMetrics),
};

process.stdout.write(serializeQaMetricsEnvelope(envelope));
