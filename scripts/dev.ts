import type { WorkspaceName } from './lib/config';
import {
  assertNoUnexpectedArguments,
  fatal,
  header,
  info,
  parseArgs,
  runWorkspaceScript,
  warn,
} from './lib/runner';

const DEV_WORKSPACES: WorkspaceName[] = ['api', 'frontend'];

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
const runnableWorkspaces = requestedWorkspaces.filter((workspace) =>
  DEV_WORKSPACES.includes(workspace)
);
const skippedWorkspaces = requestedWorkspaces.filter(
  (workspace) => !DEV_WORKSPACES.includes(workspace)
);

if (skippedWorkspaces.length > 0) {
  warn(`Skipping workspaces without a dev entrypoint: ${skippedWorkspaces.join(', ')}`);
}

if (runnableWorkspaces.length === 0) {
  fatal('No dev-capable workspace selected. Use `--api` and/or `--frontend`.');
}

header('Dev');

const procs = runnableWorkspaces.map((ws) => {
  info(`Starting ${ws} dev server...`);
  return runWorkspaceScript(ws, 'dev');
});

await Promise.all(procs);
