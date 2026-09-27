import {
  createTurboDevCommand,
  DEV_WORKSPACES,
  getDevCwd,
  planLocalRuntimeBuild,
  selectDevWorkspaces,
  selectTurboDevUi,
} from './lib/dev';
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
Default: api (serves the frontend too)

Workspace flags:
  --api        Start the API server (also serves the frontend)
  --frontend   Alias for --api; the API serves the frontend now
  --all        Start every dev-capable workspace
  --help       Show this help message`);
  process.exit(0);
}

const { workspaces, explicitWorkspaces, includeRoot, flags, positional, usedDefaultSelection } =
  parseArgs();

if (flags['--help']) {
  printHelp();
}

assertNoUnexpectedArguments(positional);

if (includeRoot) {
  warn('Ignoring `--root` for `dev`.');
}

const requestedWorkspaces = usedDefaultSelection ? DEV_WORKSPACES : workspaces;
const { runnableWorkspaces, skippedWorkspaces } = selectDevWorkspaces(requestedWorkspaces);

// `--all` expands to every workspace, so `frontend` appearing in the selection
// there is not somebody asking for a frontend dev server — only an explicit
// `--frontend` is, and only that deserves the redirect notice.
if (explicitWorkspaces.includes('frontend')) {
  warn('The frontend is served by the API dev server now; starting `api` instead of `frontend`.');
}

if (skippedWorkspaces.length > 0) {
  warn(`Skipping workspaces without a dev entrypoint: ${skippedWorkspaces.join(', ')}`);
}

if (runnableWorkspaces.length === 0) {
  fatal('No dev-capable workspace selected. Use `--api` and/or `--frontend`.');
}

header('Dev');

// Local is the Rust runtime the hub spawns, so it is built before the hub
// starts rather than discovered missing on the first request.
const runtimeBuild = planLocalRuntimeBuild(process.env, Bun.which('cargo') !== null);
if (runtimeBuild.kind === 'missing-cargo') fatal(runtimeBuild.message);
if (runtimeBuild.kind === 'skip') {
  info(`Skipping the Local runtime build: ${runtimeBuild.reason}.`);
} else {
  info(`Building the Local runtime: ${runtimeBuild.command.join(' ')}`);
  const built = await runCommand('runtime', [...runtimeBuild.command], { cwd: getDevCwd() });
  if (built.exitCode !== 0) {
    fatal(`\`${runtimeBuild.command.join(' ')}\` exited ${built.exitCode}; Local cannot start.`);
  }
}

info(`Starting dev task(s): ${runnableWorkspaces.join(', ')}`);

const turboUi = selectTurboDevUi(process.env);

const result = await runCommand('dev', createTurboDevCommand(runnableWorkspaces, turboUi), {
  cwd: getDevCwd(),
  stdin: turboUi === 'tui' ? 'inherit' : 'ignore',
});

process.exit(result.exitCode);
