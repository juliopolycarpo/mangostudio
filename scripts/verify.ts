import { ROOT_DIR } from './lib/config';
import { exitWithResults, header, info, type RunResult, runCommand } from './lib/runner';

function printHelp(): never {
  console.log(`Usage: bun run verify

Runs the full local CI gate: check → test --coverage → build --all.
Stops on first failure.

This matches the CI pipeline (ci.yml) minus the smoke jobs, which require
platform runners not available in every local environment:
  - Browser smoke:  bun run test --e2e
  - Binary smoke:   bun scripts/test-build.ts

Flags:
  --help   Show this help message`);
  process.exit(0);
}

if (process.argv.includes('--help')) {
  printHelp();
}

header('Verify (full CI gate)');

const results: RunResult[] = [];

const phases: Array<{ label: string; cmd: string[] }> = [
  { label: 'check', cmd: ['bun', './scripts/check.ts'] },
  { label: 'test', cmd: ['bun', './scripts/test.ts', '--coverage'] },
  { label: 'build', cmd: ['bun', './scripts/build.ts', '--all'] },
];

for (const phase of phases) {
  info(`\nPhase: ${phase.label}`);
  const result = await runCommand(phase.label, phase.cmd, { cwd: ROOT_DIR });
  results.push(result);
  if (result.exitCode !== 0) break;
}

exitWithResults(results);
