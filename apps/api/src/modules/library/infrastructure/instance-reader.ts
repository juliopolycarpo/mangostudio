/**
 * Hub-side re-exports of the library instance reader. The reader and its byte
 * caps live in `@mangostudio/runtime` (they run on the machine that holds the
 * files); write engines still import from this path until those engines move.
 */

export {
  hashResourceAt,
  type LibraryInstanceReaderFs,
  MAX_LIBRARY_FILE_BYTES,
  readLocationInstances,
  readResourceFile,
} from '@mangostudio/runtime';
