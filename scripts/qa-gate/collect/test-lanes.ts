// Per-lane test pass counts, read from the logs and exit-code files the PR QA
// gate writes for the unit and integration lanes.

import { join } from 'node:path';
import { ROOT_DIR } from '../../lib/config';
import { parseTestLanePassCounts } from '../test-lane-summary';
import type { TestLaneName, TestLaneStats } from './types';

const TEST_LANE_LOGS: Readonly<Record<TestLaneName, string>> = {
  unit: '.qa-gate/test-unit.log',
  integration: '.qa-gate/test-integration.log',
};

const TEST_LANE_EXIT_CODES: Readonly<Record<TestLaneName, string>> = {
  unit: '.qa-gate/test-unit.exit-code',
  integration: '.qa-gate/test-integration.exit-code',
};

const parseExitCode = async (relPath: string): Promise<number | null> => {
  const file = Bun.file(join(ROOT_DIR, relPath));
  if (!(await file.exists())) return null;
  const parsed = Number((await file.text()).trim());
  return Number.isFinite(parsed) ? parsed : null;
};

/** Pass counts (per workspace + total) and exit code for a test lane. */
export const collectTestLaneStats = async (lane: TestLaneName): Promise<TestLaneStats> => {
  const text = await Bun.file(join(ROOT_DIR, TEST_LANE_LOGS[lane])).text();
  const stats = parseTestLanePassCounts(text);

  return {
    exitCode: await parseExitCode(TEST_LANE_EXIT_CODES[lane]),
    passed: stats.root + stats.frontend + stats.api + stats.shared,
    root: stats.root,
    frontend: stats.frontend,
    api: stats.api,
    shared: stats.shared,
  };
};
