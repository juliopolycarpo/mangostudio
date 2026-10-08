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
//   leak            report, exit 0, leaving a quiet child running in the worker's group
//                   (its pid in MANGOSTUDIO_FAKE_PID_DIR/leak-<i>.pid)
//   leak-session    like leak, but the child starts a session of its own (it keeps the environment)
//   tidy            report, exit 0, with a child that exits 300 ms later (a runtime shutting down)
//   hang-tree       like hang, with a quiet child of its own; pids in
//                   MANGOSTUDIO_FAKE_PID_DIR/tree-worker-<i>.pid and tree-child-<i>.pid
//   hang-session-pipes  a SIGTERM-resistant leader and detached token child that
//                   holds the worker's output pipes; writes both pids once ready
//
// Usage: see scripts/tests/test-workers-process.unit.test.ts

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverTestFiles } from '../../lib/test-workers';
import { fixtureChildEnvironment } from './child-supervision';
import { reportOf, shardOf } from './test-worker-fakes';

/** Where the fake lives, for the launcher in `WorkerLaneSpec`. */
export const FAKE_BUN_TEST = import.meta.path;

/** The cases the fake gives every file it finds. */
export const FAKE_CASES_PER_FILE = 2;

type Mode =
  | 'pass'
  | 'exit1'
  | 'no-report'
  | 'sigkill'
  | 'hang'
  | 'grandchild'
  | 'leak'
  | 'leak-session'
  | 'tidy'
  | 'hang-tree'
  | 'hang-session-pipes';

function main(argv: readonly string[]): void {
  const flag = (name: string): string | undefined =>
    argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  const outfile = flag('--reporter-outfile');
  const [index, count] = (flag('--shard') ?? '1/1').split('/').map(Number) as [number, number];
  const mode = (JSON.parse(process.env.MANGOSTUDIO_FAKE_WORKER_MODES ?? '{}')[String(index)] ??
    'pass') as Mode;

  console.log(`fake worker ${index}/${count} starting (${mode})`);
  console.log(`mango-home=${process.env.MANGO_HOME ?? '<unset>'}`);
  console.error(`fake worker ${index}/${count} stderr`);

  // The lane's directory is the last argument, as in the real command.
  const testDir = argv.at(-1) ?? 'tests/unit';
  const files = discoverTestFiles(process.cwd(), testDir).map((path) => ({
    path,
    cases: Array.from({ length: FAKE_CASES_PER_FILE }, (_, item) => `case ${item}`),
    outcome: mode === 'exit1' ? ('fail' as const) : undefined,
  }));

  if (mode === 'sigkill') process.kill(process.pid, 'SIGKILL');
  if (mode === 'hang-session-pipes') {
    process.on('SIGTERM', () => undefined);
    const dir = process.env.MANGOSTUDIO_FAKE_PID_DIR as string;
    const childReady = join(dir, `session-child-${index}.pid`);
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        '-e',
        "process.on('SIGTERM', () => undefined); require('node:fs').writeFileSync(process.argv.at(-1), String(process.pid)); setInterval(() => undefined, 1000)",
        childReady,
      ],
      // Preserve the fake's deliberate lifetime under a root --no-orphans
      // worker; token signaling, rather than Bun's policy, must end it.
      env: fixtureChildEnvironment(),
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
      detached: true,
    });
    child.unref();
    writeFileSync(join(dir, `session-worker-${index}.pid`), `${process.pid}`);
    setInterval(() => undefined, 1000);
    return;
  }
  if (mode === 'hang-tree') {
    const child = Bun.spawn({
      cmd: [process.execPath, '-e', 'setInterval(() => undefined, 1000)'],
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const dir = process.env.MANGOSTUDIO_FAKE_PID_DIR as string;
    writeFileSync(join(dir, `tree-child-${index}.pid`), `${child.pid}`);
    writeFileSync(join(dir, `tree-worker-${index}.pid`), `${process.pid}`);
    setInterval(() => undefined, 1_000);
    return;
  }
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
  if (mode === 'leak' || mode === 'leak-session' || mode === 'tidy') {
    const lifetime =
      mode === 'tidy'
        ? 'setTimeout(() => process.exit(0), 300)'
        : 'setInterval(() => undefined, 1000)';
    const leaked = Bun.spawn({
      cmd: [process.execPath, '-e', lifetime],
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      detached: mode === 'leak-session',
    });
    writeFileSync(
      join(process.env.MANGOSTUDIO_FAKE_PID_DIR as string, `${mode}-${index}.pid`),
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
