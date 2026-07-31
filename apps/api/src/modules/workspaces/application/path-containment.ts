/**
 * Re-exports the canonical path-containment helpers from the runtime package.
 * Workdir policy decisions stay hub-side; the algorithm is shared.
 */

export {
  assertInsideWorkdir,
  isInside,
  isPathPrefix,
  resolvePathForContainment,
  WorkdirContainmentError,
} from '@mangostudio/runtime';
