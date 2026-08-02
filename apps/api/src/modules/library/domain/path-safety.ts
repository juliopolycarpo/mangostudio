/**
 * Hub-side re-exports of library write-path safety. The checks run on the
 * machine that holds the files (`@mangostudio/runtime`); hub orchestrators and
 * tests keep this import path.
 */

export {
  assertExpectedResourceEntry,
  LibraryWriteError,
  resolveContainedResourcePath,
} from '@mangostudio/runtime';
