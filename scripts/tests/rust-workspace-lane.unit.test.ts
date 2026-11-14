import { describe, expect, test } from 'bun:test';

import { parseArgs } from '../lib/args';
import { ROOT_DIR } from '../lib/config';
import type { RunResult } from '../lib/exec';
import {
  chainRustTasks,
  missingRustTools,
  planRustLane,
  RUST_CHECK_TASKS,
  RUST_TEST_TASKS,
  type RustLaneTask,
} from '../lib/rust-workspace-lane';
import { readText } from './support/read-text';
import { extractJobBlock, extractStepBlocks } from './support/workflow-blocks';

// `bun run check --rust` and `bun run test --rust` run the commands Cargo
// Shim's `workspace` job runs. The workflow keeps its own steps, so these tests
// are what holds the two together.

const workspaceJob = extractJobBlock(readText('.github/workflows/cargo-shim.yml'), 'workspace');

function stepRunning(command: string): string | undefined {
  return extractStepBlocks(workspaceJob).find((step) => step.includes(`run: ${command}\n`));
}

/** A PATH lookup that finds only the named tools. */
function fakePathWith(...installed: string[]): (tool: string) => string | null {
  return (tool) => (installed.includes(tool) ? `/fake/bin/${tool}` : null);
}

function runScript(script: string, ...args: string[]): { exitCode: number; output: string } {
  const run = Bun.spawnSync([process.execPath, script, ...args], {
    cwd: ROOT_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { exitCode: run.exitCode, output: `${run.stdout.toString()}${run.stderr.toString()}` };
}

describe('Rust workspace lane commands', () => {
  test.each([...RUST_CHECK_TASKS, ...RUST_TEST_TASKS].map((task) => [task.label, task] as const))(
    '%s runs the command of a Cargo Shim workspace step',
    (_label, task) => {
      const command = task.cmd.join(' ');
      const step = stepRunning(command);
      expect(step, `expected a workspace step running: ${command}`).toBeDefined();
      for (const [name, value] of Object.entries(task.env ?? {})) {
        expect(step, `expected ${task.label} step env ${name}`).toContain(`${name}: ${value}\n`);
      }
    }
  );

  test('rustdoc denies warnings, as the workflow step does', () => {
    const doc = RUST_CHECK_TASKS.find((task) => task.label === 'rust:doc');
    expect(doc?.env).toEqual({ RUSTDOCFLAGS: '-D warnings' });
  });

  test('covers the five commands AGENTS.md lists for a Rust change', () => {
    expect([...RUST_CHECK_TASKS, ...RUST_TEST_TASKS].map((task) => task.label)).toEqual([
      'rust:fmt',
      'rust:clippy',
      'rust:doc',
      'rust:nextest',
      'rust:doctest',
    ]);
  });
});

describe('missingRustTools', () => {
  test('reports nothing when every tool is on PATH', () => {
    expect(missingRustTools(RUST_TEST_TASKS, fakePathWith('cargo', 'cargo-nextest'))).toEqual([]);
  });

  test('names cargo-nextest when only cargo is installed', () => {
    expect(missingRustTools(RUST_TEST_TASKS, fakePathWith('cargo'))).toEqual([
      '(rust lane): expected cargo-nextest on PATH | received: not found; ' +
        'install the version docs/reference/testing.md names',
    ]);
  });

  test('the check tasks never ask for cargo-nextest', () => {
    expect(missingRustTools(RUST_CHECK_TASKS, fakePathWith('cargo'))).toEqual([]);
  });

  test('names cargo when no toolchain is installed', () => {
    expect(missingRustTools(RUST_CHECK_TASKS, fakePathWith())).toEqual([
      '(rust lane): expected cargo on PATH | received: not found; ' +
        'install the toolchain rust-toolchain.toml pins (https://rustup.rs)',
    ]);
  });
});

describe('planRustLane', () => {
  test('never runs unrequested, whatever changed', () => {
    expect(planRustLane(false, null)).toEqual({ run: false });
    expect(planRustLane(false, ['crates/mangostudio-runtime/src/main.rs'])).toEqual({
      run: false,
    });
  });

  test('a full run with --rust always runs', () => {
    expect(planRustLane(true, null)).toEqual({ run: true });
  });

  test('a scoped run keeps the lane for a path the Rust workspace reads', () => {
    expect(planRustLane(true, ['docs/README.md', 'Cargo.lock'])).toEqual({ run: true });
    expect(planRustLane(true, ['apps/shared/src/runtime-contract/schemas.ts'])).toEqual({
      run: true,
    });
  });

  test('a scoped run drops the lane, with the reason, for an unrelated change', () => {
    expect(planRustLane(true, ['apps/frontend/src/main.tsx'])).toEqual({
      run: false,
      skipped: 'no changed path feeds the Rust workspace',
    });
    expect(planRustLane(true, [])).toEqual({ run: false, skipped: 'no changed files' });
  });
});

describe('chainRustTasks', () => {
  const tasks: RustLaneTask[] = ['first', 'second', 'third'].map((label) => ({
    label,
    cmd: ['cargo', label],
    tool: 'cargo',
  }));

  test('runs one task at a time even when every thunk is started together', async () => {
    const events: string[] = [];
    const chained = chainRustTasks(tasks, async (task): Promise<RunResult> => {
      events.push(`start ${task.label}`);
      await Bun.sleep(5);
      events.push(`end ${task.label}`);
      return { label: task.label, exitCode: 0, duration: 5 };
    });

    const results = await Promise.all(chained.map((start) => start()));

    expect(events).toEqual([
      'start first',
      'end first',
      'start second',
      'end second',
      'start third',
      'end third',
    ]);
    expect(results.map((result) => result.label)).toEqual(['first', 'second', 'third']);
  });

  test('a task that fails or cannot start does not stop the ones after it', async () => {
    const chained = chainRustTasks(tasks, (task): Promise<RunResult> => {
      if (task.label === 'first')
        return Promise.resolve({ label: task.label, exitCode: 101, duration: 0 });
      if (task.label === 'second') return Promise.reject(new Error('spawn cargo ENOENT'));
      return Promise.resolve({ label: task.label, exitCode: 0, duration: 0 });
    });

    const settled = await Promise.allSettled(chained.map((start) => start()));

    expect(settled.map((entry) => entry.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(settled[2]).toEqual({
      status: 'fulfilled',
      value: { label: 'third', exitCode: 0, duration: 0 },
    });
  });
});

describe('--rust selection', () => {
  const options = { booleanFlags: ['--staged'], selectionFlags: ['--rust'] };

  test('alone it selects no workspace and no root', () => {
    const parsed = parseArgs(options, ['--rust']);
    expect(parsed.flags['--rust']).toBe(true);
    expect(parsed.workspaces).toEqual([]);
    expect(parsed.includeRoot).toBe(false);
    expect(parsed.usedDefaultSelection).toBe(false);
  });

  test('beside --all or a workspace flag it adds to that selection', () => {
    expect(parseArgs(options, ['--all', '--rust']).workspaces).toEqual([
      'frontend',
      'api',
      'shared',
    ]);
    expect(parseArgs(options, ['--api', '--rust']).workspaces).toEqual(['api']);
  });

  test('a caller that does not declare it still rejects it', () => {
    expect(parseArgs({ booleanFlags: ['--staged'] }, ['--rust']).positional).toEqual(['--rust']);
  });

  test('no flags still means every workspace plus root', () => {
    const parsed = parseArgs(options, []);
    expect(parsed.usedDefaultSelection).toBe(true);
    expect(parsed.includeRoot).toBe(true);
  });

  test('fix rejects --rust: rustfmt there follows the protocol surface', () => {
    const { exitCode, output } = runScript('./scripts/fix.ts', '--rust');
    expect(exitCode).toBe(1);
    expect(output).toContain('Unknown argument(s): --rust');
  });

  test('test rejects --rust with --only or --shard', () => {
    for (const flag of ['--only=api', '--shard=1/2']) {
      const { exitCode, output } = runScript('./scripts/test.ts', '--rust', '--coverage', flag);
      expect(exitCode, flag).toBe(1);
      expect(output, flag).toContain('--rust cannot be combined with --only or --shard');
    }
  });

  test.each(['check', 'test'])('%s --help documents --rust', (script) => {
    const { exitCode, output } = runScript(`./scripts/${script}.ts`, '--help');
    expect(exitCode).toBe(0);
    expect(output).toContain('--rust');
  });
});
