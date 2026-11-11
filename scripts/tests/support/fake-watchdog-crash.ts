import { spawn } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { isAlive } from './process-liveness';
import { waitFor } from './process-tree';

const READY_MARKER = 'stray-ready';

/** Read the atomically published PID of the crash fixture's owned stray.
 * @example const stray = readWatchdogStrayPid(fixtureDirectory);
 */
export function readWatchdogStrayPid(directory: string): number | undefined {
  let value: string;
  try {
    value = readFileSync(join(directory, READY_MARKER), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const pid = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(pid)) {
    throw new Error(`watchdog stray: expected a positive PID | received: ${JSON.stringify(value)}`);
  }
  return pid;
}

if (import.meta.main) {
  if (process.argv[2] === 'stray') {
    writeFileSync(`${READY_MARKER}.tmp`, String(process.pid));
    renameSync(`${READY_MARKER}.tmp`, READY_MARKER);
    await Bun.sleep(30_000);
  } else {
    const directory = process.cwd();
    const priorPid = readWatchdogStrayPid(directory);
    if (priorPid !== undefined) {
      if (isAlive(priorPid)) {
        throw new Error(`expected no live stray at retry entry | received: pid ${priorPid}`);
      }
      console.log(`retry observed stopped stray: ${priorPid}`);
    } else {
      spawn(process.execPath, [import.meta.path, 'stray'], { stdio: 'ignore' }).unref();
      await waitFor(() => readWatchdogStrayPid(directory) !== undefined, 5_000);
      // The old fixture's 500 ms sentinel could fire during this pause.
      await Bun.sleep(750);
      const stray = readWatchdogStrayPid(directory);
      if (stray === undefined || !isAlive(stray)) {
        throw new Error(`expected a live stray before the crash | received: ${stray ?? 'no PID'}`);
      }
      console.log(`stray alive before crash: ${stray}`);
      console.log('panic(main thread): abort()');
      process.exit(134);
    }
  }
}
