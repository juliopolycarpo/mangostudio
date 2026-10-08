#!/usr/bin/env bun
// The real `run-test-workers` main for the integration lane with a stand-in
// launcher, so a test can start it where turbo's task process would be and
// cancel it. Run from apps/api, where the lane's real file census is.
//
// Usage: see scripts/tests/test-workers-cancel.unit.test.ts

import { main, systemDeps } from '../../run-test-workers';
import { FAKE_BUN_TEST } from './fake-bun-test';

/** Where this file lives, for the root runner that starts it. */
export const FAKE_LANE_MAIN = import.meta.path;

if (import.meta.main) {
  const mergedPath = process.env.MANGOSTUDIO_FAKE_MERGED_PATH as string;
  const code = await main(
    ['--lane=api-integration', '--', 'bun', 'test', '--timeout', '15000', 'tests/integration'],
    { ...systemDeps(), launcher: [process.execPath, FAKE_BUN_TEST], mergedPath }
  );
  process.exit(code);
}
