import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import {
  type NativeProcess,
  parseNativeProcesses,
  runNativeCommand,
  snapshotNativeProcesses,
  unattributedNativeCompilerHelpers,
  withoutUnownedCommandLines,
} from '../lib/native-bun-qualification-process';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class DiscardOutput extends Writable {
  override _write(_chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    done();
  }
}

class NewCompilerHelperCensus {
  private appeared = false;
  constructor(private readonly releasePath?: string) {}
  readonly helper = {
    pid: 10_000_003,
    parentPid: 10_000_004,
    group: null,
    identity: '10000003:2026-10-09T01:25:07.1062730Z',
    command:
      '"C:\\Program Files\\Microsoft Visual Studio\\18\\Enterprise\\VC\\Tools\\MSVC\\14.51.36231\\bin\\HostX64\\x64\\VCTIP.EXE"',
    name: 'VCTIP.EXE',
    executablePath:
      'C:\\Program Files\\Microsoft Visual Studio\\18\\Enterprise\\VC\\Tools\\MSVC\\14.51.36231\\bin\\HostX64\\x64\\VCTIP.EXE',
  };

  read = async (): Promise<NativeProcess[]> => {
    const rows = await snapshotNativeProcesses();
    const visible = rows.some(
      (row) => row.parentPid === process.pid && row.command.includes('nativeCompilerGuardChild')
    );
    if (visible && !this.appeared) {
      this.appeared = true;
      if (this.releasePath) await writeFile(this.releasePath, 'observed');
    }
    return this.appeared ? [...rows, this.helper] : rows;
  };
}

test('new unattributed compiler helper blocks a falsely empty command scope', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'native-compiler-guard-'));
  temporary.push(dir);
  const releasePath = join(dir, 'release');
  const census = new NewCompilerHelperCensus(releasePath);
  const result = await runNativeCommand({
    label: 'compiler-guard',
    command: [
      process.execPath,
      '-e',
      'const deadline = Date.now() + 15000; while (!(await Bun.file(process.argv[1]).exists())) { if (Date.now() > deadline) throw new Error("census did not observe child"); await Bun.sleep(10); } /* nativeCompilerGuardChild */',
      releasePath,
    ],
    root: dir,
    out: dir,
    env: { ...process.env },
    timeoutSeconds: 30,
    pollIntervalMs: 10,
    settleMs: 0,
    snapshot: census.read,
    guardCompilerHelpers: true,
    stream: new DiscardOutput(),
  });
  expect(result.exitCode).toBe(0);
  expect(result.settlement.rootObserved).toBe(true);
  expect(result.settlement.observed.some((row) => row.pid === census.helper.pid)).toBe(false);
  expect(result.settlement.empty).toBe(false);
  // The helper is reported by identity and image; its argv is not this command's to record.
  expect(result.settlement.unattributedCompilerHelpers).toEqual([
    { ...census.helper, command: '' },
  ]);
  expect(result.errors.join('\n')).toContain('Unattributed compiler helpers');
  const owned = new Set(result.settlement.observed.map((row) => row.identity));
  for (const name of [
    'processes-before-compiler-guard.json',
    'processes-latest-compiler-guard.json',
  ]) {
    const recorded: NativeProcess[] = await Bun.file(join(dir, name)).json();
    const exposed = recorded.filter((row) => row.command !== '' && !owned.has(row.identity));
    expect(
      exposed.length,
      `expected ${name} command lines: owned processes only | received ${exposed.length} from other processes, first PID ${exposed[0]?.pid}`
    ).toBe(0);
  }
}, 60_000);

test('a persisted census keeps the command line of owned processes only', () => {
  const helper = new NewCompilerHelperCensus().helper;
  const owned = {
    ...helper,
    pid: 7,
    identity: '7:2026-10-09T01:25:07.0000000Z',
    command: 'bun run test',
  };
  const other = {
    ...helper,
    pid: 8,
    identity: '8:2026-10-09T01:25:08.0000000Z',
    command: 'tool --token=secret',
  };
  const reusedPid = {
    ...owned,
    identity: '7:2026-10-09T02:00:00.0000000Z',
    command: 'other --key=secret',
  };

  expect(withoutUnownedCommandLines([owned, other, reusedPid], [owned])).toEqual([
    owned,
    { ...other, command: '' },
    { ...reusedPid, command: '' },
  ]);
  expect(withoutUnownedCommandLines([owned], [])).toEqual([{ ...owned, command: '' }]);
});

test('preexisting and owned helper identities grant no new termination authority', () => {
  const helper = new NewCompilerHelperCensus().helper;
  expect(unattributedNativeCompilerHelpers([helper], [helper], [])).toEqual([]);
  expect(unattributedNativeCompilerHelpers([], [helper], [helper])).toEqual([]);
  const reused = { ...helper, identity: '10000003:2026-10-09T01:28:08.5064100Z' };
  expect(unattributedNativeCompilerHelpers([helper], [reused], [])).toEqual([reused]);
});

test('helper detection uses native image metadata when command text is unavailable', () => {
  const helper = new NewCompilerHelperCensus().helper;
  const nameOnly = { ...helper, command: '', executablePath: null };
  const imageOnly = { ...helper, command: '', name: '' };
  const unrelated = { ...helper, command: '', name: 'NOTVCTIP.EXE', executablePath: null };
  expect(unattributedNativeCompilerHelpers([], [nameOnly], [])).toEqual([nameOnly]);
  expect(unattributedNativeCompilerHelpers([], [imageOnly], [])).toEqual([imageOnly]);
  expect(unattributedNativeCompilerHelpers([], [unrelated], [])).toEqual([]);
});

test('CIM snapshots retain validated image metadata without depending on command text', () => {
  expect(() => parseNativeProcesses('[]', 'win32')).toThrow('JSON array containing processes');
  const helper = new NewCompilerHelperCensus().helper;
  const input = {
    pid: helper.pid,
    parentPid: helper.parentPid,
    created: helper.identity.split(':').slice(1).join(':'),
    command: null,
    name: helper.name,
    executablePath: helper.executablePath,
  };
  expect(parseNativeProcesses(JSON.stringify([input]), 'win32')).toEqual([
    { ...helper, command: '' },
  ]);
  expect(() => parseNativeProcesses(JSON.stringify([{ ...input, name: 42 }]), 'win32')).toThrow(
    'optional string image metadata'
  );
  expect(() =>
    parseNativeProcesses(JSON.stringify([{ ...input, executablePath: 42 }]), 'win32')
  ).toThrow('optional string image metadata');
});
