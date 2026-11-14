import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CaptureResult, RunResult } from '../lib/exec';
import {
  PASS_STAMP_DIR,
  passStampKey,
  passStampsEnabled,
  readPassStamp,
  runWithPassStamp,
  writePassStamp,
} from '../lib/pass-stamp';
import { classifyChangedPaths } from '../lib/rust-lanes';
import {
  RUST_TEST_TASKS,
  type RustLaneTask,
  rustTestFacts,
  rustTestInputFiles,
} from '../lib/rust-workspace-lane';
import { withTurboForce } from '../lib/test';

// A pass stamp skips a task that already passed with the same inputs. The
// failure that matters is a stamp that says "passed" for inputs that were never
// run, so most of these tests are about when a stamp must miss or stay unwritten.

let root: string;
let stampDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mango-pass-stamp-'));
  stampDir = join(root, PASS_STAMP_DIR);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeInput(path: string, content: string): void {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** A task that records each start and exits with the next queued code (0 once the queue is empty). */
class FakeTask {
  readonly label = 'fake:task';
  starts = 0;
  /** Runs while the task is "executing", to model an edit made mid-run. */
  duringRun: () => void = () => undefined;
  private readonly exitCodes: number[];

  constructor(...exitCodes: number[]) {
    this.exitCodes = exitCodes;
  }

  readonly run = (): Promise<RunResult> => {
    this.starts += 1;
    this.duringRun();
    return Promise.resolve({
      label: this.label,
      exitCode: this.exitCodes.shift() ?? 0,
      duration: 7,
    });
  };
}

/** Collects the lines a stamped run reports instead of printing them. */
class FakeReport {
  readonly lines: string[] = [];
  readonly write = (message: string): void => {
    this.lines.push(message);
  };
}

function stamped(task: FakeTask, report: FakeReport, files: string[], enabled = true) {
  return runWithPassStamp({
    label: task.label,
    stampDir,
    enabled,
    key: () => passStampKey(root, { files, facts: { tool: 'fake 1.0' } }),
    run: task.run,
    report: report.write,
  });
}

describe('passStampKey', () => {
  const facts = { cargo: 'cargo 1.99.0' };

  test('is the same for the same bytes and facts, however the inputs are ordered', () => {
    writeInput('a.rs', 'a');
    writeInput('b.rs', 'b');
    const key = passStampKey(root, { files: ['a.rs', 'b.rs'], facts: { x: '1', y: '2' } });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(passStampKey(root, { files: ['b.rs', 'a.rs', 'a.rs'], facts: { y: '2', x: '1' } })).toBe(
      key
    );
  });

  test.each([
    ['an edited file', () => writeInput('a.rs', 'changed')],
    ['a new file in the listing', () => writeInput('new.rs', '')],
    ['a deleted file', () => rmSync(join(root, 'b.rs'))],
  ])('changes with %s', (_name, mutate) => {
    writeInput('a.rs', 'a');
    writeInput('b.rs', 'b');
    const list = (): string[] => readdirSync(root).filter((name) => name.endsWith('.rs'));
    const before = passStampKey(root, { files: list(), facts });
    mutate();
    expect(passStampKey(root, { files: list(), facts })).not.toBe(before);
  });

  test('changes when content moves from one file to another', () => {
    writeInput('a.rs', 'one');
    writeInput('b.rs', 'two');
    const before = passStampKey(root, { files: ['a.rs', 'b.rs'], facts });
    writeInput('a.rs', 'two');
    writeInput('b.rs', 'one');
    expect(passStampKey(root, { files: ['a.rs', 'b.rs'], facts })).not.toBe(before);
  });

  test('changes with a fact value or a new fact', () => {
    writeInput('a.rs', 'a');
    const before = passStampKey(root, { files: ['a.rs'], facts });
    expect(passStampKey(root, { files: ['a.rs'], facts: { cargo: 'cargo 1.99.1' } })).not.toBe(
      before
    );
    expect(
      passStampKey(root, { files: ['a.rs'], facts: { ...facts, nextest: '0.9.151' } })
    ).not.toBe(before);
  });

  test('skips a listed path that is a directory or no longer exists', () => {
    writeInput('a.rs', 'a');
    mkdirSync(join(root, 'submodule'));
    expect(passStampKey(root, { files: ['a.rs', 'submodule', 'gone.rs'], facts })).toBe(
      passStampKey(root, { files: ['a.rs'], facts })
    );
  });
});

describe('stamp files', () => {
  const key = 'a'.repeat(64);

  test('reads back the key it wrote, under the label it was written for', () => {
    writePassStamp(stampDir, 'rust:nextest', key);
    expect(readPassStamp(stampDir, 'rust:nextest')).toBe(key);
    expect(readPassStamp(stampDir, 'rust:doctest')).toBeNull();
    expect(readdirSync(stampDir)).toEqual(['rust_nextest.json']);
  });

  test.each([
    ['not JSON', '{"schema":1,'],
    ['an empty file', ''],
    ['another schema', JSON.stringify({ schema: 0, label: 'rust:nextest', key })],
    ['another label', JSON.stringify({ schema: 1, label: 'rust:doctest', key })],
    [
      'a key that is not a SHA-256',
      JSON.stringify({ schema: 1, label: 'rust:nextest', key: 'yes' }),
    ],
    ['a JSON null', 'null'],
  ])('treats %s as no stamp', (_name, content) => {
    mkdirSync(stampDir, { recursive: true });
    writeFileSync(join(stampDir, 'rust_nextest.json'), content);
    expect(readPassStamp(stampDir, 'rust:nextest')).toBeNull();
  });
});

describe('runWithPassStamp', () => {
  test('runs once, then replays the pass and says which inputs it matched', async () => {
    writeInput('a.rs', 'a');
    const task = new FakeTask();
    const report = new FakeReport();

    const first = await stamped(task, report, ['a.rs']);
    const second = await stamped(task, report, ['a.rs']);

    expect(task.starts).toBe(1);
    expect(first).toEqual({ label: 'fake:task', exitCode: 0, duration: 7 });
    const short = passStampKey(root, { files: ['a.rs'], facts: { tool: 'fake 1.0' } }).slice(0, 12);
    expect(second).toEqual({ label: `fake:task (replayed ${short})`, exitCode: 0, duration: 0 });
    expect(report.lines).toEqual([
      `  fake:task: passed before with inputs ${short}; pass --force to run it`,
    ]);
  });

  test('runs again after an input changes', async () => {
    writeInput('a.rs', 'a');
    const task = new FakeTask();
    await stamped(task, new FakeReport(), ['a.rs']);
    writeInput('a.rs', 'edited');
    await stamped(task, new FakeReport(), ['a.rs']);
    expect(task.starts).toBe(2);
  });

  test('a failure leaves no stamp, so the next run executes', async () => {
    writeInput('a.rs', 'a');
    const task = new FakeTask(101);
    const failed = await stamped(task, new FakeReport(), ['a.rs']);
    expect(failed.exitCode).toBe(101);
    expect(readPassStamp(stampDir, task.label)).toBeNull();
    await stamped(task, new FakeReport(), ['a.rs']);
    expect(task.starts).toBe(2);
  });

  test('a failure does not erase the stamp of other inputs, and never replays as a pass', async () => {
    writeInput('a.rs', 'a');
    const task = new FakeTask(0, 101);
    await stamped(task, new FakeReport(), ['a.rs']);
    writeInput('a.rs', 'broken');
    expect((await stamped(task, new FakeReport(), ['a.rs'])).exitCode).toBe(101);
    expect((await stamped(task, new FakeReport(), ['a.rs'])).label).toBe('fake:task');
    expect(task.starts).toBe(3);
  });

  test('an edit made while the task ran is not credited to that run', async () => {
    writeInput('a.rs', 'a');
    const task = new FakeTask();
    task.duringRun = () => writeInput('a.rs', 'edited mid-run');
    const report = new FakeReport();

    const result = await stamped(task, report, ['a.rs']);

    expect(result.exitCode).toBe(0);
    expect(readPassStamp(stampDir, task.label)).toBeNull();
    expect(report.lines).toHaveLength(1);
    expect(report.lines[0]).toMatch(
      /^ {2}fake:task: inputs changed during the run \([0-9a-f]{12} to [0-9a-f]{12}\); pass not recorded$/
    );
    task.duringRun = () => undefined;
    await stamped(task, new FakeReport(), ['a.rs']);
    expect(task.starts).toBe(2);
  });

  test('disabled, it neither reads a matching stamp nor writes one', async () => {
    writeInput('a.rs', 'a');
    const task = new FakeTask();
    await stamped(task, new FakeReport(), ['a.rs'], false);
    expect(readPassStamp(stampDir, task.label)).toBeNull();

    await stamped(task, new FakeReport(), ['a.rs']);
    const again = await stamped(task, new FakeReport(), ['a.rs'], false);
    expect(again.label).toBe('fake:task');
    expect(task.starts).toBe(3);
  });

  test('a corrupt stamp is a miss and is replaced by the next pass', async () => {
    writeInput('a.rs', 'a');
    mkdirSync(stampDir, { recursive: true });
    writeFileSync(join(stampDir, 'fake_task.json'), 'not json');
    const task = new FakeTask();
    await stamped(task, new FakeReport(), ['a.rs']);
    expect(task.starts).toBe(1);
    expect(readPassStamp(stampDir, task.label)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('passStampsEnabled', () => {
  test.each([
    [false, {}, true],
    [true, {}, false],
    [false, { CI: 'true' }, false],
    [false, { CI: '1' }, false],
    [false, { CI: '  ' }, true],
  ])('force %p with env %p is %p', (force, env, expected) => {
    expect(passStampsEnabled(force, env)).toBe(expected);
  });
});

describe('Rust test stamp inputs', () => {
  const checkout = [
    'crates/mangostudio-runtime/src/main.rs',
    'crates/mangostudio-runtime/new-untracked.rs',
    'Cargo.lock',
    'rust-toolchain.toml',
    'spec/schema/1/protocol.json',
    'apps/shared/src/runtime-contract/generated/catalog.json',
    'bun.lock',
    '.bun-version',
    'package.json',
    'patches/@xterm%2Faddon-webgl@0.19.0.patch',
    'apps/frontend/src/main.tsx',
    'docs/reference/testing.md',
    'README.md',
  ];

  test('keeps what the crates and their Bun fixture read and drops the rest', () => {
    const repository = join(import.meta.dir, '..', '..');
    expect(rustTestInputFiles(repository, checkout)).toEqual(checkout.slice(0, 10));
  });

  test('includes every file the crate scan finds, the lane exemption too', () => {
    // RUST_WORKSPACE_PATHS leaves the English catalog to another lane; a stamp
    // has no other lane, so the catalog has to be in its key.
    const repository = join(import.meta.dir, '..', '..');
    const catalog = 'apps/shared/src/i18n/en.ts';
    expect(classifyChangedPaths([catalog]).rust).toBe(false);
    expect(rustTestInputFiles(repository, [catalog])).toEqual([catalog]);
  });
});

/** Answers version probes from a table and records what was asked. */
class FakeToolchain {
  readonly asked: string[] = [];
  private readonly answers: Record<string, CaptureResult>;

  constructor(answers: Record<string, CaptureResult>) {
    this.answers = answers;
  }

  readonly capture = (cmd: string[]): Promise<CaptureResult> => {
    const line = cmd.join(' ');
    this.asked.push(line);
    return Promise.resolve(
      this.answers[line] ?? { stdout: '', stderr: `no fake answer for ${line}`, exitCode: 127 }
    );
  };
}

describe('rustTestFacts', () => {
  const nextest = RUST_TEST_TASKS.find((task) => task.label === 'rust:nextest') as RustLaneTask;
  const doctest = RUST_TEST_TASKS.find((task) => task.label === 'rust:doctest') as RustLaneTask;
  const installed = (): FakeToolchain =>
    new FakeToolchain({
      'rustc -Vv': { stdout: 'rustc 1.99.0\nhost: x86_64\n', stderr: '', exitCode: 0 },
      'cargo -V': { stdout: 'cargo 1.99.0\n', stderr: '', exitCode: 0 },
      'cargo nextest --version': { stdout: 'cargo-nextest 0.9.151\n', stderr: '', exitCode: 0 },
    });

  test('records the task, the tool versions and the host', async () => {
    const facts = await rustTestFacts(nextest, {}, installed().capture);
    expect(facts).toEqual({
      task: JSON.stringify({ cmd: nextest.cmd, env: {} }),
      rustc: 'rustc 1.99.0\nhost: x86_64',
      cargo: 'cargo 1.99.0',
      nextest: 'cargo-nextest 0.9.151',
      bun: `${Bun.version} ${Bun.revision}`,
      host: `${process.platform} ${process.arch}`,
      env: '[]',
    });
  });

  test('asks for the nextest version only for the task that runs it', async () => {
    const toolchain = installed();
    const facts = await rustTestFacts(doctest, {}, toolchain.capture);
    expect(facts.nextest).toBeUndefined();
    expect(toolchain.asked).toEqual(['rustc -Vv', 'cargo -V']);
  });

  test('records cargo and MangoStudio variables, sorted, and nothing else', async () => {
    const facts = await rustTestFacts(
      doctest,
      {
        RUSTFLAGS: '-D warnings',
        MANGOSTUDIO_RUNTIME_BINARY: '/x',
        CARGO_TARGET_DIR: 'out',
        NEXTEST_RETRIES: '2',
        MANGO_RUNNER_GROUP: '4242',
        PATH: '/usr/bin',
        HOME: '/home/someone',
      },
      installed().capture
    );
    expect(JSON.parse(facts.env as string)).toEqual([
      ['CARGO_TARGET_DIR', 'out'],
      ['MANGOSTUDIO_RUNTIME_BINARY', '/x'],
      ['NEXTEST_RETRIES', '2'],
      ['RUSTFLAGS', '-D warnings'],
    ]);
  });

  test('a tool that cannot report its version still yields a distinct fact', async () => {
    const facts = await rustTestFacts(doctest, {}, new FakeToolchain({}).capture);
    expect(facts.rustc).toBe('exit 127: no fake answer for rustc -Vv');
  });
});

describe('withTurboForce', () => {
  test('appends --force to a command with no task arguments', () => {
    expect(withTurboForce(['turbo', 'run', 'test:unit', '--ui=stream'])).toEqual([
      'turbo',
      'run',
      'test:unit',
      '--ui=stream',
      '--force',
    ]);
  });

  test('puts --force before the separator, so Turbo reads it and the task does not', () => {
    expect(withTurboForce(['turbo', 'run', 'test:unit', '--', '--changed=abc'])).toEqual([
      'turbo',
      'run',
      'test:unit',
      '--force',
      '--',
      '--changed=abc',
    ]);
  });
});
