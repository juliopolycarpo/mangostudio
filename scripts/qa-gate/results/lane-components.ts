// Which component a test lane rolls up into. The lane registry
// (scripts/lib/test-lanes.ts) names a workspace, the component registry names a
// directory; this is the one place the two meet, shared by the collector and
// the policy so they cannot disagree about which lanes a component must have.
//
// Extension point for Rust: a later lane whose `workspace` is a crate maps here
// (one case), and every consumer picks it up without another edit.

import { TEST_LANES, type TestLane } from '../../lib/test-lanes';

/**
 * Repository-relative root of the component a lane belongs to: the root scripts
 * lane belongs to `scripts`, a workspace lane to `apps/<workspace>`.
 * // Usage: laneComponentRoot(laneById('api-unit')) // 'apps/api'
 */
export const laneComponentRoot = (lane: TestLane): string =>
  lane.workspace === 'root' ? 'scripts' : `apps/${lane.workspace}`;

/**
 * The lanes a component root owns, in registry order; empty when none is wired.
 * // Usage: lanesForComponentRoot('apps/api').map((lane) => lane.id) // ['api-unit', 'api-integration']
 */
export const lanesForComponentRoot = (
  root: string,
  lanes: readonly TestLane[] = TEST_LANES
): readonly TestLane[] => lanes.filter((lane) => laneComponentRoot(lane) === root);
