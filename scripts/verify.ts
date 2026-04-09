import { ROOT_DIR } from './lib/config';
import { header, info, runCommand, exitWithResults, type RunResult } from './lib/runner';

header('Verify (full CI gate)');

const results: RunResult[] = [];

const phases: Array<{ label: string; cmd: string[] }> = [
  { label: 'check', cmd: ['bun', './scripts/check.ts'] },
  { label: 'test', cmd: ['bun', './scripts/test.ts'] },
  { label: 'build', cmd: ['bun', 'run', '--filter', '@mangostudio/frontend', 'build'] },
];

for (const phase of phases) {
  info(`\nPhase: ${phase.label}`);
  const result = await runCommand(phase.label, phase.cmd, { cwd: ROOT_DIR });
  results.push(result);
  if (result.exitCode !== 0) break;
}

exitWithResults(results);
