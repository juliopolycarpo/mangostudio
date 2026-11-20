// Tracked weights for the worker lanes that split by them (`laneSpec` in
// ./test-workers.ts reads `LANE_WEIGHTS`). A weight is a file's measured wall
// time in seconds, rounded to whole seconds below 10 s and to multiples of 5
// from 10 s up, so a re-measure that finds a file 10% slower leaves its line
// alone. Only files of 3 s and more
// are listed; every other file weighs 1 (`DEFAULT_FILE_WEIGHT` in
// ./test-workers.ts).
//
// These are source and not a timings file: the partition is a function of the
// commit, the same on every machine and every run, which is what lets a
// cross-file leak be reproduced from a SHA. A stale weight costs balance and
// nothing else, so nothing has to keep them fresh. To refresh one, read the
// `time` of each file's `<testsuite>` in a lane's merged report
// (`.mango/artifacts/test-workers/<lane>.xml`), average a few runs, round as
// above, and keep the keys in path order. `scripts/tests/test-lane-weights.unit.test.ts`
// checks that every key is a file its lane owns.
//
// The figures come from the per-file times of the lane's own runner, at four
// workers.

import type { TestLaneId } from './test-lanes';

/** Whole seconds a lane's test file is worth to the split, by the path the lane's census spells it. */
export type FileWeights = Readonly<Record<string, number>>;

/** Root lane (`scripts/`, run from the repository root): paths are repo-relative. */
const ROOT_LANE_WEIGHTS: FileWeights = {
  'apps/api/tests/integration/modules/environments/wsl-runtime-scripts.integration.test.ts': 9,
  'scripts/qa-gate/collect/capture-process.unit.test.ts': 10,
  'scripts/tests/benchmark-runtime-version.unit.test.ts': 3,
  'scripts/tests/check-cache.unit.test.ts': 45,
  'scripts/tests/check-report.unit.test.ts': 4,
  'scripts/tests/exec-process-tree.unit.test.ts': 30,
  'scripts/tests/fixture-command.unit.test.ts': 7,
  'scripts/tests/frontend-api-import-boundary.unit.test.ts': 3,
  'scripts/tests/import-cycles.unit.test.ts': 30,
  'scripts/tests/install-sh-layout.unit.test.ts': 4,
  'scripts/tests/merge-test-shards.unit.test.ts': 6,
  'scripts/tests/native-build-command.integration.test.ts': 10,
  'scripts/tests/native-bun-qualification-process.unit.test.ts': 7,
  'scripts/tests/run-tests-watchdog.unit.test.ts': 35,
  'scripts/tests/runtime-handshake-benchmark.unit.test.ts': 7,
  'scripts/tests/runtime-handshake.unit.test.ts': 6,
  'scripts/tests/rust-cost-driver-cancellation.unit.test.ts': 10,
  'scripts/tests/shared-root-import-boundary.unit.test.ts': 8,
  'scripts/tests/smoke-binary-cleanup.unit.test.ts': 3,
  'scripts/tests/smoke-step-continuation.unit.test.ts': 15,
  'scripts/tests/source-scan-stamp.unit.test.ts': 12,
  'scripts/tests/supervision-fixtures.unit.test.ts': 25,
  'scripts/tests/test-workers-cancel.unit.test.ts': 3,
  'scripts/tests/test-workers-process.unit.test.ts': 10,
  'scripts/tests/typecheck-graph.unit.test.ts': 5,
  'scripts/tests/unit-cache-graph.unit.test.ts': 3,
  'scripts/tests/wait-for-health-shell.unit.test.ts': 20,
  'scripts/tests/watchdog-attempts-receipt.unit.test.ts': 5,
};

/**
 * Root lane on Windows, from the JUnit `time` of each file in native qualification
 * run 44730340513 (one process per file, two workers). The order is not Linux's:
 * the install layout tests, `check-cache` and the watchdog tests spawn a process per
 * step, which costs seconds there and milliseconds on Linux. `check-cache` is from
 * run 44735730857 (112.7 s), after its cycle cases began sharing one warm pass;
 * the first run measured it at 226.5 s.
 */
const ROOT_LANE_WINDOWS_WEIGHTS: FileWeights = {
  'apps/api/tests/unit/modules/environments/runtime-slot-scripts.test.ts': 6,
  'scripts/protocol/versions.test.ts': 15,
  'scripts/qa-gate/collect/capture-process.unit.test.ts': 3,
  'scripts/qa-gate/render-report.unit.test.ts': 15,
  'scripts/tests/api-lanes-hermetic.unit.test.ts': 15,
  'scripts/tests/api-response-map-guard.unit.test.ts': 6,
  'scripts/tests/archive-assets.unit.test.ts': 7,
  'scripts/tests/archive-creation.unit.test.ts': 7,
  'scripts/tests/benchmark-cancel-barrier.unit.test.ts': 7,
  'scripts/tests/binary-compile-autoload.integration.test.ts': 6,
  'scripts/tests/build.unit.test.ts': 10,
  'scripts/tests/bun-lint.integration.test.ts': 8,
  'scripts/tests/canary-approval-preparation.unit.test.ts': 10,
  'scripts/tests/canary-approval.unit.test.ts': 20,
  'scripts/tests/canary-promotion-source.unit.test.ts': 9,
  'scripts/tests/canary-tags.unit.test.ts': 4,
  'scripts/tests/canary-validation.unit.test.ts': 4,
  'scripts/tests/changed-paths.unit.test.ts': 7,
  'scripts/tests/check-cache.unit.test.ts': 115,
  'scripts/tests/check-report.unit.test.ts': 9,
  'scripts/tests/distribution-artifact.unit.test.ts': 3,
  'scripts/tests/fixture-command.unit.test.ts': 7,
  'scripts/tests/frontend-compiler-cache.unit.test.ts': 7,
  'scripts/tests/git.unit.test.ts': 4,
  'scripts/tests/i18n-import-boundary.unit.test.ts': 3,
  'scripts/tests/import-cycles.unit.test.ts': 60,
  'scripts/tests/install-ps1-layout.unit.test.ts': 60,
  'scripts/tests/install-sh-layout.unit.test.ts': 55,
  'scripts/tests/merge-test-shards.unit.test.ts': 5,
  'scripts/tests/native-bun-qualification-process.unit.test.ts': 9,
  'scripts/tests/native-bun-qualification.unit.test.ts': 50,
  'scripts/tests/native-command-machine-output.unit.test.ts': 7,
  'scripts/tests/nightly-npm-doctor.unit.test.ts': 6,
  'scripts/tests/patch-cache.unit.test.ts': 4,
  'scripts/tests/protocol-changelog.unit.test.ts': 4,
  'scripts/tests/protocol-check-entrypoints.unit.test.ts': 3,
  'scripts/tests/protocol-lanes.unit.test.ts': 9,
  'scripts/tests/publish-release.unit.test.ts': 6,
  'scripts/tests/push-dist-repo.unit.test.ts': 5,
  'scripts/tests/release-prerelease.unit.test.ts': 5,
  'scripts/tests/root-lane-workers.unit.test.ts': 5,
  'scripts/tests/run-tests-watchdog.unit.test.ts': 50,
  'scripts/tests/runtime-handshake.unit.test.ts': 5,
  'scripts/tests/shared-root-import-boundary.unit.test.ts': 15,
  'scripts/tests/source-scan-stamp.unit.test.ts': 25,
  'scripts/tests/standalone-runners.unit.test.ts': 10,
  'scripts/tests/supervision-fixtures.unit.test.ts': 40,
  'scripts/tests/typecheck-graph.unit.test.ts': 10,
  'scripts/tests/unit-cache-graph.unit.test.ts': 10,
  'scripts/tests/verify-release-tag.unit.test.ts': 9,
  'scripts/tests/watchdog-attempts-receipt.unit.test.ts': 10,
  'scripts/tests/windows-user-path.unit.test.ts': 5,
};

/** Api integration lane (`tests/integration`, run from `apps/api`): paths are workspace-relative. */
const API_INTEGRATION_LANE_WEIGHTS: FileWeights = {
  'tests/integration/cli/runtime-binary-probe.integration.test.ts': 6,
  'tests/integration/cli/ssh-client-probe.integration.test.ts': 5,
  'tests/integration/modules/environments/wsl-runtime-scripts.integration.test.ts': 9,
  'tests/integration/modules/generation/mcp-turn.integration.test.ts': 4,
  'tests/integration/routes/environment-entities.integration.test.ts': 5,
  'tests/integration/routes/git-navigation.integration.test.ts': 4,
  'tests/integration/routes/git-worktrees.integration.test.ts': 4,
  'tests/integration/routes/git-write.integration.test.ts': 9,
  'tests/integration/routes/realtime-routes.integration.test.ts': 4,
  'tests/integration/routes/respond-stream-mcp-interactive.integration.test.ts': 5,
  'tests/integration/routes/terminal-socket.integration.test.ts': 25,
  'tests/integration/server/slow-route-idle-timeout.integration.test.ts': 30,
  'tests/integration/server/sse-stream-idle-timeout.integration.test.ts': 15,
  'tests/integration/server/start-server.integration.test.ts': 15,
  'tests/integration/services/rust-command-compat.integration.test.ts': 5,
  'tests/integration/services/rust-runtime-library-propagation.integration.test.ts': 10,
  'tests/integration/services/rust-runtime-library-removal.integration.test.ts': 8,
  'tests/integration/services/rust-runtime-qualification.integration.test.ts': 25,
  'tests/integration/services/spawn-runtime-child.integration.test.ts': 15,
};

/**
 * The weights of each lane that splits by them. The api unit lane has none and
 * keeps Bun's `--shard=i/N`, which already balances it.
 */
export const LANE_WEIGHTS: Readonly<Partial<Record<TestLaneId, FileWeights>>> = {
  root: ROOT_LANE_WEIGHTS,
  'api-integration': API_INTEGRATION_LANE_WEIGHTS,
};

/**
 * Lanes whose Windows timings differ enough from `LANE_WEIGHTS` to need a table of
 * their own. A lane absent here uses its `LANE_WEIGHTS` entry on Windows too.
 */
export const WINDOWS_LANE_WEIGHTS: Readonly<Partial<Record<TestLaneId, FileWeights>>> = {
  root: ROOT_LANE_WINDOWS_WEIGHTS,
};

/**
 * The weights a lane splits by on a platform, or undefined for a lane that keeps `--shard`.
 *
 * @example
 * laneWeights('root', 'win32')?.['scripts/tests/check-cache.unit.test.ts']; // => 115
 * laneWeights('api-unit', 'linux'); // => undefined
 */
export function laneWeights(
  laneId: TestLaneId,
  platform: NodeJS.Platform
): FileWeights | undefined {
  return (platform === 'win32' ? WINDOWS_LANE_WEIGHTS[laneId] : undefined) ?? LANE_WEIGHTS[laneId];
}
