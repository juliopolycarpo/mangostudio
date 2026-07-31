// Public metric shapes produced by the QA-gate collector and consumed by the
// renderer. Kept separate from the executable so importing them has no side effect.

import type { WorkspaceName } from '../../lib/config';
import type { CoverageSummary } from '../parse-lcov';

// Re-export so the renderer and orchestrator get every metric shape from here.
export type { CoverageSummary } from '../parse-lcov';

export interface LocBucket {
  readonly files: number;
  readonly code: number;
  readonly comment: number;
  readonly blank: number;
  readonly total: number;
}

export interface DuplicationStats {
  readonly clones: number;
  readonly duplicatedLines: number;
  readonly percentage: number;
}

export interface BundleStats {
  readonly files: number;
  readonly rawBytes: number;
  readonly gzipBytes: number;
  readonly jsGzipBytes: number;
  readonly cssGzipBytes: number;
  readonly htmlGzipBytes: number;
}

export interface DependencyStats {
  readonly workspaceManifests: number;
  readonly directDependencies: number;
  readonly directDevDependencies: number;
  readonly lockedPackages: number;
}

/**
 * Outcome of the single authoritative test pass (`bun run test --coverage`),
 * which runs every workspace's full suite plus the root scripts tests.
 */
export type TestSuiteStats = {
  readonly exitCode: number | null;
  readonly durationSeconds: number | null;
  readonly passed: number;
  readonly root: number;
} & Readonly<Record<WorkspaceName, number>>;

export interface ToolingCheckStats {
  readonly checkExitCode: number;
  readonly failedTasks: readonly string[];
}

/** A successfully collected value, or a captured error message in its place. */
export type Failable<T> = T | { readonly error: string };

/**
 * Test-derived metrics emitted by the CI Test job right after its single
 * `bun run test --coverage` pass (see collect-test-metrics.ts). collect.ts
 * merges this fragment instead of running a second test pass.
 */
export interface TestMetricsFragment {
  readonly tests: Failable<TestSuiteStats>;
  readonly coverage: Readonly<Record<WorkspaceName, Failable<CoverageSummary>>>;
}

export interface Metrics {
  readonly sha: string;
  readonly generatedAt: string;
  readonly loc: Readonly<Record<WorkspaceName | 'total', Failable<LocBucket>>>;
  readonly coverage: Readonly<Record<WorkspaceName, Failable<CoverageSummary>>>;
  readonly tsErrors: Readonly<Record<WorkspaceName, Failable<number>>>;
  readonly duplication: Failable<DuplicationStats>;
  readonly circularDeps: Failable<number>;
  readonly frontendBundle: Failable<BundleStats>;
  readonly dependencies: Failable<DependencyStats>;
  readonly tests: Failable<TestSuiteStats>;
  readonly tooling: Failable<ToolingCheckStats>;
}
