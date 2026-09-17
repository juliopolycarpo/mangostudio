/**
 * The in-process runtime's read-freshness registry, reached from a hub test.
 *
 * A module-level registry is per process, and Local runs inside this one, so a
 * test that seeds a read in one case would otherwise satisfy the freshness
 * check in the next. Clearing it between cases is the hub test suite reaching
 * into the runtime it shares a process with — which is exactly why this lives
 * under `tests/support` rather than in `src`: production hub code never
 * touches it, and a hub talking to a spawned runtime could not.
 */

export { assertFresh, clearFileFreshness } from '@mangostudio/runtime';
