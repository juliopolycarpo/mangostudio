// Run summary + exit handling: print a pass/fail table with timings and exit
// with a non-zero code if any task failed.

import type { RunResult } from './exec';
import { DIM, error, GREEN, header, RED, RESET, success } from './log';

// Captured at module load so the total reflects wall-clock time for the script.
const SCRIPT_START = performance.now();

/** Print a pass/fail line per task plus the total elapsed time. */
function printSummary(results: RunResult[]): void {
  header('Summary');
  for (const r of results) {
    const icon = r.exitCode === 0 ? `${GREEN}pass${RESET}` : `${RED}FAIL${RESET}`;
    const time = `${DIM}${r.duration}ms${RESET}`;
    console.log(`  ${icon}  ${r.label}  ${time}`);
  }
  const total = Math.round(performance.now() - SCRIPT_START);
  console.log(`\n  ${DIM}Total: ${total}ms${RESET}`);
}

/** Print the summary and exit 1 if any task failed, otherwise exit 0. */
export function exitWithResults(results: RunResult[]): never {
  printSummary(results);
  const failed = results.filter((r) => r.exitCode !== 0);
  if (failed.length > 0) {
    error(`\n${failed.length} task(s) failed.`);
    process.exit(1);
  }
  success('\nAll tasks passed.');
  process.exit(0);
}
