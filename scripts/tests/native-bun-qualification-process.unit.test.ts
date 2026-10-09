import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import {
  type NativeProcess,
  parseNativeProcesses,
  runNativeCommand,
  scopeNativeProcesses,
  snapshotNativeProcesses,
} from '../lib/native-bun-qualification-process';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class CapturedOutput extends Writable {
  text = '';
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (error?: Error | null) => void
  ): void {
    this.text += chunk.toString();
    done();
  }
}

function processRow(
  pid: number,
  parentPid: number,
  identity = `${pid}:start`,
  group: number | null = 10
): NativeProcess {
  return { pid, parentPid, identity, group, command: `process-${pid}` };
}

async function unavailableSnapshot(): Promise<NativeProcess[]> {
  await Promise.resolve();
  throw new Error('named fake census permission failure');
}

async function emptySnapshot(): Promise<NativeProcess[]> {
  await Promise.resolve();
  return [];
}

async function waitForFixturePid(path: string): Promise<number> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      return Number(await readFile(path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await Bun.sleep(1);
    }
  }
  throw new Error(`Fixture PID ${path} missing; expected a started command`);
}

async function waitForFixtureExit(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        await Bun.sleep(20);
        return;
      }
      throw error;
    }
    await Bun.sleep(1);
  }
  throw new Error(`Fixture process ${pid} survived; expected its explicit exit`);
}

class ExitDuringSnapshot {
  private captured: NativeProcess[] = [];
  constructor(
    private readonly pidFile: string,
    private readonly exitFile: string,
    private readonly wrongOrigin = false
  ) {}

  read = async (): Promise<NativeProcess[]> => {
    if (this.captured.length)
      return this.captured.slice(1).map((row) => ({ ...row, parentPid: 1 }));
    const pid = await waitForFixturePid(this.pidFile);
    const group = process.platform === 'win32' ? null : pid;
    this.captured = [
      processRow(
        pid,
        this.wrongOrigin ? -1 : process.pid,
        `${pid}:2026-10-08T12:00:00.0000000Z`,
        this.wrongOrigin ? -1 : group
      ),
      processRow(10_000_001, pid, '10000001:2026-10-08T12:00:00.0000001Z', group),
    ];
    // The rows were captured with a live original root. Deliver them only after its exit event.
    await writeFile(this.exitFile, 'exit');
    await waitForFixtureExit(pid);
    return this.captured;
  };
}

function exitingFixtureCommand(pidFile: string, exitFile: string): readonly string[] {
  return [
    process.execPath,
    '-e',
    'await Bun.write(process.argv[1], String(process.pid)); while (!(await Bun.file(process.argv[2]).exists())) await Bun.sleep(1); process.exit(0);',
    pidFile,
    exitFile,
  ];
}

async function temporaryDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'native-process-receipt-'));
  temporary.push(dir);
  return dir;
}

describe('native process identity', () => {
  test('refuses stale Windows parent edges when an older orphan points at a reused parent PID', () => {
    const root = processRow(10, 1, '10:2026-10-08T12:00:00.0000002Z', null);
    const older = processRow(20, 10, '20:2026-10-08T12:00:00.0000001Z', null);
    const newer = processRow(30, 10, '30:2026-10-08T12:00:00.0000003Z', null);
    const result = scopeNativeProcesses([root, older, newer], {
      rootPid: 10,
      rootAlive: true,
      rootIdentity: null,
      observed: [],
    });
    expect(result.observed.map((row) => row.pid)).toEqual([10, 30]);
  });
  test('parses POSIX and Windows creation identities and rejects partial snapshots', () => {
    expect(parseNativeProcesses(' 10 1 10 Thu Oct 8 12:00:00 2026 bun run test', 'darwin')).toEqual(
      [
        {
          pid: 10,
          parentPid: 1,
          group: 10,
          identity: '10:Thu Oct 8 12:00:00 2026',
          command: 'bun run test',
        },
      ]
    );
    expect(
      parseNativeProcesses(
        '[{"pid":10,"parentPid":1,"created":"2026-10-08T12:00:00.001Z","command":"bun.exe"}]',
        'win32'
      )[0].identity
    ).toBe('10:2026-10-08T12:00:00.001Z');
    expect(() => parseNativeProcesses('not a process row', 'linux')).toThrow(
      'expected PID PPID PGID'
    );
    expect(() => parseNativeProcesses('', 'linux')).toThrow('Empty ps snapshot');
    expect(() => parseNativeProcesses('{"pid":10}', 'win32')).toThrow('expected a JSON array');
    expect(() => parseNativeProcesses('[{"pid":10}]', 'win32')).toThrow(
      'expected PID, parent PID, and creation time'
    );
  });

  test('retains reparented descendants and excludes reused PIDs and unrelated processes', () => {
    const first = scopeNativeProcesses(
      [
        processRow(10, 1),
        processRow(20, 10),
        processRow(30, 20),
        processRow(99, 1, '99:other', 99),
      ],
      { rootPid: 10, rootAlive: true, rootIdentity: null, observed: [] }
    );
    expect(first.observed.map((row) => row.pid)).toEqual([10, 20, 30]);
    const terminal = scopeNativeProcesses(
      [processRow(20, 1), processRow(30, 1, '30:reused', 30), processRow(99, 20, '99:child', 99)],
      { rootPid: 10, rootAlive: false, rootIdentity: first.rootIdentity, observed: first.observed }
    );
    expect(terminal.current.map((row) => row.pid)).toEqual([20, 99]);
    const reusedRoot = scopeNativeProcesses(
      [processRow(10, 1, '10:reused', 10), processRow(88, 10, '88:unrelated', 10)],
      { rootPid: 10, rootAlive: false, rootIdentity: first.rootIdentity, observed: first.observed }
    );
    expect(reusedRoot.current).toEqual([]);
  });

  test('reads a native census containing this test process', async () => {
    const rows = await snapshotNativeProcesses();
    const self = rows.find((row) => row.pid === process.pid);
    expect(self?.identity).toBeTruthy();
    expect(self?.parentPid).toBeGreaterThanOrEqual(0);
  });
});

describe('single command receipt', () => {
  test('retains an owned child when the original root exits during the first snapshot', async () => {
    const dir = await temporaryDirectory();
    const pidFile = join(dir, 'pid');
    const exitFile = join(dir, 'exit');
    const observer = new ExitDuringSnapshot(pidFile, exitFile);
    const result = await runNativeCommand({
      label: 'race',
      command: exitingFixtureCommand(pidFile, exitFile),
      root: dir,
      out: dir,
      env: { ...process.env },
      timeoutSeconds: 5,
      pollIntervalMs: 10,
      settleMs: 0,
      snapshot: observer.read,
      guardCompilerHelpers: false,
      stream: new CapturedOutput(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.settlement.observed).toHaveLength(2);
    expect(result.settlement.survivors.map((row) => row.pid)).toEqual([10_000_001]);
    expect(result.settlement).toMatchObject({
      rootObserved: true,
      empty: false,
      snapshotErrors: [],
    });
  });

  test('refuses a first root row with an unrelated parent or process group', async () => {
    const dir = await temporaryDirectory();
    const pidFile = join(dir, 'pid');
    const exitFile = join(dir, 'exit');
    const observer = new ExitDuringSnapshot(pidFile, exitFile, true);
    const result = await runNativeCommand({
      label: 'wrong-origin',
      command: exitingFixtureCommand(pidFile, exitFile),
      root: dir,
      out: dir,
      env: { ...process.env },
      timeoutSeconds: 5,
      pollIntervalMs: 10,
      settleMs: 0,
      snapshot: observer.read,
      guardCompilerHelpers: false,
      stream: new CapturedOutput(),
    });
    expect(result.settlement.observed).toEqual([]);
    expect(result.settlement).toMatchObject({ rootObserved: false, empty: false });
    expect(result.settlement.snapshotErrors.join('\n')).toContain('unexpected root origin');
  });

  test('records an unobserved fast metadata root without certifying its ancestry', async () => {
    const dir = await temporaryDirectory();
    const result = await runNativeCommand({
      label: 'metadata',
      command: [process.execPath, '-e', 'process.exit(0)'],
      root: dir,
      out: dir,
      env: { ...process.env },
      timeoutSeconds: 5,
      pollIntervalMs: 10,
      settleMs: 0,
      snapshot: emptySnapshot,
      stream: new CapturedOutput(),
    });
    expect(result.settlement).toMatchObject({
      rootObserved: false,
      empty: true,
      observed: [],
      survivors: [],
    });
  });
  test('streams and retains both outputs and observes terminal settlement', async () => {
    const dir = await temporaryDirectory();
    const stream = new CapturedOutput();
    const delayMs = process.platform === 'win32' ? 2_000 : 400;
    const result = await runNativeCommand({
      label: 'fixture',
      command: [
        process.execPath,
        '-e',
        `setTimeout(() => { console.log("stdout receipt"); console.error("stderr receipt"); }, ${delayMs})`,
      ],
      root: dir,
      out: dir,
      env: { ...process.env },
      timeoutSeconds: 5,
      pollIntervalMs: 50,
      stream,
    });
    expect(result).toMatchObject({
      exitCode: 0,
      timedOut: false,
      errors: [],
      settlement: { empty: true, snapshotErrors: [], survivors: [] },
    });
    expect(result.settlement.observed.length).toBeGreaterThan(0);
    expect(stream.text).toContain('stdout receipt');
    expect(await readFile(join(dir, result.log), 'utf8')).toContain('stderr receipt');
    expect(await readFile(join(dir, 'logs/fixture.stdout.log'), 'utf8')).toBe('stdout receipt\n');
    expect(await readFile(join(dir, 'logs/fixture.stderr.log'), 'utf8')).toBe('stderr receipt\n');
  });

  test('snapshot failure never certifies an empty census despite exit zero', async () => {
    const dir = await temporaryDirectory();
    const result = await runNativeCommand({
      label: 'unavailable',
      command: [process.execPath, '-e', 'setTimeout(() => {}, 50)'],
      root: dir,
      out: dir,
      env: { ...process.env },
      timeoutSeconds: 5,
      pollIntervalMs: 10,
      snapshot: unavailableSnapshot,
      stream: new CapturedOutput(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.settlement.empty).toBe(false);
    expect(result.settlement.snapshotErrors[0]).toContain('named fake census permission failure');
  });

  test('bounds a hung owned command without retrying', async () => {
    const dir = await temporaryDirectory();
    const result = await runNativeCommand({
      label: 'timeout',
      command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      root: dir,
      out: dir,
      env: { ...process.env },
      timeoutSeconds: 0.3,
      pollIntervalMs: 25,
      stream: new CapturedOutput(),
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.settlement.empty).toBe(true);
    expect(result.durationMs).toBeLessThan(5_000);
  });
});
