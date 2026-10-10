import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { Writable } from 'node:stream';

import {
  type NativeCommandOptions,
  parseNativeProcesses,
  scopeNativeProcesses,
} from '../lib/native-bun-qualification-process';
import {
  type NativeWindowsJobContext,
  type NativeWindowsJobIO,
  type NativeWindowsJobRequest,
  type NativeWindowsTool,
  type NativeWindowsWrapperResult,
  parseNativeWindowsJobReceipt,
  runNativeWindowsJob,
} from '../lib/native-bun-qualification-windows';

const HELPER = Buffer.from('# named native Job helper fake\n');
const HELPER_HASH = createHash('sha256').update(HELPER).digest('hex');
const TOOL: NativeWindowsTool = {
  path: 'C:\\VS\\VC\\Tools\\MSVC\\14.51.36231\\bin\\Hostx64\\x64\\vctip.exe',
  fileVersion: '14.51.36231.0',
  productVersion: '14.51.36231.0',
  sha256: 'c'.repeat(64),
};
const CONTEXT: NativeWindowsJobContext = {
  helperPath: 'D:\\tooling\\scripts\\lib\\native-windows-job.ps1',
  helperSha256: HELPER_HASH,
  sourceSha: 'a'.repeat(40),
  toolingSha: 'b'.repeat(40),
  privateDirectory: 'D:\\private-runner-temp',
  expectedVctip: [TOOL],
};
const START = '2026-10-08T12:00:00.0000000Z';
const EXIT = '2026-10-08T12:00:01.0000000Z';
const FINISH = '2026-10-08T12:00:02.0000000Z';
const WRAPPER: NativeWindowsWrapperResult = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  errors: [],
};
type Row = Record<string, unknown>;

class CapturedOutput extends Writable {
  readonly chunks: Buffer[] = [];
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (error?: Error | null) => void
  ): void {
    this.chunks.push(Buffer.from(chunk));
    done();
  }
}

function nativeMember(
  pid = 42,
  path = 'C:\\tools\\bun.exe',
  metadata: NativeWindowsTool | null = null
): Row {
  const created = '2026-10-08T11:59:59.1234567Z';
  return {
    Pid: pid,
    Created: created,
    Identity: `${pid}:${created}`,
    CensusIdentity: `${pid}:2026-10-08T11:59:59.1234560Z`,
    CreationFileTime: (
      (BigInt(Date.parse('2026-10-08T11:59:59Z')) + 11644473600000n) * 10000n +
      1234567n
    ).toString(),
    Path: path,
    IsMember: true,
    Alive: true,
    Tool: metadata
      ? {
          Path: metadata.path,
          FileVersion: metadata.fileVersion,
          ProductVersion: metadata.productVersion,
          Sha256: metadata.sha256,
        }
      : null,
  };
}

function nativeSnapshot(members: Row[] = []): Row {
  return {
    At: EXIT,
    Assigned: members.length,
    Returned: members.length,
    ActiveBefore: members.length,
    ActiveAfter: members.length,
    TotalProcesses: 2,
    Stable: true,
    Empty: members.length === 0,
    Races: 0,
    NativeBytes: 8 + members.length * 8,
    Members: members,
  };
}

function observerCensus(): Row[] {
  return [
    {
      pid: 7,
      parentPid: 1,
      created: START,
      identity: `7:${START}`,
      name: 'powershell.exe',
      path: 'C:\\Windows\\powershell.exe',
      // Outside the Job: the helper keeps its verdict and withholds its command line.
      command: null,
      compilerHelper: false,
    },
  ];
}

function cargoOutput(target: 'runtime' | 'fake'): Buffer {
  const primary = target === 'runtime' ? 'mangostudio-runtime' : 'fake_cursor_agent';
  const rows = [
    {
      reason: 'compiler-artifact',
      package_id: 'git+https://example.test#mango-external-agents@1',
      target: { name: 'sdk', kind: ['lib'] },
      features: target === 'runtime' ? ['stdio'] : ['stdio', 'testing'],
      filenames: ['C:\\target\\sdk.rlib'],
      executable: null,
    },
    {
      reason: 'compiler-artifact',
      package_id: 'path+mangostudio-runtime',
      target: { name: primary, kind: [target === 'runtime' ? 'bin' : 'example'] },
      features: [],
      filenames: [`C:\\target\\${primary}.exe`],
      executable: `C:\\target\\${primary}.exe`,
    },
    { reason: 'build-finished', success: true },
  ];
  return Buffer.from(`${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

class FakeJobEvidence {
  readonly value: Row;
  readonly stdout: Buffer;
  constructor(readonly request: NativeWindowsJobRequest) {
    const target = request.command.includes('--example') ? 'fake' : 'runtime';
    this.stdout =
      request.mode === 'msvc-compile' ? cargoOutput(target) : Buffer.from('native output\n');
    this.value = {
      schemaVersion: 1,
      status: 'naturally-settled',
      sourceSha: request.sourceSha,
      workflowSha: request.workflowSha,
      helperSha256: HELPER_HASH,
      command: request.command,
      application: request.application,
      root: request.root,
      mode: request.mode,
      timeoutSeconds: request.timeoutSeconds,
      observationMs: request.observationMs,
      os64Bit: true,
      process64Bit: true,
      startedAt: START,
      rootExitAt: EXIT,
      finishedAt: FINISH,
      exitCode: 0,
      timedOut: false,
      stdoutEof: true,
      stderrEof: true,
      errors: [],
      ambiguity: [],
      rootIdentity: nativeMember(42, request.application),
      job: {
        atomicJobList: true,
        suspended: true,
        inherited: false,
        limitFlags: 0x2000,
        creationFlags: 0x80404,
        breakaway: false,
        notificationsAuthority: false,
      },
      naturalSettlement: {
        empty: true,
        observedMs: request.observationMs,
        snapshot: nativeSnapshot(),
      },
      preCleanup: nativeSnapshot(),
      postCleanup: nativeSnapshot(),
      cleanupActions: [],
      before: observerCensus(),
      preCleanupCensus: observerCensus(),
      postCleanupCensus: observerCensus(),
      postCloseCensus: observerCensus(),
      censusMappings: [],
      observed: [nativeMember(42, request.application)],
      eligibility: {
        eligible: request.mode === 'msvc-compile',
        reasons: request.mode === 'msvc-compile' ? [] : ['strict command'],
        buildFinished: request.mode === 'msvc-compile',
        buildTarget: request.mode === 'msvc-compile' ? target : null,
        artifactCount: request.mode === 'msvc-compile' ? 2 : 0,
        sdkFeatures:
          request.mode === 'msvc-compile'
            ? [target === 'runtime' ? ['stdio'] : ['stdio', 'testing']]
            : [],
      },
      finalClose: {
        at: EXIT,
        preClose: nativeSnapshot(),
        queryError: null,
        census: observerCensus(),
        outcomeBeforeClose: 'naturally-settled',
        operation: 'CloseHandle(private kill-on-close job)',
        successfulSettlementEvidence: false,
      },
    };
  }
  set(path: string, value: unknown): void {
    const keys = path.split('.');
    let row = this.value;
    for (const key of keys.slice(0, -1)) row = row[key] as Row;
    row[keys.at(-1) as string] = value;
  }
  cleanup(metadata = TOOL): void {
    const owned = nativeMember(88, metadata.path, metadata);
    const census = {
      pid: owned.Pid,
      parentPid: 42,
      created: String(owned.CensusIdentity).slice(3),
      identity: owned.CensusIdentity,
      name: 'vctip.exe',
      path: metadata.path,
      command: 'vctip.exe',
      compilerHelper: true,
    };
    this.set('status', 'qualified-after-explicit-compiler-cleanup');
    this.set('naturalSettlement', {
      empty: false,
      observedMs: this.request.observationMs,
      snapshot: nativeSnapshot([owned]),
    });
    this.set('preCleanup', nativeSnapshot([owned]));
    this.set('preCleanupCensus', [...observerCensus(), census]);
    this.set('censusMappings', [
      {
        censusIdentity: owned.CensusIdentity,
        nativeIdentity: owned.Identity,
        nativeCreationFileTime: owned.CreationFileTime,
        exactJobMember: true,
        live: true,
        retainedMemberMatched: true,
        queryError: null,
      },
    ]);
    this.set('observed', [nativeMember(42, this.request.application), owned]);
    this.set('cleanupActions', [
      {
        at: EXIT,
        completedAt: FINISH,
        identity: owned.Identity,
        pid: owned.Pid,
        creationFileTime: owned.CreationFileTime,
        path: metadata.path,
        tool: owned.Tool,
        authority: 'retained process handle + creation identity + exact job membership',
        operation: 'TerminateProcess',
        reason: 'successful default compiler setup completed and both raw pipes reached EOF',
        requested: true,
        completed: true,
      },
    ]);
    this.set('finalClose.outcomeBeforeClose', 'qualified-after-explicit-compiler-cleanup');
  }
  parse(wrapper = WRAPPER, stdout: Uint8Array = this.stdout) {
    return parseNativeWindowsJobReceipt(
      JSON.stringify(this.value),
      this.request,
      HELPER_HASH,
      wrapper,
      stdout
    );
  }
}

function request(target?: 'runtime' | 'fake'): NativeWindowsJobRequest {
  const command = target
    ? [
        'cargo',
        'build',
        '-p',
        'mangostudio-runtime',
        target === 'runtime' ? '--bin' : '--example',
        target === 'runtime' ? 'mangostudio-runtime' : 'fake_cursor_agent',
        '--locked',
        '--message-format=json',
      ]
    : ['bun', 'run', 'test'];
  return {
    application: target ? 'C:\\tools\\cargo.exe' : 'C:\\tools\\bun.exe',
    command,
    root: 'D:\\source',
    out: 'D:\\evidence\\windows-jobs\\test',
    environment: {},
    mode: target ? 'msvc-compile' : 'strict',
    timeoutSeconds: 60,
    observationMs: 5000,
    sourceSha: CONTEXT.sourceSha,
    workflowSha: CONTEXT.toolingSha,
    ...(target ? { expectedVctip: [TOOL] } : {}),
  };
}

class FakeWindowsJobIO implements NativeWindowsJobIO {
  platform: NodeJS.Platform = 'win32';
  readonly files = new Map<string, Buffer>([[CONTEXT.helperPath, HELPER]]);
  readonly requests = new Map<string, string>();
  readonly removed: string[] = [];
  readonly invocations: readonly string[][] = [];
  readonly directories = new Set<string>();
  lastRequest: NativeWindowsJobRequest | null = null;
  wrapper = WRAPPER;
  failure: string | null = null;
  omitReceipt = false;
  chunks: { source: 'stdout' | 'stderr'; bytes: Buffer }[] = [];
  resolve = (command: string): string | null =>
    command === 'powershell.exe'
      ? 'C:\\Windows\\powershell.exe'
      : command === 'cargo' || win32.basename(command) === 'cargo.exe'
        ? 'C:\\tools\\cargo.exe'
        : 'C:\\tools\\bun.exe';
  read = async (path: string): Promise<Buffer> => {
    await Promise.resolve();
    const bytes = this.files.get(path);
    if (!bytes) throw new Error(`Named fake missing file ${path}`);
    return bytes;
  };
  write = async (path: string, bytes: string | Uint8Array): Promise<void> => {
    await Promise.resolve();
    this.files.set(path, Buffer.from(bytes));
  };
  append = async (path: string, value: string): Promise<void> => {
    await Promise.resolve();
    this.files.set(
      path,
      Buffer.concat([this.files.get(path) ?? Buffer.alloc(0), Buffer.from(value)])
    );
  };
  prepare = async (path: string, fresh = false): Promise<void> => {
    await Promise.resolve();
    if (fresh && this.directories.has(path))
      throw new Error(`Named fake existing evidence ${path}`);
    this.directories.add(path);
  };
  privateRequest = async (directory: string, value: string): Promise<string> => {
    await Promise.resolve();
    const path = win32.join(directory, 'native-job-private', 'request.json');
    this.requests.set(path, value);
    return path;
  };
  removeRequest = async (path: string): Promise<void> => {
    await Promise.resolve();
    this.requests.delete(path);
    this.removed.push(path);
  };
  execute = async (
    command: readonly string[],
    expected: NativeWindowsJobRequest,
    output: (source: 'stdout' | 'stderr', bytes: Buffer) => Promise<void>
  ): Promise<NativeWindowsWrapperResult> => {
    (this.invocations as string[][]).push([...command]);
    this.lastRequest = JSON.parse(this.requests.get(command.at(-1) as string) as string);
    if (this.failure) throw new Error(this.failure);
    const evidence = new FakeJobEvidence(expected);
    const stdout = this.chunks.length
      ? Buffer.concat(
          this.chunks.filter((chunk) => chunk.source === 'stdout').map((chunk) => chunk.bytes)
        )
      : evidence.stdout;
    const stderr = Buffer.concat(
      this.chunks.filter((chunk) => chunk.source === 'stderr').map((chunk) => chunk.bytes)
    );
    this.files.set(win32.join(expected.out, 'logs', 'stdout.log'), stdout);
    this.files.set(win32.join(expected.out, 'logs', 'stderr.log'), stderr);
    if (!this.omitReceipt)
      this.files.set(
        win32.join(expected.out, 'job-receipt.json'),
        Buffer.from(JSON.stringify(evidence.value))
      );
    for (const chunk of this.chunks.length
      ? this.chunks
      : [{ source: 'stdout' as const, bytes: stdout }])
      await output(chunk.source, chunk.bytes);
    return this.wrapper;
  };
}

function options(command: readonly string[] = ['bun', 'run', 'test']): NativeCommandOptions {
  return {
    label: 'test',
    command,
    root: 'D:\\source',
    out: 'D:\\evidence',
    env: { Path: 'C:\\tools', PRIVATE_TOKEN: 'never upload this', OMITTED: undefined, CI: 'true' },
    timeoutSeconds: 60,
    stream: new CapturedOutput(),
  };
}

describe('parseNativeWindowsJobReceipt', () => {
  test('converts naturally settled native membership without using close as evidence', () => {
    const result = new FakeJobEvidence(request()).parse();
    expect(result.settlement).toMatchObject({
      scope: 'atomic Windows Job membership',
      rootObserved: true,
      empty: true,
      survivors: [],
      snapshotErrors: [],
    });
    expect(result.settlement.observed[0].identity).toContain('.1234560Z');
    expect(result.durationMs).toBe(2000);
  });
  test('matches observational CIM identities in the caller census backstop', () => {
    const evidence = new FakeJobEvidence(request());
    const result = evidence.parse();
    const cim = parseNativeProcesses(
      JSON.stringify([
        {
          pid: 42,
          parentPid: 7,
          created: '2026-10-08T11:59:59.1234560Z',
          command: 'bun.exe',
          name: 'bun.exe',
          executablePath: 'C:\\tools\\bun.exe',
        },
      ]),
      'win32'
    );
    const scoped = scopeNativeProcesses(cim, {
      rootPid: 7,
      rootAlive: true,
      rootIdentity: `7:${START}`,
      observed: result.settlement.observed,
    });
    expect(scoped.current).toHaveLength(1);
    expect(scoped.current[0].identity).toBe('42:2026-10-08T11:59:59.1234560Z');
    expect((evidence.value.rootIdentity as Row).Identity).toBe('42:2026-10-08T11:59:59.1234567Z');
    const reused = cim.map((row) => ({ ...row, identity: '42:2026-10-08T11:59:59.1234570Z' }));
    expect(
      scopeNativeProcesses(reused, {
        rootPid: 7,
        rootAlive: true,
        rootIdentity: `7:${START}`,
        observed: result.settlement.observed,
      }).current
    ).toHaveLength(0);
  });
  for (const target of ['runtime', 'fake'] as const)
    test(`admits only the complete separate ${target} compiler proof and retained VCTIP cleanup`, () => {
      const evidence = new FakeJobEvidence(request(target));
      evidence.cleanup();
      expect(evidence.parse().exitCode).toBe(0);
    });
  test('accepts independently attested multiple installed VCTIP paths without pinning one version', () => {
    const other = {
      ...TOOL,
      path: TOOL.path.replace('14.51.36231', '14.50.00000'),
      sha256: 'd'.repeat(64),
    };
    const expected = { ...request('fake'), expectedVctip: [TOOL, other] };
    const evidence = new FakeJobEvidence(expected);
    evidence.cleanup(other);
    expect(evidence.parse().settlement.empty).toBe(true);
  });
  const invalid: [string, string, unknown][] = [
    ['missing final boundary', 'finalClose', null],
    ['surviving final open-job member', 'finalClose.preClose', nativeSnapshot([nativeMember()])],
    ['truncated final native PID buffer', 'finalClose.preClose.NativeBytes', 7],
    ['inconsistent final active count', 'finalClose.preClose.ActiveAfter', 1],
    ['unstable final snapshot', 'finalClose.preClose.Stable', false],
    ['close incorrectly claimed as settlement', 'finalClose.successfulSettlementEvidence', true],
    ['earlier final failure hidden by close', 'finalClose.outcomeBeforeClose', 'failed'],
    ['query failure hidden by status', 'finalClose.queryError', 'permission failure'],
    [
      'final boundary recorded after receipt completion',
      'finalClose.at',
      '2026-10-08T12:00:03.0000000Z',
    ],
    ['failed receipt', 'status', 'failed'],
    ['still running receipt', 'finishedAt', null],
    ['incorrect source seal', 'sourceSha', 'd'.repeat(40)],
    ['incorrect tooling seal', 'workflowSha', 'd'.repeat(40)],
    ['incorrect helper seal', 'helperSha256', 'd'.repeat(64)],
    ['altered argv', 'command', ['bun', 'run', 'test', '--changed']],
    ['altered cwd', 'root', 'D:\\other'],
    ['incorrect native host', 'process64Bit', false],
    ['timeout', 'timedOut', true],
    ['root failure', 'exitCode', 2],
    ['inherited stdout pipe', 'stdoutEof', false],
    ['inherited stderr pipe', 'stderrEof', false],
    ['helper error', 'errors', ['capture error']],
    ['outside-job ambiguity', 'ambiguity', [{ identity: 'unknown' }]],
    ['full creation time truncated', 'rootIdentity.CreationFileTime', '1'],
    [
      'CIM identity adopted as termination identity',
      'rootIdentity.Identity',
      '42:2026-10-08T11:59:59.1234560Z',
    ],
    ['not an exact job member', 'rootIdentity.IsMember', false],
    ['inheritable job handle', 'job.inherited', true],
    ['breakaway allowed', 'job.breakaway', true],
    ['missing baseline full census', 'before', []],
    ['missing final full census', 'finalClose.census', []],
    ['missing post-close full census', 'postCloseCensus', []],
    ['partial eligibility evidence', 'eligibility', { eligible: false }],
    ['shortened natural observation', 'naturalSettlement.observedMs', 4999],
  ];
  for (const [name, path, value] of invalid)
    test(`rejects ${name}`, () => {
      const evidence = new FakeJobEvidence(request());
      evidence.set(path, value);
      expect(() => evidence.parse()).toThrow('expected');
    });
  test('rejects a newly born helper even after the final close removed it from the Job', () => {
    const evidence = new FakeJobEvidence(request());
    evidence.set('postCloseCensus', [
      ...observerCensus(),
      {
        ...observerCensus()[0],
        pid: 99,
        identity: `99:${START}`,
        name: 'vctip.exe',
        path: TOOL.path,
      },
    ]);
    expect(() => evidence.parse()).toThrow('no new unattributed compiler helper');
  });
  for (const key of ['before', 'preCleanupCensus', 'postCloseCensus', 'finalClose.census'])
    test(`rejects a ${key} that records the command line of a process outside the Job`, () => {
      const evidence = new FakeJobEvidence(request());
      evidence.set(key, [{ ...observerCensus()[0], command: 'tool.exe --token=hunter2' }]);
      let refusal = '';
      try {
        evidence.parse();
      } catch (error) {
        refusal = String(error);
      }
      expect(
        refusal,
        `expected refusal: command lines recorded only for observed exact-job members | received: ${refusal || 'an accepted receipt'}`
      ).toContain('command lines recorded only for observed exact-job members');
      // The refusal names the process, never the argv it refused to keep.
      expect(refusal).toContain(`7:${START}`);
      expect(refusal).not.toContain('hunter2');
    });
  test('keeps the command line of an observed Job member in a census', () => {
    const evidence = new FakeJobEvidence(request('runtime'));
    evidence.cleanup();
    const census = evidence.value.preCleanupCensus as Row[];
    expect(census.at(-1)?.command).toBe('vctip.exe');
    expect(evidence.parse().settlement.empty).toBe(true);
  });
  test('rejects a census row without a compiler-helper verdict', () => {
    const evidence = new FakeJobEvidence(request());
    const { compilerHelper: _verdict, ...row } = observerCensus()[0];
    evidence.set('before', [row]);
    expect(() => evidence.parse()).toThrow('a recorded compiler-helper verdict');
  });
  test('reads a withheld command line through the recorded helper verdict', () => {
    const evidence = new FakeJobEvidence(request());
    evidence.set('postCloseCensus', [
      ...observerCensus(),
      // Neither name nor path says compiler; only the argv did, and it is withheld.
      { ...observerCensus()[0], pid: 99, identity: `99:${START}`, compilerHelper: true },
    ]);
    expect(() => evidence.parse()).toThrow('no new unattributed compiler helper');
  });
  for (const wrapper of [
    { ...WRAPPER, exitCode: 1 },
    { ...WRAPPER, signal: 'SIGKILL' },
    { ...WRAPPER, timedOut: true },
    { ...WRAPPER, errors: ['wrapper failure'] },
  ])
    test(`rejects wrapper failure ${JSON.stringify(wrapper)}`, () => {
      expect(() => new FakeJobEvidence(request()).parse(wrapper)).toThrow(
        'successful complete PowerShell wrapper exit'
      );
    });
  test('rejects missing and syntactically partial receipt JSON', () => {
    for (const json of ['', '{"schemaVersion":1'])
      expect(() =>
        parseNativeWindowsJobReceipt(json, request(), HELPER_HASH, WRAPPER, Buffer.alloc(0))
      ).toThrow('expected complete JSON');
  });
  for (const target of ['runtime', 'fake'] as const)
    test(`rejects altered SDK/primary features and incomplete Cargo JSON for ${target}`, () => {
      const evidence = new FakeJobEvidence(request(target));
      for (const bytes of [
        Buffer.from(evidence.stdout.toString().replace('"features":[]', '"features":["testing"]')),
        Buffer.from(
          evidence.stdout.toString().replace('"features":["stdio"', '"features":["extra","stdio"')
        ),
        Buffer.from(evidence.stdout.toString().replace('"success":true', '"success":false')),
        Buffer.from(evidence.stdout.toString().split('\n').slice(0, -2).join('\n')),
        Buffer.concat([evidence.stdout, Buffer.from([0xff])]),
      ])
        expect(() => evidence.parse(WRAPPER, bytes)).toThrow();
    });
  for (const [path, value] of [
    ['cleanupActions.0.completed', false],
    ['cleanupActions.0.authority', 'PID lookup'],
    ['cleanupActions.0.creationFileTime', '1'],
    ['cleanupActions.0.tool.Sha256', 'd'.repeat(64)],
    ['censusMappings.0.retainedMemberMatched', false],
    ['censusMappings', []],
    ['eligibility.buildTarget', 'fake'],
  ] as const)
    test(`rejects incomplete compiler cleanup ${path}`, () => {
      const evidence = new FakeJobEvidence(request('runtime'));
      evidence.cleanup();
      evidence.set(path, value);
      expect(() => evidence.parse()).toThrow('expected');
    });
});

describe('runNativeWindowsJob', () => {
  test('preserves legal prototype-named environment variables', async () => {
    const io = new FakeWindowsJobIO();
    const env = Object.fromEntries([
      ['Path', 'C:\\tools'],
      ['__proto__', 'prototype-named value'],
      ['constructor', 'constructor-named value'],
    ]);
    await runNativeWindowsJob({ ...options(), env }, CONTEXT, io);
    expect(Object.hasOwn(io.lastRequest?.environment ?? {}, '__proto__')).toBe(true);
    expect(io.lastRequest?.environment.__proto__).toBe('prototype-named value');
    expect(
      Object.entries(io.lastRequest?.environment ?? {}).find(([key]) => key === 'constructor')?.[1]
    ).toBe('constructor-named value');
  });
  test('passes exact argv, cwd, inherited environment and sealed context through a private request', async () => {
    const io = new FakeWindowsJobIO();
    const original = options(['bun', '-e', 'console.log("a b")', '', 'quote"\\']);
    const result = await runNativeWindowsJob(original, CONTEXT, io);
    expect(io.lastRequest).toMatchObject({
      command: original.command,
      root: original.root,
      application: 'C:\\tools\\bun.exe',
      sourceSha: CONTEXT.sourceSha,
      workflowSha: CONTEXT.toolingSha,
      mode: 'strict',
      environment: { Path: 'C:\\tools', PRIVATE_TOKEN: 'never upload this', CI: 'true' },
    });
    expect(io.lastRequest?.environment).not.toHaveProperty('OMITTED');
    expect(result.environment).not.toHaveProperty('PRIVATE_TOKEN');
    expect(JSON.stringify([...io.files.values()].map((bytes) => bytes.toString()))).not.toContain(
      'never upload this'
    );
    expect(io.invocations[0]).toEqual([
      'C:\\Windows\\powershell.exe',
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      CONTEXT.helperPath,
      '-RequestPath',
      'D:\\private-runner-temp\\native-job-private\\request.json',
    ]);
    expect(io.requests.size).toBe(0);
    expect(io.removed).toHaveLength(1);
    expect(original.env.OMITTED).toBeUndefined();
  });
  test('preserves raw bytes and complete stdout/stderr lines across arbitrary chunk interleaving', async () => {
    const io = new FakeWindowsJobIO();
    io.chunks = [
      { source: 'stdout', bytes: Buffer.from('out ') },
      { source: 'stderr', bytes: Buffer.from('warning\n') },
      { source: 'stdout', bytes: Buffer.from([0xc3]) },
      { source: 'stdout', bytes: Buffer.from([0xa9, 0x0a, 0xff]) },
    ];
    const selected = options();
    await runNativeWindowsJob(selected, CONTEXT, io);
    expect(io.files.get('D:\\evidence\\logs\\test.log')?.toString()).toBe('warning\nout é\n�\n');
    expect(io.files.get('D:\\evidence\\logs\\test.stdout.log')).toEqual(
      Buffer.concat(
        io.chunks.filter((chunk) => chunk.source === 'stdout').map((chunk) => chunk.bytes)
      )
    );
    expect(io.files.get('D:\\evidence\\logs\\test.stdout.log')).toEqual(
      io.files.get('D:\\evidence\\windows-jobs\\test\\logs\\stdout.log')
    );
    expect(Buffer.concat((selected.stream as CapturedOutput).chunks)).toEqual(
      Buffer.concat(io.chunks.map((chunk) => chunk.bytes))
    );
  });
  for (const target of ['runtime', 'fake'] as const)
    test(`classifies exact ${target} Cargo setup separately`, async () => {
      const io = new FakeWindowsJobIO();
      await runNativeWindowsJob(options(request(target).command), CONTEXT, io);
      expect(io.lastRequest?.mode).toBe('msvc-compile');
      expect(io.lastRequest?.expectedVctip).toEqual([TOOL]);
    });
  for (const changed of [
    request('runtime').command.concat('--features=testing'),
    request('runtime').command.slice(0, -1),
    ['cargo', 'test', '--locked'],
    [
      'cargo',
      'build',
      '-p',
      'mangostudio-runtime',
      '--bin',
      'mangostudio-runtime',
      '--example',
      'fake_cursor_agent',
      '--locked',
      '--message-format=json',
    ],
  ])
    test(`keeps changed/combined Cargo command strict ${JSON.stringify(changed)}`, async () => {
      const io = new FakeWindowsJobIO();
      await runNativeWindowsJob(options(changed), CONTEXT, io);
      expect(io.lastRequest?.mode).toBe('strict');
      expect(io.lastRequest).not.toHaveProperty('expectedVctip');
    });
  for (const failure of ['execution', 'missing-receipt', 'wrapper'])
    test(`removes full private environment after ${failure} failure`, async () => {
      const io = new FakeWindowsJobIO();
      if (failure === 'execution') io.failure = 'named wrapper spawn failure';
      if (failure === 'missing-receipt') io.omitReceipt = true;
      if (failure === 'wrapper') io.wrapper = { ...WRAPPER, exitCode: 1 };
      await expect(runNativeWindowsJob(options(), CONTEXT, io)).rejects.toThrow();
      expect(io.requests.size).toBe(0);
      expect(io.removed).toHaveLength(1);
    });
  test('rejects helper bytes outside the tooling seal before creating a private request', async () => {
    const io = new FakeWindowsJobIO();
    io.files.set(CONTEXT.helperPath, Buffer.from('# changed helper'));
    await expect(runNativeWindowsJob(options(), CONTEXT, io)).rejects.toThrow(
      'sealed helper SHA256'
    );
    expect(io.invocations).toHaveLength(0);
    expect(io.requests.size).toBe(0);
  });
  test('fails closed and removes private environment when own-wrapper containment cannot prove close', async () => {
    const io = new FakeWindowsJobIO();
    io.wrapper = {
      exitCode: null,
      signal: null,
      timedOut: true,
      errors: [
        'PowerShell wrapper did not close after bounded own-process termination; expected close within5000ms',
      ],
    };
    await expect(runNativeWindowsJob(options(), CONTEXT, io)).rejects.toThrow(
      'successful complete PowerShell wrapper exit'
    );
    expect(io.requests.size).toBe(0);
    expect(io.removed).toHaveLength(1);
  });
  test('rejects case-insensitive duplicate and NUL environment keys/values without exposing values', async () => {
    for (const env of [
      { Path: 'one', PATH: undefined },
      { 'bad\0key': 'one' },
      { TOKEN: 'secret\0value' },
    ]) {
      const io = new FakeWindowsJobIO();
      await expect(runNativeWindowsJob({ ...options(), env }, CONTEXT, io)).rejects.toThrow(
        'expected'
      );
      expect(io.invocations).toHaveLength(0);
    }
  });
  test('rejects private requests/evidence inside source and private requests inside uploaded evidence', async () => {
    for (const context of [
      { ...CONTEXT, privateDirectory: 'D:\\source\\private' },
      { ...CONTEXT, privateDirectory: 'D:\\evidence\\private' },
      { ...CONTEXT, helperPath: 'D:\\source\\helper.ps1' },
    ])
      await expect(runNativeWindowsJob(options(), context, new FakeWindowsJobIO())).rejects.toThrow(
        'outside source'
      );
    await expect(
      runNativeWindowsJob(
        { ...options(), out: 'D:\\source\\evidence' },
        CONTEXT,
        new FakeWindowsJobIO()
      )
    ).rejects.toThrow('outside source');
  });
  test('requires native Windows and fresh per-command evidence without changing deadlines', async () => {
    const io = new FakeWindowsJobIO();
    io.platform = 'linux';
    await expect(runNativeWindowsJob(options(), CONTEXT, io)).rejects.toThrow(
      'native Windows execution'
    );
    io.platform = 'win32';
    await runNativeWindowsJob(options(), CONTEXT, io);
    await expect(runNativeWindowsJob(options(), CONTEXT, io)).rejects.toThrow('existing evidence');
    expect(io.lastRequest?.timeoutSeconds).toBe(60);
    expect(io.lastRequest?.observationMs).toBe(5000);
  });
});
