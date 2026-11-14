import { ROOT_DIR } from './lib/config';
import { removePaths } from './lib/fs';
import {
  assertNoUnexpectedArguments,
  exitWithResults,
  header,
  parseArgs,
  type RunResult,
  runTask,
} from './lib/runner';
import { rustCleanPaths } from './lib/rust-workspace-lane';

// Build and local test artifacts removed by a plain `clean`.
const ARTIFACT_PATHS = [
  'apps/frontend/dist',
  'apps/api/dist',
  'apps/shared/dist',
  '.mango/artifacts',
  '.mango/out',
  'apps/frontend/coverage',
  'apps/api/coverage',
  'apps/shared/coverage',
  'playwright-report',
  'test-results',
  '.jscpd-out',
  '.qa-gate',
];

// Additionally removed by `--dist-clean`.
const NODE_MODULES_PATHS = [
  'node_modules',
  'apps/frontend/node_modules',
  'apps/api/node_modules',
  'apps/shared/node_modules',
];

function printHelp(): never {
  console.log(`Usage: bun run clean [flags]

Removes dist, local test reports, coverage, and build artifacts.

Flags:
  --dist-clean   Also remove all node_modules directories
  --rust         Also remove cargo output: the workspace target directory and
                 crates/mango-protocol/fuzz/target. This deletes the
                 mangostudio-runtime binary the API tests spawn; rebuild it
                 with cargo build -p mangostudio-runtime --locked.
  --help         Show this help message`);
  process.exit(0);
}

const { flags, positional } = parseArgs({
  booleanFlags: ['--dist-clean', '--rust'],
});

if (flags['--help']) {
  printHelp();
}

assertNoUnexpectedArguments(positional);

const isDistClean = flags['--dist-clean'] ?? false;

header(isDistClean ? 'Dist Clean' : 'Clean');

const results: RunResult[] = [await runTask('clean', () => removePaths(ARTIFACT_PATHS))];

if (flags['--rust']) {
  results.push(await runTask('remove cargo output', () => removePaths(rustCleanPaths(ROOT_DIR))));
}

if (isDistClean) {
  results.push(await runTask('remove node_modules', () => removePaths(NODE_MODULES_PATHS)));
}

exitWithResults(results);
