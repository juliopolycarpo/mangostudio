import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

if (process.argv[2] === 'child') {
  writeFileSync(join(process.cwd(), 'ready'), 'ready');
} else {
  if (process.argv[2] === 'orphan') {
    const child = spawn(process.execPath, [import.meta.path, 'child'], {
      cwd: process.cwd(),
      detached: process.platform === 'win32',
      stdio: 'ignore',
    });
    child.unref();
    const until = performance.now() + 5_000;
    while (!existsSync(join(process.cwd(), 'ready')) && performance.now() < until)
      await Bun.sleep(10);
    if (!existsSync(join(process.cwd(), 'ready')))
      throw new Error('expected orphan child readiness before root exit; received no ready marker');
    process.exit(0);
  }
  Bun.spawn([process.execPath, import.meta.path, 'child'], {
    cwd: process.cwd(),
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
}
// Keep both processes and their inherited output pipes alive through the deadline.
setInterval(() => undefined, 1_000);
