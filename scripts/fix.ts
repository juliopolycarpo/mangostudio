import { ROOT_DIR, ROOT_LINT_PATHS, ROOT_TOOLING_PATHS } from './lib/config';
import { touchesProtocolSurface } from './lib/protocol';
import {
  assertNoUnexpectedArguments,
  exitWithResults,
  getChangedFiles,
  getStagedFiles,
  header,
  info,
  mapFilesToWorkspaces,
  parseArgs,
  resolveDefaultBase,
  runCommand,
  type RunResult,
  runWorkspaceScript,
} from './lib/runner';

function printHelp(): never {
  console.log(`Usage: bun run fix [workspace flags] [mode flags]

Runs Bun lint --fix and bun fmt for selected workspaces and root paths.
Default workspace selection: --all

Workspace flags:
  --frontend
  --api
  --shared
  --root     Run root-level fixes only (tooling lint + docs)
  --all

Mode flags:
  --staged       Scope to workspaces touched by staged files
  --changed      Scope to workspaces changed vs origin/main
  --base <ref>   Base ref for --changed (default: merge-base HEAD origin/main)
  --help`);
  process.exit(0);
}

const { workspaces, includeRoot, flags, values, positional } = parseArgs({
  booleanFlags: ['--staged', '--changed'],
  valueFlags: ['--base'],
});

if (flags['--help']) {
  printHelp();
}

assertNoUnexpectedArguments(positional);

header('Fix');

let effectiveWorkspaces = workspaces;
let effectiveIncludeRoot = includeRoot;
// rustfmt reads the whole cargo workspace, so it is keyed on the protocol
// surface rather than on `includeRoot` — the same predicate scripts/check.ts
// scopes its protocol lane with. Staging a README would otherwise reformat
// every crate in the repository.
let includeProtocol = includeRoot;

if (flags['--staged']) {
  const files = getStagedFiles();
  if (files.length === 0) {
    info('No staged files — nothing to fix.');
    process.exit(0);
  }
  const mapped = mapFilesToWorkspaces(files);
  effectiveWorkspaces = mapped.workspaces;
  effectiveIncludeRoot = mapped.includeRoot;
  includeProtocol = touchesProtocolSurface(files);
} else if (flags['--changed']) {
  const base = values['--base'] ?? resolveDefaultBase();
  const files = getChangedFiles(base);
  if (files.length === 0) {
    info('No changed files — nothing to fix.');
    process.exit(0);
  }
  const mapped = mapFilesToWorkspaces(files);
  effectiveWorkspaces = mapped.workspaces;
  effectiveIncludeRoot = mapped.includeRoot;
  includeProtocol = touchesProtocolSurface(files);
}

const results: RunResult[] = [];

if (effectiveWorkspaces.length > 0) {
  info('\nWorkspaces');
  for (const ws of effectiveWorkspaces) {
    results.push(await runWorkspaceScript(ws, 'fix'));
  }
}

if (effectiveIncludeRoot) {
  info('\nRoot');
  const rootLintResult = await runCommand(
    'root:lint:fix',
    ['bun', 'lint', '--fix', ...ROOT_LINT_PATHS],
    { cwd: ROOT_DIR }
  );
  results.push(rootLintResult);

  if (rootLintResult.exitCode !== 0) {
    exitWithResults(results);
  }

  const rootFmtResult = await runCommand('root:fmt:fix', ['bun', 'fmt', ...ROOT_TOOLING_PATHS], {
    cwd: ROOT_DIR,
  });
  results.push(rootFmtResult);
}

if (includeProtocol) {
  // rustfmt over the protocol crate. Bun lint and fmt above already cover the
  // package's TypeScript and its markdown; nothing else here speaks Rust.
  results.push(
    await runCommand('root:protocol:fix', ['bun', './scripts/protocol/fix.ts'], { cwd: ROOT_DIR })
  );
}

if (results.length === 0) {
  info('No affected workspaces — nothing to fix.');
  process.exit(0);
}

exitWithResults(results);
