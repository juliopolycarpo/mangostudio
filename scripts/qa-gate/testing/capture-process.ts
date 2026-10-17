// Named real-process fixtures for QA capture ownership. Child/grandchild signal
// behaviour is shared with the runner tests; only the capturing parent is new.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runCommand } from '../../lib/exec';
import { fixtureCommand, readGrandchildPid, waitFor } from '../../tests/support/process-tree';
import { runCapture } from '../collect/support';

/** Build a command for the named capture fixture. */
export const captureFixtureCommand = (mode: string, dir: string, ...args: string[]): string[] => [
  process.execPath,
  import.meta.path,
  mode,
  dir,
  ...args,
];

if (import.meta.main) {
  const [mode, dir = '', width = '1', childStop = 'linger:300', grandchildStop = 'linger:300'] =
    process.argv.slice(2);

  if (mode === 'tree') {
    const results = await Promise.all(
      Array.from({ length: Number(width) }, (_, index) =>
        runCapture(fixtureCommand('child', join(dir, String(index)), childStop, grandchildStop))
      )
    );
    process.stdout.write(JSON.stringify(results));
  }

  if (mode === 'nested') {
    const result = await runCommand(
      'qa-capture',
      captureFixtureCommand('tree', dir, width, childStop, grandchildStop)
    );
    process.exit(result.exitCode);
  }

  if (mode === 'echo' || mode === 'exit') {
    const result = await runCapture(fixtureCommand(mode, dir, width));
    process.stdout.write(JSON.stringify(result));
  }

  if (mode === 'inspect') {
    const result = await runCapture(
      [
        process.execPath,
        '-e',
        'process.stdout.write(JSON.stringify({ cwd: process.cwd(), marker: process.env.QA_CAPTURE_FIXTURE_MARKER }))',
      ],
      { cwd: dir }
    );
    process.stdout.write(JSON.stringify(result));
  }

  if (mode === 'pipes') {
    const result = await runCapture(captureFixtureCommand('pipe-holder', dir));
    process.stdout.write(JSON.stringify(result));
  }

  if (mode === 'pipe-holder') {
    Bun.spawn(fixtureCommand('grandchild', dir, 'ignore'), {
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const ready = await waitFor(() => readGrandchildPid(dir) !== undefined, 10_000);
    if (!ready) throw new Error('expected pipe-holding grandchild ready within 10000ms');
    writeFileSync(
      join(dir, 'ready.json'),
      JSON.stringify({ child: process.pid, grandchild: readGrandchildPid(dir) })
    );
    process.exit(0);
  }
}
