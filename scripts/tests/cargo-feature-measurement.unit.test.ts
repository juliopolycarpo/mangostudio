import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertSourceUnchanged,
  assertSuccessfulSample,
  type CommandSample,
  type CommandSpec,
  cargoHackAsset,
  expectedPartition,
  type HostedEvidence,
  type MeasurementCase,
  type MeasurementIo,
  type MeasurementOptions,
  measureFeatureCase,
  measurementCommand,
  normalizeCommand,
  parseExecutionLog,
  parseMeasurementArgs,
  type Repository,
  runMeasuredCommand,
  SOURCES,
  type SourceSnapshot,
  settleCommandCleanup,
  validatePartitionUnion,
} from '../bench/cargo-feature-measurement';
import { readText } from './support/read-text';
import { expectedGateNeeds, extractJobBlock, parseNeedsList } from './support/workflow-blocks';

const SOURCE = '/immutable/source';
const OUTPUT = '/receipts';
const IDENTITY = {
  GITHUB_RUN_ID: '123',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_REF: 'refs/heads/measure/cargo-feature-partitions',
  GITHUB_WORKFLOW_REF:
    'juliopolycarpo/mangostudio/.github/workflows/protocol-ci.yml@refs/heads/measure/cargo-feature-partitions',
  GITHUB_REPOSITORY: 'juliopolycarpo/mangostudio',
  FEATURE_OS: 'ubuntu-latest',
};

function snapshot(repo: Repository): SourceSnapshot {
  const files = ['Cargo.lock', 'Cargo.toml', 'rust-toolchain.toml', SOURCES[repo].manifest];
  return {
    sha: SOURCES[repo].sha,
    status: '',
    hashes: Object.fromEntries(files.map((file) => [file, 'b'.repeat(64)])),
  };
}

function fullCommands(repo: Repository): string[] {
  return Array.from(
    { length: SOURCES[repo].commandCount },
    (_, index) =>
      `cargo clippy --all-targets --locked --no-default-features --features fixture-${index} -- -D warnings`
  );
}

function executionLog(
  repo: Repository,
  case_: MeasurementCase,
  commands = fullCommands(repo)
): string {
  const selected = new Set(expectedPartition(commands, case_));
  return commands
    .map(
      (command, index) =>
        `info: ${selected.has(command) ? 'running' : 'skipping'} \`${command}\` on ${SOURCES[repo].package} (${index + 1}/${commands.length})`
    )
    .join('\n');
}

function commandSample(spec: CommandSpec): CommandSample {
  return {
    ...spec,
    startedUtc: '2026-10-06T12:00:00.000Z',
    endedUtc: '2026-10-06T12:00:00.100Z',
    wallMs: 100,
    exitCode: 0,
    signal: null,
    timedOut: false,
    canceled: false,
    resourceUsage: null,
    stdout: '',
    stderr: '',
  };
}

class FakeMeasurementIo implements MeasurementIo {
  identity = { ...IDENTITY };
  files = new Map<string, string>();
  commands: CommandSpec[] = [];
  sampleOverride: Partial<CommandSample> = {};
  enumerationOverride: Partial<CommandSample> = {};
  setupExitCode = 0;
  versionOverride?: string;
  dirtyBefore = false;
  mutateAfter = false;
  targetContents: string[] = [];
  snapshots = 0;

  constructor(
    readonly repo: Repository,
    readonly case_: MeasurementCase
  ) {}

  metadata(): Record<string, unknown> {
    return { fake: true };
  }
  prepare(): {
    target: string;
    setupTarget: string;
    cargoHome: string;
    initialState: Record<string, unknown>;
  } {
    return {
      target: '/fresh/target',
      setupTarget: '/fresh/setup-target',
      cargoHome: '/fresh/cargo-home',
      initialState: { targetEntries: [], cargoHomeEntries: [] },
    };
  }
  targetEntries(_target: string): string[] {
    return this.targetContents;
  }
  snapshot(): Promise<SourceSnapshot> {
    const source = snapshot(this.repo);
    this.snapshots += 1;
    if (this.dirtyBefore && this.snapshots === 1) source.status = ' M Cargo.toml';
    if (this.mutateAfter && this.snapshots > 1) source.hashes['Cargo.lock'] = 'c'.repeat(64);
    return Promise.resolve(source);
  }
  run(spec: CommandSpec): Promise<CommandSample> {
    this.commands.push(spec);
    const sample = commandSample(spec);
    const versions = [
      'rustc 1.99.0 (fixture)',
      'cargo 1.99.0 (fixture)',
      'clippy 0.1.99 (fixture)',
      'cargo-hack 0.6.45',
      '1.4.2',
    ];
    if (spec.label.startsWith('version-'))
      sample.stdout = this.versionOverride ?? versions[Number(spec.label.slice(8))];
    if (spec.label === 'fetch') sample.exitCode = this.setupExitCode;
    if (spec.label === 'enumeration') {
      sample.stdout = `${fullCommands(this.repo)
        .map((command) =>
          command.replace(
            ' --no-default-features',
            ` --manifest-path ${SOURCES[this.repo].manifest} --no-default-features`
          )
        )
        .join('\n')}\n`;
      Object.assign(sample, this.enumerationOverride);
    }
    if (spec.label === 'sample') {
      sample.stderr = executionLog(this.repo, this.case_);
      sample.wallMs = this.case_ === 'full' ? 900 : this.case_ === 'p1' ? 600 : 700;
      Object.assign(sample, this.sampleOverride);
    }
    return Promise.resolve(sample);
  }
  write(name: string, content: string): Promise<void> {
    this.files.set(name, content);
    return Promise.resolve();
  }
}

class CargoFetchMetadataIo extends FakeMeasurementIo {
  readonly targetWrites = new Map<string, string[]>();

  override targetEntries(target: string): string[] {
    return this.targetWrites.get(target) ?? [];
  }

  override async run(spec: CommandSpec): Promise<CommandSample> {
    const sample = await super.run(spec);
    if (spec.label === 'fetch')
      this.targetWrites.set(spec.env.CARGO_TARGET_DIR, ['.rustc_info.json']);
    return sample;
  }
}

function options(repo: Repository, case_: MeasurementCase): MeasurementOptions {
  return { repo, case: case_, source: SOURCE, output: OUTPUT };
}

async function hostedEvidence(repo: Repository): Promise<HostedEvidence[]> {
  const evidence: HostedEvidence[] = [];
  for (const case_ of ['full', 'p1', 'p2'] as const) {
    const receipt = await measureFeatureCase(
      options(repo, case_),
      new FakeMeasurementIo(repo, case_)
    );
    evidence.push({ receipt, jobConclusion: 'success', uploadConclusion: 'success' });
  }
  return evidence;
}

describe('cargo feature commands and pinned inputs', () => {
  test('accepts the six cases and rejects malformed selectors or missing paths', () => {
    for (const repo of ['protocol', 'sdk']) {
      for (const case_ of ['full', 'p1', 'p2'])
        expect(parseMeasurementArgs([repo, case_, SOURCE, OUTPUT])).toMatchObject({
          repo,
          case: case_,
        });
    }
    for (const args of [
      ['other', 'full', SOURCE, OUTPUT],
      ['sdk', 'p3', SOURCE, OUTPUT],
      ['sdk', 'full', SOURCE],
      ['sdk', 'full', '', OUTPUT],
      ['sdk', 'full', SOURCE, OUTPUT, 'extra'],
    ]) {
      expect(() => parseMeasurementArgs(args)).toThrow(
        `Invalid measurement arguments ${JSON.stringify(args)}; expected`
      );
    }
  });

  test('retains exact feature coverage, targets, lock and deny-warnings flags', () => {
    expect(measurementCommand('protocol', 'full')).toEqual([
      'cargo',
      '+1.99.0',
      'hack',
      'clippy',
      '-p',
      'mango-protocol',
      '--feature-powerset',
      '--all-targets',
      '--locked',
      '--',
      '-D',
      'warnings',
    ]);
    expect(measurementCommand('sdk', 'p2')).toEqual([
      'cargo',
      '+1.99.0',
      'hack',
      'clippy',
      '--feature-powerset',
      '--depth',
      '2',
      '--all-targets',
      '--locked',
      '-p',
      'mango-external-agents',
      '--partition',
      '2/2',
      '--',
      '-D',
      'warnings',
    ]);
    expect(measurementCommand('protocol', 'p1')).toContain('1/2');
    for (const repo of ['protocol', 'sdk'] as const) {
      for (const case_ of ['full', 'p1', 'p2'] as const) {
        const argv = measurementCommand(repo, case_, true);
        expect(argv).toContain('--print-command-list');
        expect(argv).not.toContain('--partition');
      }
    }
  });

  test('uses ceil slices for odd SDK and even protocol counts, rejecting empty or duplicate lists', () => {
    expect(expectedPartition(fullCommands('protocol'), 'p1')).toHaveLength(18);
    expect(expectedPartition(fullCommands('protocol'), 'p2')).toHaveLength(18);
    expect(expectedPartition(fullCommands('sdk'), 'p1')).toHaveLength(8);
    expect(expectedPartition(fullCommands('sdk'), 'p2')).toHaveLength(7);
    expect(expectedPartition(['a', 'b', 'c'], 'full')).toEqual(['a', 'b', 'c']);
    expect(expectedPartition(['a'], 'p2')).toEqual([]);
    expect(() => expectedPartition([], 'full')).toThrow('expected a nonempty list');
    expect(() => expectedPartition(['a', 'a'], 'full')).toThrow('distinct commands');
  });

  test('normalizes only the selected manifest while preserving feature order', () => {
    const printed =
      'cargo clippy --all-targets --locked --manifest-path crates/mango-protocol/Cargo.toml --features schema,websocket -- -D warnings';
    const expected =
      'cargo clippy --all-targets --locked --features schema,websocket -- -D warnings';
    expect(normalizeCommand(printed, 'protocol', SOURCE)).toBe(expected);
    expect(
      normalizeCommand(
        printed.replace(
          'crates/mango-protocol/Cargo.toml',
          `${SOURCE}/crates/mango-protocol/Cargo.toml`
        ),
        'protocol',
        SOURCE
      )
    ).toBe(expected);
    const windows =
      'cargo clippy --manifest-path "D:\\a\\source\\crates\\mango-protocol\\Cargo.toml" --locked';
    expect(normalizeCommand(windows, 'protocol', 'D:\\a\\source')).toBe('cargo clippy --locked');
    expect(() =>
      normalizeCommand(
        printed.replace('crates/mango-protocol', '/different/crate'),
        'protocol',
        SOURCE
      )
    ).toThrow('Invalid manifest');
    expect(() => normalizeCommand('cargo test --locked', 'sdk', SOURCE)).toThrow(
      'expected one uncolored cargo clippy command'
    );
    expect(() => normalizeCommand(`${expected}\nother`, 'protocol', SOURCE)).toThrow(
      'Invalid cargo-hack command'
    );
  });

  test('identifies the pinned action archive independently of host Rust target', () => {
    expect(cargoHackAsset('linux', 'x64')).toMatchObject({
      url: 'https://github.com/taiki-e/cargo-hack/releases/download/v0.6.45/cargo-hack-x86_64-unknown-linux-musl.tar.gz',
      sha256: 'b242dffcfd43317ac484dd2dbc3b9fc5f8a7eb3ba252af31b531503f0bad33d1',
    });
    expect(cargoHackAsset('darwin', 'arm64').url).toEndWith(
      'cargo-hack-aarch64-apple-darwin.tar.gz'
    );
    expect(cargoHackAsset('win32', 'x64').url).toEndWith(
      'cargo-hack-x86_64-pc-windows-msvc.tar.gz'
    );
    expect(() => cargoHackAsset('freebsd', 'x64')).toThrow(
      'Invalid cargo-hack host freebsd-x64; expected'
    );
  });

  test('rejects changed revision, dirty source, missing hash and post-run lock mutation', () => {
    assertSourceUnchanged('protocol', snapshot('protocol'));
    const wrongHead = { ...snapshot('protocol'), sha: 'd'.repeat(40) };
    expect(() => assertSourceUnchanged('protocol', wrongHead)).toThrow(
      `expected clean HEAD ${SOURCES.protocol.sha}`
    );
    expect(() =>
      assertSourceUnchanged('sdk', { ...snapshot('sdk'), status: '?? untracked.rs' })
    ).toThrow('Invalid sdk source');
    const missing = snapshot('sdk');
    missing.hashes['Cargo.lock'] = '';
    expect(() => assertSourceUnchanged('sdk', missing)).toThrow(
      'Invalid hash for Cargo.lock: ""; expected SHA256'
    );
    const changed = snapshot('protocol');
    changed.hashes['Cargo.lock'] = 'e'.repeat(64);
    expect(() => assertSourceUnchanged('protocol', snapshot('protocol'), changed)).toThrow(
      'Source manifest/lock hashes changed'
    );
  });
});

describe('actual execution and failure receipts', () => {
  test('accepts the pinned GitHub Actions stdout group format', async () => {
    // cargo-hack 0.6.45 prints file_stem("cargo.exe") as cargo on Windows,
    // sends Actions groups to stdout, and omits manifest paths in those groups.
    const grouped = executionLog('sdk', 'p2')
      .replace(/^info: /gm, '::group::')
      .split('\n')
      .flatMap((line) => [line, '::endgroup::'])
      .join('\r\n');
    expect(parseExecutionLog(grouped, 'sdk', SOURCE).running).toHaveLength(7);
    const io = new FakeMeasurementIo('sdk', 'p2');
    io.sampleOverride = { stdout: grouped, stderr: '    Finished dev profile in 1s\n' };
    const windowsEnumeration = fullCommands('sdk')
      .map((command) =>
        command.replace(
          ' --no-default-features',
          ' --manifest-path crates\\mango-external-agents\\Cargo.toml --no-default-features'
        )
      )
      .join('\r\n');
    io.enumerationOverride.stdout = windowsEnumeration;
    const receipt = await measureFeatureCase(options('sdk', 'p2'), io);
    expect(receipt.status).toBe('complete');
    expect(receipt.actualCommands).toHaveLength(7);
    const evidence = await hostedEvidence('sdk');
    evidence[2].receipt = receipt;
    expect(validatePartitionUnion(evidence).partitionMaxWallMs).toBe(700);
  });

  test('parses actual running and skipping sequence and rejects partial, wrong-package or repeated progress', () => {
    const parsed = parseExecutionLog(executionLog('sdk', 'p2'), 'sdk', SOURCE);
    expect(parsed.running).toEqual(fullCommands('sdk').slice(8));
    expect(parsed.skipping).toEqual(fullCommands('sdk').slice(0, 8));
    const partial = executionLog('sdk', 'p2').split('\n').slice(0, 10).join('\n');
    expect(() => parseExecutionLog(partial, 'sdk', SOURCE)).toThrow(
      'Incomplete cargo-hack progress 10; expected 15'
    );
    expect(parseExecutionLog(partial, 'sdk', SOURCE, false).running).toHaveLength(2);
    expect(() =>
      parseExecutionLog(executionLog('sdk', 'p2').replace('(2/15)', '(1/15)'), 'sdk', SOURCE)
    ).toThrow('expected index 2 of 15');
    expect(() =>
      parseExecutionLog(
        executionLog('sdk', 'p2').replace('on mango-external-agents', 'on mango-protocol'),
        'sdk',
        SOURCE
      )
    ).toThrow('expected running/skipping for mango-external-agents');
    expect(() => parseExecutionLog('info: running malformed', 'sdk', SOURCE)).toThrow(
      'Invalid cargo-hack progress'
    );
  });

  test('separates setup and enumeration, uses fresh source cache, and persists all commands', async () => {
    const io = new FakeMeasurementIo('protocol', 'p1');
    const receipt = await measureFeatureCase(options('protocol', 'p1'), io);
    expect(receipt.status).toBe('complete');
    expect(receipt.setup.map((sample) => sample.label)).toEqual([
      'version-0',
      'version-1',
      'version-2',
      'version-3',
      'version-4',
      'fetch',
    ]);
    expect(receipt.enumeration?.argv).not.toContain('--partition');
    expect(receipt.enumeration?.argv).toContain('--print-command-list');
    expect(receipt.actualCommands).toHaveLength(18);
    expect(receipt.sample?.wallMs).toBe(600);
    expect(receipt.setup.at(-1)?.argv).toEqual(['cargo', '+1.99.0', 'fetch', '--locked']);
    expect(
      io.commands.every(
        (spec) =>
          spec.env.CARGO_HOME === '/fresh/cargo-home' &&
          spec.env.CARGO_TARGET_DIR ===
            (spec.label === 'sample' ? '/fresh/target' : '/fresh/setup-target') &&
          spec.env.CARGO_TERM_COLOR === 'never'
      )
    ).toBe(true);
    expect(JSON.parse(io.files.get('receipt.json') ?? '{}').status).toBe('complete');
    expect(io.files.get('full-command-list.txt')?.split('\n').filter(Boolean)).toHaveLength(36);
    expect(io.files.has('post-check.json')).toBe(true);
  });

  test('keeps cargo fetch metadata out of the fresh timed target', async () => {
    const io = new CargoFetchMetadataIo('sdk', 'p2');
    const receipt = await measureFeatureCase(options('sdk', 'p2'), io);
    expect(receipt.error).toBeUndefined();
    expect(receipt.status).toBe('complete');
    const fetchTarget = receipt.setup.at(-1)?.env.CARGO_TARGET_DIR;
    const timedTarget = receipt.sample?.env.CARGO_TARGET_DIR;
    expect(io.targetWrites.get(fetchTarget ?? '')).toEqual(['.rustc_info.json']);
    expect(fetchTarget).not.toBe(timedTarget);
    expect(io.targetEntries(timedTarget ?? '')).toEqual([]);
    expect(receipt.targetEmptyBeforeTiming).toBe(true);
  });

  test('reproduces the pinned print-list bug without treating its full p1 list as executed coverage', async () => {
    const fullPrintedByP1 = fullCommands('protocol');
    expect(fullPrintedByP1).toHaveLength(36);
    expect(expectedPartition(fullPrintedByP1, 'p1')).toHaveLength(18);
    const io = new FakeMeasurementIo('protocol', 'p1');
    io.sampleOverride.stderr = executionLog('protocol', 'full');
    const receipt = await measureFeatureCase(options('protocol', 'p1'), io);
    expect(receipt.status).toBe('failed');
    expect(receipt.error).toContain('Invalid p1 commands');
    expect(receipt.actualCommands).toHaveLength(36);
  });

  test.each([
    ['exit', { exitCode: 1 }],
    ['timeout', { timedOut: true, exitCode: 137 }],
    ['canceled', { canceled: true, signal: 'SIGTERM' }],
    ['spawn', { error: 'spawn failed', exitCode: null }],
    ['clock', { wallMs: -1 }],
  ] as const)('keeps raw evidence and rejects %s samples', async (_label, override) => {
    const io = new FakeMeasurementIo('sdk', 'p2');
    io.sampleOverride = override;
    const receipt = await measureFeatureCase(options('sdk', 'p2'), io);
    expect(receipt.status).toBe('failed');
    expect(receipt.error).toContain('Invalid sample sample');
    expect(io.files.get('sample.stderr.txt')).toBe(executionLog('sdk', 'p2'));
    expect(JSON.parse(io.files.get('receipt.json') ?? '{}').status).toBe('failed');
    expect(io.files.has('post-check.json')).toBe(true);
  });

  test('preserves partial command lists from a nonzero build', async () => {
    const io = new FakeMeasurementIo('sdk', 'p2');
    io.sampleOverride = {
      exitCode: 1,
      stderr: executionLog('sdk', 'p2').split('\n').slice(0, 10).join('\n'),
    };
    const receipt = await measureFeatureCase(options('sdk', 'p2'), io);
    expect(receipt.status).toBe('failed');
    expect(receipt.actualCommands).toHaveLength(2);
    expect(io.files.get('actual-command-list.txt')?.split('\n').filter(Boolean)).toHaveLength(2);
  });

  test('rejects reused targets, changed inputs and setup failure before accepting timings', async () => {
    const reused = new FakeMeasurementIo('sdk', 'full');
    reused.targetContents = ['debug'];
    expect((await measureFeatureCase(options('sdk', 'full'), reused)).error).toContain(
      'expected a fresh empty target'
    );
    expect(reused.commands.some((spec) => spec.label === 'sample')).toBe(false);
    const dirty = new FakeMeasurementIo('sdk', 'full');
    dirty.dirtyBefore = true;
    expect((await measureFeatureCase(options('sdk', 'full'), dirty)).error).toContain(
      'expected clean HEAD'
    );
    expect(dirty.commands).toHaveLength(0);
    const mutated = new FakeMeasurementIo('sdk', 'full');
    mutated.mutateAfter = true;
    expect((await measureFeatureCase(options('sdk', 'full'), mutated)).error).toContain(
      'Source manifest/lock hashes changed'
    );
    const setup = new FakeMeasurementIo('sdk', 'full');
    setup.setupExitCode = 1;
    expect((await measureFeatureCase(options('sdk', 'full'), setup)).error).toContain(
      'Invalid fetch sample'
    );
    expect(setup.commands.some((spec) => spec.label === 'enumeration')).toBe(false);
    const wrongTool = new FakeMeasurementIo('sdk', 'full');
    wrongTool.versionOverride = 'cargo-hack 0.6.46';
    expect((await measureFeatureCase(options('sdk', 'full'), wrongTool)).error).toContain(
      'expected Rust/Cargo 1.99.0'
    );
  });
});

describe('hosted union validation', () => {
  test('rejects altered measured argv and absent hosted identity', async () => {
    const altered = await hostedEvidence('sdk');
    const sample = altered[1].receipt.sample;
    if (sample) sample.argv = ['cargo', '+1.99.0', 'clippy', '--all-features'];
    expect(() => validatePartitionUnion(altered)).toThrow('Invalid measured command identity');
    const noIdentity = await hostedEvidence('sdk');
    for (const item of noIdentity) item.receipt.identity = {};
    expect(() => validatePartitionUnion(noIdentity)).toThrow('Invalid hosted trial identity');
  });

  test('rejects reused setup targets and mismatched source-download homes', async () => {
    const reused = await hostedEvidence('sdk');
    const { sample, enumeration } = reused[0].receipt;
    if (sample && enumeration) sample.env.CARGO_TARGET_DIR = enumeration.env.CARGO_TARGET_DIR;
    expect(() => validatePartitionUnion(reused)).toThrow('expected distinct timed/setup targets');
    const differentHome = await hostedEvidence('sdk');
    differentHome[1].receipt.setup[0].env.CARGO_HOME = '/reused/other-home';
    expect(() => validatePartitionUnion(differentHome)).toThrow('shared download-only Cargo home');
  });

  test.each(['protocol', 'sdk'] as const)(
    'validates exact %s union and reports work-only proxies',
    async (repo) => {
      expect(validatePartitionUnion(await hostedEvidence(repo))).toEqual({
        fullWallMs: 900,
        partitionMaxWallMs: 700,
        partitionTotalWallMs: 1300,
      });
    }
  );

  test('rejects omitted or duplicated cases, source changes, mixed attempts and failed uploads', async () => {
    const evidence = await hostedEvidence('sdk');
    expect(() => validatePartitionUnion(evidence.slice(0, 2))).toThrow(
      'expected full, p1 and p2 once each'
    );
    expect(() => validatePartitionUnion([evidence[0], evidence[1], evidence[1]])).toThrow(
      'expected full, p1, p2 exactly once'
    );
    const clone = (): HostedEvidence[] => structuredClone(evidence);
    const failedUpload = clone();
    failedUpload[1].uploadConclusion = 'failure';
    expect(() => validatePartitionUnion(failedUpload)).toThrow('successful job and upload');
    const canceled = clone();
    canceled[2].jobConclusion = 'cancelled';
    expect(() => validatePartitionUnion(canceled)).toThrow('successful job and upload');
    const mixed = clone();
    mixed[2].receipt.identity.GITHUB_RUN_ATTEMPT = '2';
    expect(() => validatePartitionUnion(mixed)).toThrow('Mismatched trial identity');
    const partial = clone();
    partial[2].receipt.status = 'incomplete';
    expect(() => validatePartitionUnion(partial)).toThrow('Incomplete p2 receipt');
    const mutated = clone();
    const after = mutated[1].receipt.after;
    if (after) after.hashes['Cargo.lock'] = 'c'.repeat(64);
    expect(() => validatePartitionUnion(mutated)).toThrow('Source manifest/lock hashes changed');
  });

  test('rejects missing or duplicated actual commands and different host enumerations', async () => {
    const missing = await hostedEvidence('protocol');
    missing[2].receipt.actualCommands.pop();
    expect(() => validatePartitionUnion(missing)).toThrow('Invalid raw executed commands');
    const duplicated = await hostedEvidence('protocol');
    duplicated[1].receipt.actualCommands.push(duplicated[1].receipt.actualCommands[0]);
    expect(() => validatePartitionUnion(duplicated)).toThrow('Invalid raw executed commands');
    const different = await hostedEvidence('sdk');
    different[1].receipt.fullCommands.reverse();
    expect(() => validatePartitionUnion(different)).toThrow('Invalid raw enumeration commands');
    const failed = await hostedEvidence('sdk');
    const sample = failed[2].receipt.sample;
    if (sample) sample.exitCode = 1;
    expect(() => validatePartitionUnion(failed)).toThrow('expected exit 0');
  });
});

describe('subprocess capture', () => {
  test('settles failed readers and bounds a named fake reader that never completes', async () => {
    function completedChild(): Promise<number> {
      return Promise.resolve(1);
    }
    function failedReader(): Promise<string> {
      return Promise.reject(new Error('controlled read failure'));
    }
    function stuckReader(): Promise<string> {
      return new Promise(() => undefined);
    }
    const settled = await settleCommandCleanup([completedChild(), failedReader()], 30);
    expect(settled.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    await expect(settleCommandCleanup([stuckReader()], 5)).rejects.toThrow(
      'Command cleanup exceeded 5 ms; expected process and output readers to settle'
    );
  });

  test('stops a real child after a controlled capture-write failure, then settles both streams', async () => {
    const output = mkdtempSync(join(tmpdir(), 'cargo-feature-capture-failure-'));
    try {
      mkdirSync(join(output, 'write-failure.output.jsonl'));
      const spec: CommandSpec = {
        label: 'write-failure',
        argv: [
          process.execPath,
          '-e',
          "process.stdout.write('force writer failure'); await Bun.sleep(100); await Bun.write('late-write', 'should not survive');",
        ],
        cwd: output,
        env: {},
        timeoutMs: 300,
      };
      const sample = await runMeasuredCommand(spec, output, new AbortController().signal);
      expect(sample.error).toContain('Failed stdout capture for write-failure');
      expect(sample.error).toContain('expected writable regular receipt files');
      expect(sample.exitCode).not.toBeNull();
      expect(sample.wallMs).toBeLessThan(1000);
      await Bun.sleep(120);
      expect(existsSync(join(output, 'late-write'))).toBe(false);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  test('cancels a running real child and rejects invalid timeout/argv shapes before spawning', async () => {
    const output = mkdtempSync(join(tmpdir(), 'cargo-feature-cancel-'));
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30);
      const spec: CommandSpec = {
        label: 'cancel',
        argv: [process.execPath, '-e', 'await Bun.sleep(10000);'],
        cwd: output,
        env: {},
        timeoutMs: 300,
      };
      const sample = await runMeasuredCommand(spec, output, controller.signal);
      clearTimeout(timer);
      expect(sample.canceled).toBe(true);
      expect(sample.exitCode).not.toBeNull();
      expect(sample.wallMs).toBeLessThan(1000);
      await expect(
        runMeasuredCommand({ ...spec, argv: [] }, output, controller.signal)
      ).rejects.toThrow('expected nonempty argv and a positive finite timeout');
      await expect(
        runMeasuredCommand({ ...spec, timeoutMs: -1 }, output, controller.signal)
      ).rejects.toThrow('expected nonempty argv and a positive finite timeout');
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  test('captures raw output and Bun accounting from a tiny actual child, using monotonic duration', async () => {
    const output = mkdtempSync(join(tmpdir(), 'cargo-feature-process-'));
    try {
      const spec: CommandSpec = {
        label: 'tiny',
        argv: [
          process.execPath,
          '-e',
          "process.stdout.write('hello'); process.stderr.write('failure text'); process.exitCode = 2;",
        ],
        cwd: output,
        env: {},
        timeoutMs: 300,
      };
      const sample = await runMeasuredCommand(spec, output, new AbortController().signal);
      expect(sample.stdout).toBe('hello');
      expect(sample.stderr).toBe('failure text');
      expect(sample.exitCode).toBe(2);
      expect(sample.wallMs).toBeGreaterThan(0);
      expect(sample.resourceUsage?.cpuTime.total).toBeGreaterThanOrEqual(0);
      expect(sample.resourceUsage?.maxRSS).toBeGreaterThan(0);
      expect(readFileSync(join(output, 'tiny.stdout.txt'), 'utf8')).toBe('hello');
      expect(readFileSync(join(output, 'tiny.output.jsonl'), 'utf8')).toContain(
        '"channel":"stderr"'
      );
      expect(() => assertSuccessfulSample(sample)).toThrow('expected exit 0');
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  test('bounds a real sleeping child and records cancellation before spawn', async () => {
    const output = mkdtempSync(join(tmpdir(), 'cargo-feature-timeout-'));
    try {
      const spec: CommandSpec = {
        label: 'timeout',
        argv: [process.execPath, '-e', 'await Bun.sleep(10000);'],
        cwd: output,
        env: {},
        timeoutMs: 30,
      };
      const timedOut = await runMeasuredCommand(spec, output, new AbortController().signal);
      expect(timedOut.timedOut).toBe(true);
      expect(timedOut.wallMs).toBeLessThan(1000);
      expect(() => assertSuccessfulSample(timedOut)).toThrow('no signal/timeout/cancellation');
      const controller = new AbortController();
      controller.abort();
      const canceled = await runMeasuredCommand(spec, output, controller.signal);
      expect(canceled.canceled).toBe(true);
      expect(canceled.exitCode).toBeNull();
      expect(canceled.error).toContain('canceled before spawn');
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});

describe('measurement workflow boundary', () => {
  test('preserves every original workflow byte, including trigger and Gate', () => {
    const workflow = readText('.github/workflows/protocol-ci.yml');
    const baseline = workflow.split('\n  feature-measurement:\n')[0];
    expect(createHash('sha256').update(baseline).digest('hex')).toBe(
      '79a00b606f12eaa82cc846402a4cdcb9c78c5a131eae888367569d1d3baa5127'
    );
    expect(parseNeedsList(extractJobBlock(workflow, 'gate')).sort()).toEqual(
      expectedGateNeeds(workflow)
    );
  });

  test('requires successful Gate/manual branch and bounds the eighteen uncached cases', () => {
    const job = extractJobBlock(
      readText('.github/workflows/protocol-ci.yml'),
      'feature-measurement'
    );
    expect(parseNeedsList(job)).toEqual(['gate']);
    expect(job).toContain(
      "if: github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/measure/cargo-feature-partitions'"
    );
    expect(job).toContain('max-parallel: 18');
    expect(job).toContain('fail-fast: false');
    expect(job).toContain('repo: [protocol, sdk]');
    expect(job).toContain('os: [ubuntu-latest, macos-latest, windows-latest]');
    expect(job).toContain('case: [full, p1, p2]');
    expect(job).not.toMatch(/(?:rust-cache|cache-scoped|actions\/cache)/);
    expect(job).toContain(SOURCES.protocol.sha);
    expect(job).toContain(SOURCES.sdk.sha);
    expect(job).toContain('if: always()');
    expect(job).toContain('if-no-files-found: error');
    expect(job).toContain('compression-level: 0');
    const expression = '$' + '{{';
    expect(job).toContain(`${expression} github.run_id }}-${expression} github.run_attempt }}`);
  });
});
