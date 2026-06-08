import { createTurboDevCommand, DEV_WORKSPACES, getDevCwd, selectDevWorkspaces } from './lib/dev';
import {
  assertNoUnexpectedArguments,
  fatal,
  header,
  info,
  parseArgs,
  runCommand,
  warn,
} from './lib/runner';

function printHelp(): never {
  console.log(`Usage: bun run dev [workspace flags]

Starts development servers for the selected workspaces.
Default: api + frontend

Workspace flags:
  --api        Start the API server
  --frontend   Start the frontend server
  --all        Start every dev-capable workspace
  --help       Show this help message`);
  process.exit(0);
}

const { workspaces, includeRoot, flags, positional, usedDefaultSelection } = parseArgs();

if (flags['--help']) {
  printHelp();
}

assertNoUnexpectedArguments(positional);

if (includeRoot) {
  warn('Ignoring `--root` for `dev`.');
}

const requestedWorkspaces = usedDefaultSelection ? DEV_WORKSPACES : workspaces;
const { runnableWorkspaces, skippedWorkspaces } = selectDevWorkspaces(requestedWorkspaces);

if (skippedWorkspaces.length > 0) {
  warn(`Skipping workspaces without a dev entrypoint: ${skippedWorkspaces.join(', ')}`);
}

if (runnableWorkspaces.length === 0) {
  fatal('No dev-capable workspace selected. Use `--api` and/or `--frontend`.');
}

header('Dev');

info(`Starting dev task(s): ${runnableWorkspaces.join(', ')}`);

const result = await runCommand('dev', createTurboDevCommand(runnableWorkspaces), {
  cwd: getDevCwd(),
  stdin: 'inherit',
});

process.exit(result.exitCode);
