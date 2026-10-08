#!/usr/bin/env bun
// A stand-in for `bun test` that a worker launcher can start in its place: it
// reads the flags the runner plans (`--shard=i/N`, `--reporter-outfile=...`),
// writes the report its shard of the workspace's `tests/unit` files would
// produce, and then ends the way `MANGOSTUDIO_FAKE_WORKER_MODES` says this worker should.
//
// MANGOSTUDIO_FAKE_WORKER_MODES is JSON keyed by worker index, e.g. {"2":"exit1"}:
//   pass (default)  report, exit 0        exit1      failing report, exit 1
//   no-report       exit 0 with no report sigkill    kills itself with SIGKILL
//   hang            waits for a signal; writes MANGOSTUDIO_FAKE_PID_DIR/worker-<i>.pid first
//   grandchild      report, exit 0 — but first leaves a child holding stdout and stderr open
//                   (its pid in MANGOSTUDIO_FAKE_PID_DIR/grandchild-<i>.pid)
//
// Usage: see scripts/tests/test-workers-process.unit.test.ts

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { discoverTestFiles } from '../../lib/test-workers';
import { reportOf, shardOf } from './test-worker-fakes';

/** Where the fake lives, for the launcher in `WorkerLaneSpec`. */
export const FAKE_BUN_TEST = import.meta.path;

/** The cases the fake gives every file it finds. */
export const FAKE_CASES_PER_FILE = 2;

type Mode = 'pass' | 'exit1' | 'no-report' | 'sigkill' | 'hang' | 'grandchild';

function main(argv: readonly string[]): void {
  const flag = (name: string): string | undefined =>
    argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  const outfile = flag('--reporter-outfile');
  const [index, count] = (flag('--shard') ?? '1/1').split('/').map(Number) as [number, number];
  const mode = (JSON.parse(process.env.MANGOSTUDIO_FAKE_WORKER_MODES ?? '{}')[String(index)] ??
    'pass') as Mode;

  console.log(`fake worker ${index}/${count} starting (${mode})`);
  console.error(`fake worker ${index}/${count} stderr`);

  const files = discoverTestFiles(process.cwd(), 'tests/unit').map((path) => ({
    path,
    cases: Array.from({ length: FAKE_CASES_PER_FILE }, (_, item) => `case ${item}`),
    outcome: mode === 'exit1' ? ('fail' as const) : undefined,
  }));

  if (mode === 'sigkill') process.kill(process.pid, 'SIGKILL');
  if (mode === 'hang') {
    writeFileSync(
      join(process.env.MANGOSTUDIO_FAKE_PID_DIR as string, `worker-${index}.pid`),
      `${process.pid}`
    );
    setInterval(() => undefined, 1_000);
    return;
  }
  if (mode === 'grandchild') {
    // A leaked test process: it inherits this worker's pipes and outlives it.
    const leaked = Bun.spawn({
      cmd: [process.execPath, '-e', 'setInterval(() => undefined, 1000)'],
      stdout: 'inherit',
      stderr: 'inherit',
    });
    writeFileSync(
      join(process.env.MANGOSTUDIO_FAKE_PID_DIR as string, `grandchild-${index}.pid`),
      `${leaked.pid}`
    );
    leaked.unref();
  }
  if (mode !== 'no-report' && outfile) {
    writeFileSync(outfile, reportOf(shardOf(files, { index, count })));
  }
  process.exit(mode === 'exit1' ? 1 : 0);
}

if (import.meta.main) main(process.argv.slice(2));
