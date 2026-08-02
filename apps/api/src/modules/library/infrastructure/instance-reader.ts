/**
 * Hub-side re-exports of the library instance reader. The reader and its byte
 * caps live in `@mangostudio/runtime` (they run on the machine that holds the
 * files).
 */

export {
  hashResourceAt,
  type LibraryInstanceReaderFs,
  MAX_LIBRARY_FILE_BYTES,
  readLocationInstances,
  readResourceFile,
} from '@mangostudio/runtime';
