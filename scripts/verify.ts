import { ROOT_DIR } from './lib/config';
import { exitWithResults, header, info, type RunResult, runCommand } from './lib/runner';

function printHelp(): never {
  console.log(`Usage: bun run verify

Runs the local gate: check → test --coverage → build --all.
Stops on first failure.

Add bun run protocol:test --ts-only for the protocol TypeScript tests omitted
by the coverage phase. Relevant changes also require the
full Rust and protocol contributor gates documented in docs/reference/testing.md.

Run smoke jobs separately:
  - Browser smoke:  bun run test --e2e
  - Binary smoke:   bun scripts/test-build.ts

Flags:
  --help   Show this help message`);
  process.exit(0);
}

if (process.argv.includes('--help')) {
  printHelp();
}

header('Verify (local check/coverage/build gate)');

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
