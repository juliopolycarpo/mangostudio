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

export type TestLaneName = 'unit' | 'integration';

export interface TestLaneStats {
  readonly exitCode: number | null;
  readonly passed: number;
  readonly root: number;
  readonly frontend: number;
  readonly api: number;
  readonly shared: number;
}

export interface ToolingCheckStats {
  readonly checkExitCode: number;
  readonly failedTasks: readonly string[];
}

/** A successfully collected value, or a captured error message in its place. */
export type Failable<T> = T | { readonly error: string };

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
  readonly tests: Readonly<Record<TestLaneName, Failable<TestLaneStats>>>;
  readonly tooling: Failable<ToolingCheckStats>;
}
