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

/** One error headline parsed from a test-run log or JUnit report, with its originated-in file when present. */
export interface TestErrorHeadline {
  readonly message: string;
  readonly originatedIn: string | null;
}

/**
 * Outcome of the single authoritative test pass (`bun run test --coverage`),
 * which runs every workspace's full suite plus the root scripts tests.
 *
 * Failure fields are omitted on a green run so stored baselines and the
 * rendered report stay unchanged. `parseMiss` is set when the process exited
 * non-zero and no failure signal could be parsed, never as zeros.
 */
export type TestSuiteStats = {
  readonly exitCode: number | null;
  readonly durationSeconds: number | null;
  readonly passed: number;
  readonly root: number;
  /** JUnit failing `<testcase>` count (Bun `N fail`). */
  readonly failed?: number;
  /** Distinct files owning a failing `<testcase>`. */
  readonly failedFiles?: number;
  /** Bun's `N error(s)` summary line — unhandled errors between tests. */
  readonly errors?: number;
  readonly headlines?: readonly TestErrorHeadline[];
  readonly parseMiss?: boolean;
} & Readonly<Record<WorkspaceName, number>>;

export interface ToolingCheckStats {
  readonly checkExitCode: number;
  readonly failedTasks: readonly string[];
}

/**
 * The error half of `Failable`. Named rather than inlined so `isError` can
 * declare the identical type: a structurally equal but separately written
 * `{ error: string }` does not narrow `Failable<T>`'s negative branch back to
 * `T`, and every downstream property access then fails.
 */
export type CollectorError = { readonly error: string };

/** A successfully collected value, or a captured error message in its place. */
export type Failable<T> = T | CollectorError;

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
