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
  'tests/integration/server/slow-route-idle-timeout.integration.test.ts': 15,
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
