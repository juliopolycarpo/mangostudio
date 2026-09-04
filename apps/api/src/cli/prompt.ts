/**
 * A single yes/no prompt over stdin/stdout, for commands that confirm a
 * destructive or one-way action before doing it (`upgrade`, `upgrade
 * --rollback`). Callers gate this behind their own interactivity check —
 * this always tries to read a line, so it is only for a caller that already
 * knows a human is at the keyboard.
 */

import { createInterface } from 'node:readline/promises';

const YES_PATTERN = /^y(es)?$/i;

/** Ask `question`, appending the `[y/N]` hint, and resolve true only for an explicit yes. // Usage: await promptYesNo('Continue?') */
export async function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return YES_PATTERN.test(answer.trim());
  } finally {
    rl.close();
  }
}
