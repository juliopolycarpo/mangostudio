import { ROOT_DIR } from './lib/config';
import {
  assertNoUnexpectedArguments,
  exitWithResults,
  header,
  parseArgs,
  runCommand,
} from './lib/runner';

function printHelp(): never {
  console.log(`Usage: bun run clean [flags]

Removes dist, coverage, and build artifacts.

Flags:
  --dist-clean   Also remove all node_modules directories
  --help         Show this help message`);
  process.exit(0);
}

const { flags, positional } = parseArgs({ booleanFlags: ['--dist-clean'] });

if (flags['--help']) {
  printHelp();
}

assertNoUnexpectedArguments(positional);

const isDistClean = flags['--dist-clean'] ?? false;

header(isDistClean ? 'Dist Clean' : 'Clean');

const results = [];

const cleanResult = await runCommand(
  'clean',
  [
    'rm',
    '-rf',
    'apps/frontend/dist',
    'apps/api/dist',
    'apps/shared/dist',
    'apps/frontend/coverage',
    'apps/api/coverage',
    'apps/shared/coverage',
    '.mango/out',
  ],
  { cwd: ROOT_DIR }
);
results.push(cleanResult);

if (isDistClean) {
  const nmResult = await runCommand(
    'remove node_modules',
    [
      'rm',
      '-rf',
      'node_modules',
      'apps/frontend/node_modules',
      'apps/api/node_modules',
      'apps/shared/node_modules',
    ],
    { cwd: ROOT_DIR }
  );
  results.push(nmResult);
}

exitWithResults(results);
