#!/usr/bin/env bun

// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: This dependency-free workflow measurement runs directly, outside Turbo and its cache.

/**
 * Measures one immutable cargo-hack feature case without a target or registry cache.
 * Setup, full enumeration, and clippy have separate receipts. A comparison also
 * requires external job and upload conclusions, since a local receipt cannot
 * establish that its artifact reached GitHub.
 *
 * Usage:
 *   bun scripts/bench/cargo-feature-measurement.ts measure protocol p1 SOURCE OUTPUT
 *   bun scripts/bench/cargo-feature-measurement.ts compare evidence.json
 *
 * With no positional measure arguments, use FEATURE_REPO, FEATURE_CASE,
 * FEATURE_SOURCE and FEATURE_OUTPUT. No dependency install is required.
 */

import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { cpus, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export type Repository = 'protocol' | 'sdk';
export type MeasurementCase = 'full' | 'p1' | 'p2';

/** Immutable inputs, independent of the workflow branch's revision. */
export const SOURCES = {
  protocol: {
    repository: 'juliopolycarpo/mangostudio',
    sha: '9a3d8ee5e5d329760accc840a5dcdf334083d3c4',
    package: 'mango-protocol',
    manifest: 'crates/mango-protocol/Cargo.toml',
    commandCount: 36,
  },
  sdk: {
    repository: 'juliopolycarpo/mango-external-agents',
    sha: '24393ab644b93a3ffb194ffadb07429ca11278a0',
    package: 'mango-external-agents',
    manifest: 'crates/mango-external-agents/Cargo.toml',
    commandCount: 15,
  },
} as const;

const TOOLCHAIN = '+1.99.0';
const INSTALL_ACTION = '4cef1412cce204788f482e778a0b9187f9626a29';
const SETUP_COMMANDS = [
  ['rustc', TOOLCHAIN, '-vV'],
  ['cargo', TOOLCHAIN, '--version'],
  ['cargo', TOOLCHAIN, 'clippy', '--version'],
  ['cargo', TOOLCHAIN, 'hack', '--version'],
  ['bun', '--version'],
  ['cargo', TOOLCHAIN, 'fetch', '--locked'],
];
// Archive hashes from this pinned action's manifests/cargo-hack.json, version 0.6.45.
// Linux uses its musl asset, including on GNU hosts, as the action does.
const HACK_ASSETS = {
  'linux-x64': [
    'x86_64-unknown-linux-musl',
    'b242dffcfd43317ac484dd2dbc3b9fc5f8a7eb3ba252af31b531503f0bad33d1',
  ],
  'linux-arm64': [
    'aarch64-unknown-linux-musl',
    '9ac71756f1da6e8798ac5afbfd222abecb95de9c10e672ed52c179b637d6444b',
  ],
  'darwin-x64': [
    'x86_64-apple-darwin',
    'b1a65c2daaca37957a288a295cb25f5c3bf3f7945ec60b450ecdbb1159acbff4',
  ],
  'darwin-arm64': [
    'aarch64-apple-darwin',
    'af0ab90e56aa716ae9f545a93e4338d4f36525e187d367b6519da71b60249b50',
  ],
  'win32-x64': [
    'x86_64-pc-windows-msvc',
    '9f796e7720686866f30bb51522efb2a2f875cb76cac41da61e3446b41f5fec9a',
  ],
  'win32-arm64': [
    'aarch64-pc-windows-msvc',
    '532dd7ff12be5d6b63db5ba0ce39ba30f9233eba759685f7608cc442e59d71e5',
  ],
} as const;

export interface MeasurementOptions {
  repo: Repository;
  case: MeasurementCase;
  source: string;
  output: string;
}

/** Validate selectors before any source or build work. @example parseMeasurementArgs(['sdk', 'p2', 'source', 'out']); */
export function parseMeasurementArgs(args: readonly string[]): MeasurementOptions {
  const [repo, case_, source, output] = args;
  if (
    args.length !== 4 ||
    (repo !== 'protocol' && repo !== 'sdk') ||
    !['full', 'p1', 'p2'].includes(case_ ?? '') ||
    !source ||
    !output
  ) {
    throw new Error(
      `Invalid measurement arguments ${JSON.stringify(args)}; expected <protocol|sdk> <full|p1|p2> <source-directory> <output-directory>`
    );
  }
  return { repo, case: case_ as MeasurementCase, source: resolve(source), output: resolve(output) };
}

/** Preserve the production feature selection and warnings policy. @example measurementCommand('sdk', 'p1'); */
export function measurementCommand(
  repo: Repository,
  case_: MeasurementCase,
  enumerate = false
): string[] {
  const flags =
    repo === 'protocol'
      ? ['-p', SOURCES.protocol.package, '--feature-powerset', '--all-targets', '--locked']
      : [
          '--feature-powerset',
          '--depth',
          '2',
          '--all-targets',
          '--locked',
          '-p',
          SOURCES.sdk.package,
        ];
  // cargo-hack 0.6.45 does not advance print-list progress. Always enumerate full.
  if (!enumerate && case_ !== 'full') flags.push('--partition', case_ === 'p1' ? '1/2' : '2/2');
  if (enumerate) flags.push('--print-command-list');
  return ['cargo', TOOLCHAIN, 'hack', 'clippy', ...flags, '--', '-D', 'warnings'];
}

/** Derive contiguous slices using cargo-hack's ceil arithmetic. @example expectedPartition(['a', 'b', 'c'], 'p2'); // ['c'] */
export function expectedPartition(full: readonly string[], case_: MeasurementCase): string[] {
  if (full.length === 0 || new Set(full).size !== full.length) {
    throw new Error(
      `Invalid full command list ${JSON.stringify(full)}; expected a nonempty list of distinct commands`
    );
  }
  const split = Math.ceil(full.length / 2);
  if (case_ === 'p1') return full.slice(0, split);
  if (case_ === 'p2') return full.slice(split);
  return [...full];
}

/**
 * Make print-list and running-log commands comparable. Cargo-hack omits the
 * manifest in its normal running display; the package name is checked separately.
 * Only the selected manifest option is removed, with absolute source paths checked.
 * @example normalizeCommand('cargo clippy --manifest-path crates/mango-protocol/Cargo.toml --locked', 'protocol', '/source');
 */
export function normalizeCommand(command: string, repo: Repository, source: string): string {
  const manifestOption = / --manifest-path (?:"([^"\n]+)"|'([^'\n]+)'|(\S+))/g;
  const normalized = command.replace(
    manifestOption,
    (_option, double: string, single: string, bare: string) => {
      const manifest = (double ?? single ?? bare).replaceAll('\\', '/');
      const expected = SOURCES[repo].manifest;
      const root = source.replaceAll('\\', '/').replace(/\/$/, '');
      if (manifest !== expected && manifest !== `${root}/${expected}`) {
        throw new Error(
          `Invalid manifest ${JSON.stringify(manifest)}; expected ${expected} under ${JSON.stringify(root)}`
        );
      }
      return '';
    }
  );
  if (
    !normalized.startsWith('cargo clippy ') ||
    /[\r\n]/.test(normalized) ||
    normalized.includes('\x1b')
  ) {
    throw new Error(
      `Invalid cargo-hack command ${JSON.stringify(command)}; expected one uncolored cargo clippy command`
    );
  }
  return normalized;
}

interface ExecutedCommands {
  running: string[];
  skipping: string[];
  sequence: Array<{ action: string; command: string; index: number; total: number }>;
}

/** Parse normal stderr or GitHub stdout progress, rejecting partial or repeated entries. @example parseExecutionLog(log, 'sdk', '/source'); */
export function parseExecutionLog(
  log: string,
  repo: Repository,
  source: string,
  requireComplete = true
): ExecutedCommands {
  const sequence: ExecutedCommands['sequence'] = [];
  for (const line of log.split(/\r?\n/)) {
    if (!/^(?:info: |::group::)(?:running|skipping) /.test(line)) continue;
    const match =
      /^(?:info: |::group::)(running|skipping) `([^`]+)` on ([\w-]+) \((\d+)\/(\d+)\)$/.exec(line);
    if (!match || match[3] !== SOURCES[repo].package) {
      throw new Error(
        `Invalid cargo-hack progress ${JSON.stringify(line)}; expected running/skipping for ${SOURCES[repo].package}`
      );
    }
    const entry = {
      action: match[1],
      command: normalizeCommand(match[2], repo, source),
      index: Number(match[4]),
      total: Number(match[5]),
    };
    if (entry.index !== sequence.length + 1 || entry.total !== SOURCES[repo].commandCount) {
      throw new Error(
        `Invalid cargo-hack progress ${JSON.stringify(entry)}; expected index ${sequence.length + 1} of ${SOURCES[repo].commandCount}`
      );
    }
    sequence.push(entry);
  }
  if (requireComplete && sequence.length !== SOURCES[repo].commandCount) {
    throw new Error(
      `Incomplete cargo-hack progress ${sequence.length}; expected ${SOURCES[repo].commandCount} running/skipping entries`
    );
  }
  return {
    sequence,
    running: sequence.filter((entry) => entry.action === 'running').map((entry) => entry.command),
    skipping: sequence.filter((entry) => entry.action === 'skipping').map((entry) => entry.command),
  };
}

export interface SourceSnapshot {
  sha: string;
  status: string;
  hashes: Record<string, string>;
}

/** Reject a dirty checkout or changed pinned inputs. @example assertSourceUnchanged('protocol', before, after); */
export function assertSourceUnchanged(
  repo: Repository,
  before: SourceSnapshot,
  after: SourceSnapshot = before
): void {
  for (const snapshot of [before, after]) {
    if (snapshot.sha !== SOURCES[repo].sha || snapshot.status !== '') {
      throw new Error(
        `Invalid ${repo} source ${JSON.stringify(snapshot)}; expected clean HEAD ${SOURCES[repo].sha}`
      );
    }
    for (const file of [
      'Cargo.lock',
      'Cargo.toml',
      'rust-toolchain.toml',
      SOURCES[repo].manifest,
    ]) {
      if (!/^[a-f0-9]{64}$/.test(snapshot.hashes[file] ?? '')) {
        throw new Error(
          `Invalid hash for ${file}: ${JSON.stringify(snapshot.hashes[file])}; expected SHA256`
        );
      }
    }
  }
  const sortedHashes = (hashes: Record<string, string>): string =>
    JSON.stringify(Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right)));
  if (sortedHashes(before.hashes) !== sortedHashes(after.hashes)) {
    throw new Error(
      `Source manifest/lock hashes changed: ${JSON.stringify(after.hashes)}; expected ${JSON.stringify(before.hashes)}`
    );
  }
}

/** Identify the archive verified by the pinned install action. @example cargoHackAsset('darwin', 'arm64'); */
export function cargoHackAsset(
  platform: string,
  arch: string
): { url: string; sha256: string; verification: string } {
  const key = `${platform}-${arch}`;
  const asset = HACK_ASSETS[key as keyof typeof HACK_ASSETS];
  if (!asset)
    throw new Error(
      `Invalid cargo-hack host ${key}; expected one of ${Object.keys(HACK_ASSETS).join(', ')}`
    );
  return {
    url: `https://github.com/taiki-e/cargo-hack/releases/download/v0.6.45/cargo-hack-${asset[0]}.tar.gz`,
    sha256: asset[1],
    verification: `install-action@${INSTALL_ACTION}, checksum=true, fallback=none; confirm download in retained setup log`,
  };
}

export interface CommandSpec {
  label: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

/** Bun 1.4.2 exposes CPU microseconds as bigint despite its number declarations. */
export interface ResourceUsageInput extends Omit<Bun.ResourceUsage, 'cpuTime'> {
  cpuTime: { user: number | bigint; system: number | bigint; total: number | bigint };
}

/** Owned JSON data; CPU microseconds use decimal strings to preserve bigint precision. */
export interface SerializedResourceUsage extends Omit<Bun.ResourceUsage, 'cpuTime'> {
  cpuTime: { user: string; system: string; total: string };
}

/**
 * Copy native prototype getters into plain receipt fields without rounding CPU time.
 * @example const wire = serializeResourceUsage(proc.resourceUsage()); JSON.stringify(wire);
 */
export function serializeResourceUsage(
  usage: ResourceUsageInput | undefined
): SerializedResourceUsage | null {
  if (usage === undefined) return null;
  return {
    contextSwitches: {
      voluntary: usage.contextSwitches.voluntary,
      involuntary: usage.contextSwitches.involuntary,
    },
    cpuTime: {
      user: String(usage.cpuTime.user),
      system: String(usage.cpuTime.system),
      total: String(usage.cpuTime.total),
    },
    maxRSS: usage.maxRSS,
    messages: { sent: usage.messages.sent, received: usage.messages.received },
    ops: { in: usage.ops.in, out: usage.ops.out },
    shmSize: usage.shmSize,
    signalCount: usage.signalCount,
    swapCount: usage.swapCount,
  };
}

export interface CommandSample extends CommandSpec {
  startedUtc: string;
  endedUtc: string;
  wallMs: number;
  exitCode: number | null;
  signal: string | number | null;
  timedOut: boolean;
  canceled: boolean;
  resourceUsage: SerializedResourceUsage | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Validate termination and monotonic duration before using a timing. @example assertSuccessfulSample(sample); */
export function assertSuccessfulSample(sample: CommandSample): void {
  if (
    sample.exitCode !== 0 ||
    sample.signal !== null ||
    sample.timedOut ||
    sample.canceled ||
    sample.error ||
    !Number.isFinite(sample.wallMs) ||
    sample.wallMs < 0
  ) {
    throw new Error(
      `Invalid ${sample.label} sample ${JSON.stringify({ exitCode: sample.exitCode, signal: sample.signal, timedOut: sample.timedOut, canceled: sample.canceled, wallMs: sample.wallMs, error: sample.error })}; expected exit 0, no signal/timeout/cancellation, and a nonnegative monotonic duration`
    );
  }
}

export interface MeasurementReceipt {
  schemaVersion: 1;
  repo: Repository;
  case: MeasurementCase;
  identity: Record<string, string>;
  status: 'incomplete' | 'complete' | 'failed';
  options: MeasurementOptions;
  metadata: Record<string, unknown>;
  before?: SourceSnapshot;
  after?: SourceSnapshot;
  setup: CommandSample[];
  enumeration?: CommandSample;
  sample?: CommandSample;
  fullCommands: string[];
  expectedCommands: string[];
  actualCommands: string[];
  targetEmptyBeforeTiming: boolean;
  error?: string;
}

/** Injected host operations keep coverage and failure tests independent of Cargo. */
export interface MeasurementIo {
  identity: Record<string, string>;
  metadata: () => Record<string, unknown>;
  prepare: () => {
    target: string;
    setupTarget: string;
    cargoHome: string;
    initialState: Record<string, unknown>;
  };
  targetEntries: (target: string) => string[];
  snapshot: (source: string, repo: Repository) => Promise<SourceSnapshot>;
  run: (spec: CommandSpec) => Promise<CommandSample>;
  write: (name: string, content: string) => Promise<void>;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assertSameCommands(
  actual: readonly string[],
  expected: readonly string[],
  label: string
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Invalid ${label} commands ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}`
    );
  }
}

function sampleSummary(sample: CommandSample): Omit<CommandSample, 'stdout' | 'stderr'> {
  const { stdout: _stdout, stderr: _stderr, ...summary } = sample;
  return summary;
}

async function persistSample(io: MeasurementIo, sample: CommandSample): Promise<void> {
  await io.write(`${sample.label}.json`, json(sampleSummary(sample)));
  await io.write(`${sample.label}.stdout.txt`, sample.stdout);
  await io.write(`${sample.label}.stderr.txt`, sample.stderr);
}

async function runSetup(
  io: MeasurementIo,
  receipt: MeasurementReceipt,
  env: Record<string, string>
): Promise<void> {
  for (const [index, argv] of SETUP_COMMANDS.entries()) {
    const sample = await io.run({
      label: index === 5 ? 'fetch' : `version-${index}`,
      argv,
      cwd: receipt.options.source,
      env,
      timeoutMs: index === 5 ? 300_000 : 30_000,
    });
    receipt.setup.push(sample);
    await persistSample(io, sample);
    assertSuccessfulSample(sample);
  }
  assertToolVersions(receipt.setup);
}

function assertToolVersions(samples: readonly CommandSample[]): void {
  const versions = samples.map((sample) => sample.stdout.trim());
  if (
    !versions[0]?.startsWith('rustc 1.99.0 ') ||
    !versions[1]?.startsWith('cargo 1.99.0 ') ||
    !versions[2]?.startsWith('clippy 0.1.99 ') ||
    versions[3] !== 'cargo-hack 0.6.45' ||
    versions[4] !== '1.4.2'
  ) {
    throw new Error(
      `Invalid tool versions ${JSON.stringify(versions.slice(0, 5))}; expected Rust/Cargo 1.99.0, Clippy 0.1.99, cargo-hack 0.6.45 and Bun 1.4.2`
    );
  }
}

/**
 * Persist successful or partial evidence, and require actual command coverage.
 * @example await measureFeatureCase(options, namedHostIo);
 */
export async function measureFeatureCase(
  options: MeasurementOptions,
  io: MeasurementIo
): Promise<MeasurementReceipt> {
  const receipt: MeasurementReceipt = {
    schemaVersion: 1,
    repo: options.repo,
    case: options.case,
    identity: io.identity,
    status: 'incomplete',
    options,
    metadata: {},
    setup: [],
    fullCommands: [],
    expectedCommands: [],
    actualCommands: [],
    targetEmptyBeforeTiming: false,
  };
  await io.write('receipt.json', json(receipt));
  try {
    receipt.metadata = io.metadata();
    const dirs = io.prepare();
    receipt.metadata.directories = dirs;
    const env = {
      CARGO_TARGET_DIR: dirs.target,
      CARGO_HOME: dirs.cargoHome,
      CARGO_TERM_COLOR: 'never',
    };
    // cargo fetch writes .rustc_info.json. Keep all untimed work in its own
    // target, so the compiler sample receives an empty target on every host.
    const setupEnv = { ...env, CARGO_TARGET_DIR: dirs.setupTarget };
    receipt.before = await io.snapshot(options.source, options.repo);
    assertSourceUnchanged(options.repo, receipt.before);
    await runSetup(io, receipt, setupEnv);
    receipt.enumeration = await io.run({
      label: 'enumeration',
      argv: measurementCommand(options.repo, 'full', true),
      cwd: options.source,
      env: setupEnv,
      timeoutMs: 120_000,
    });
    await persistSample(io, receipt.enumeration);
    assertSuccessfulSample(receipt.enumeration);
    receipt.fullCommands = receipt.enumeration.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((command) => normalizeCommand(command, options.repo, options.source));
    if (receipt.fullCommands.length !== SOURCES[options.repo].commandCount) {
      throw new Error(
        `Invalid enumeration count ${receipt.fullCommands.length}; expected ${SOURCES[options.repo].commandCount}`
      );
    }
    receipt.expectedCommands = expectedPartition(receipt.fullCommands, options.case);
    await io.write('full-command-list.txt', `${receipt.fullCommands.join('\n')}\n`);
    await io.write('expected-command-list.txt', `${receipt.expectedCommands.join('\n')}\n`);
    const entries = io.targetEntries(dirs.target);
    if (entries.length !== 0)
      throw new Error(
        `Invalid pre-measurement target entries ${JSON.stringify(entries)}; expected a fresh empty target`
      );
    receipt.targetEmptyBeforeTiming = true;
    await io.write('receipt.json', json(receipt));
    receipt.sample = await io.run({
      label: 'sample',
      argv: measurementCommand(options.repo, options.case),
      cwd: options.source,
      env,
      timeoutMs: 1_200_000,
    });
    await persistSample(io, receipt.sample);
    const progress = `${receipt.sample.stdout}\n${receipt.sample.stderr}`;
    const execution = parseExecutionLog(progress, options.repo, options.source, false);
    receipt.actualCommands = execution.running;
    await io.write('execution.json', json(execution));
    await io.write('actual-command-list.txt', `${receipt.actualCommands.join('\n')}\n`);
    assertSuccessfulSample(receipt.sample);
    parseExecutionLog(progress, options.repo, options.source);
    assertSameCommands(
      execution.sequence.map((entry) => entry.command),
      receipt.fullCommands,
      'running/skipping sequence'
    );
    assertSameCommands(receipt.actualCommands, receipt.expectedCommands, options.case);
    receipt.status = 'complete';
  } catch (caught) {
    receipt.status = 'failed';
    receipt.error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    await finalizeSource(io, receipt);
    await io.write('receipt.json', json(receipt));
  }
  return receipt;
}

async function finalizeSource(io: MeasurementIo, receipt: MeasurementReceipt): Promise<void> {
  try {
    receipt.after = await io.snapshot(receipt.options.source, receipt.repo);
    await io.write('post-check.json', json(receipt.after));
    if (receipt.before) assertSourceUnchanged(receipt.repo, receipt.before, receipt.after);
  } catch (caught) {
    receipt.status = 'failed';
    receipt.error = [receipt.error, caught instanceof Error ? caught.message : String(caught)]
      .filter(Boolean)
      .join('\n');
  }
}

export interface HostedEvidence {
  receipt: MeasurementReceipt;
  jobConclusion: string;
  uploadConclusion: string;
}

function assertHostedIdentity(identity: Record<string, string>): void {
  const branch = 'refs/heads/measure/cargo-feature-partitions';
  if (
    !identity ||
    !/^[1-9]\d*$/.test(identity.GITHUB_RUN_ID ?? '') ||
    !/^[1-9]\d*$/.test(identity.GITHUB_RUN_ATTEMPT ?? '') ||
    !/^[a-f0-9]{40}$/.test(identity.GITHUB_SHA ?? '') ||
    identity.GITHUB_REF !== branch ||
    identity.GITHUB_REPOSITORY !== SOURCES.protocol.repository ||
    identity.GITHUB_WORKFLOW_REF !==
      `${SOURCES.protocol.repository}/.github/workflows/protocol-ci.yml@${branch}` ||
    !['ubuntu-latest', 'macos-latest', 'windows-latest'].includes(identity.FEATURE_OS)
  ) {
    throw new Error(
      `Invalid hosted trial identity ${JSON.stringify(identity)}; expected run ID/attempt, immutable workflow SHA and the manual measurement workflow/branch/OS`
    );
  }
}

function assertReceiptCommands(receipt: MeasurementReceipt): void {
  const { sample, enumeration, repo, case: case_, options } = receipt;
  if (
    !sample ||
    !enumeration ||
    !options ||
    options.repo !== repo ||
    options.case !== case_ ||
    sample.cwd !== options.source ||
    JSON.stringify(sample.argv) !== JSON.stringify(measurementCommand(repo, case_))
  ) {
    throw new Error(
      `Invalid measured command identity ${JSON.stringify(sample?.argv)}; expected pinned ${repo}/${case_} argv and source cwd`
    );
  }
  assertSuccessfulSample(enumeration);
  assertSameCommands(enumeration.argv, measurementCommand(repo, 'full', true), 'enumeration argv');
  const { CARGO_TARGET_DIR: target, CARGO_HOME: cargoHome } = sample.env;
  const setupTarget = enumeration.env.CARGO_TARGET_DIR;
  if (
    !target ||
    !setupTarget ||
    target === setupTarget ||
    !cargoHome ||
    sample.env.CARGO_TERM_COLOR !== 'never' ||
    enumeration.env.CARGO_HOME !== cargoHome ||
    enumeration.env.CARGO_TERM_COLOR !== 'never' ||
    receipt.setup.some(
      ({ env }) =>
        env.CARGO_TARGET_DIR !== setupTarget ||
        env.CARGO_HOME !== cargoHome ||
        env.CARGO_TERM_COLOR !== 'never'
    )
  ) {
    throw new Error(
      `Invalid Cargo directory identity ${JSON.stringify({ target, setupTarget, cargoHome })}; expected distinct timed/setup targets, shared download-only Cargo home and CARGO_TERM_COLOR=never`
    );
  }
  if (receipt.fullCommands.length !== SOURCES[repo].commandCount) {
    throw new Error(
      `Invalid full enumeration count ${receipt.fullCommands.length}; expected ${SOURCES[repo].commandCount}`
    );
  }
  const printed = enumeration.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((command) => normalizeCommand(command, repo, options.source));
  assertSameCommands(printed, receipt.fullCommands, 'raw enumeration');
  const executed = parseExecutionLog(`${sample.stdout}\n${sample.stderr}`, repo, options.source);
  assertSameCommands(
    executed.sequence.map((entry) => entry.command),
    receipt.fullCommands,
    'raw running/skipping sequence'
  );
  assertSameCommands(executed.running, receipt.actualCommands, 'raw executed');
  if (receipt.setup.length !== SETUP_COMMANDS.length) {
    throw new Error(
      `Invalid setup sample count ${receipt.setup.length}; expected ${SETUP_COMMANDS.length}`
    );
  }
  for (const [index, setup] of receipt.setup.entries()) {
    assertSuccessfulSample(setup);
    assertSameCommands(setup.argv, SETUP_COMMANDS[index], 'setup argv');
  }
  assertToolVersions(receipt.setup);
}

/**
 * Require three complete receipts from the same hosted trial and exact union.
 * Job and upload conclusions must come from the matching GitHub attempt.
 * @example validatePartitionUnion([fullEvidence, p1Evidence, p2Evidence]);
 */
export function validatePartitionUnion(evidence: readonly HostedEvidence[]): {
  fullWallMs: number;
  partitionMaxWallMs: number;
  partitionTotalWallMs: number;
} {
  if (!Array.isArray(evidence) || evidence.length !== 3)
    throw new Error(`Invalid receipt count ${evidence.length}; expected full, p1 and p2 once each`);
  const receipts = evidence.map((item) => {
    if (!item?.receipt || item.jobConclusion !== 'success' || item.uploadConclusion !== 'success') {
      throw new Error(
        `Incomplete hosted evidence ${JSON.stringify(item)}; expected a receipt plus successful job and upload conclusions`
      );
    }
    const receipt = item.receipt;
    if (
      receipt.schemaVersion !== 1 ||
      receipt.status !== 'complete' ||
      !receipt.sample ||
      !receipt.before ||
      !receipt.after ||
      !receipt.targetEmptyBeforeTiming
    ) {
      throw new Error(
        `Incomplete ${receipt.case} receipt; expected schema 1, complete sample, source checks and fresh empty target`
      );
    }
    if (
      !['protocol', 'sdk'].includes(receipt.repo) ||
      !['full', 'p1', 'p2'].includes(receipt.case)
    ) {
      throw new Error(
        `Invalid receipt selectors ${receipt.repo}/${receipt.case}; expected protocol|sdk and full|p1|p2`
      );
    }
    assertHostedIdentity(receipt.identity);
    if (
      !Array.isArray(receipt.fullCommands) ||
      !Array.isArray(receipt.expectedCommands) ||
      !Array.isArray(receipt.actualCommands) ||
      !Array.isArray(receipt.setup)
    ) {
      throw new Error(
        `Invalid ${receipt.case} receipt lists; expected full, expected, actual and setup arrays`
      );
    }
    assertSuccessfulSample(receipt.sample);
    assertSourceUnchanged(receipt.repo, receipt.before, receipt.after);
    assertReceiptCommands(receipt);
    return receipt;
  });
  const full = receipts.find((receipt) => receipt.case === 'full');
  const p1 = receipts.find((receipt) => receipt.case === 'p1');
  const p2 = receipts.find((receipt) => receipt.case === 'p2');
  if (!full || !p1 || !p2)
    throw new Error(
      `Invalid receipt cases ${JSON.stringify(receipts.map((receipt) => receipt.case))}; expected full, p1, p2 exactly once`
    );
  for (const receipt of receipts) {
    if (
      receipt.repo !== full.repo ||
      JSON.stringify(receipt.identity) !== JSON.stringify(full.identity)
    ) {
      throw new Error(
        `Mismatched trial identity ${JSON.stringify(receipt.identity)}; expected repo ${full.repo} and ${JSON.stringify(full.identity)}`
      );
    }
    assertSameCommands(receipt.fullCommands, full.fullCommands, 'host enumeration');
    assertSameCommands(
      receipt.expectedCommands,
      expectedPartition(full.fullCommands, receipt.case),
      'derived partition'
    );
    assertSameCommands(receipt.actualCommands, receipt.expectedCommands, 'actual executed');
  }
  assertSameCommands(
    [...p1.actualCommands, ...p2.actualCommands],
    full.actualCommands,
    'partition union'
  );
  return {
    fullWallMs: full.sample?.wallMs ?? 0,
    partitionMaxWallMs: Math.max(p1.sample?.wallMs ?? 0, p2.sample?.wallMs ?? 0),
    partitionTotalWallMs: (p1.sample?.wallMs ?? 0) + (p2.sample?.wallMs ?? 0),
  };
}

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function snapshotSource(source: string, repo: Repository): Promise<SourceSnapshot> {
  const sha = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: source });
  const status = Bun.spawnSync(['git', 'status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: source,
  });
  if (!sha.success || !status.success)
    throw new Error(`Invalid source directory ${source}; expected a readable Git checkout`);
  const files = [
    ...new Set(['Cargo.lock', 'Cargo.toml', 'rust-toolchain.toml', SOURCES[repo].manifest]),
  ];
  return Promise.resolve({
    sha: sha.stdout.toString().trim(),
    status: status.stdout.toString().trim(),
    hashes: Object.fromEntries(files.map((file) => [file, digest(join(source, file))])),
  });
}

function killCommand(proc: Bun.Subprocess, platform: string): void {
  if (platform === 'win32') {
    const killed = Bun.spawnSync(['taskkill', '/pid', String(proc.pid), '/t', '/f'], {
      stdout: 'ignore',
      stderr: 'ignore',
      timeout: 10_000,
    });
    if (!killed.success) proc.kill('SIGKILL');
    return;
  }
  try {
    process.kill(-proc.pid, 'SIGKILL');
  } catch {
    proc.kill('SIGKILL');
  }
}

/**
 * Settle every output reader without allowing cleanup to hang the receipt writer.
 * @example await settleCommandCleanup([child.exited, stdoutCapture, stderrCapture], 2000);
 */
export async function settleCommandCleanup(
  promises: readonly Promise<unknown>[],
  timeoutMs: number
): Promise<PromiseSettledResult<unknown>[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `Command cleanup exceeded ${timeoutMs} ms; expected process and output readers to settle within this bound`
          )
        ),
      timeoutMs
    );
  });
  try {
    return await Promise.race([Promise.allSettled(promises), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Capture actual subprocess output, monotonic wall time, and raw Bun accounting.
 * POSIX uses a separate group; Windows taskkill bounds the child tree on timeout.
 * @example await runMeasuredCommand(spec, '/receipts', controller.signal);
 */
export async function runMeasuredCommand(
  spec: CommandSpec,
  output: string,
  signal: AbortSignal
): Promise<CommandSample> {
  if (spec.argv.length === 0 || !Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0) {
    throw new Error(
      `Invalid command spec ${JSON.stringify(spec)}; expected nonempty argv and a positive finite timeout`
    );
  }
  const startedUtc = new Date().toISOString();
  const started = performance.now();
  let timedOut = false;
  let canceled = signal.aborted;
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  const captureController = new AbortController();
  let captures: Promise<string>[] = [];
  const sample: CommandSample = {
    ...spec,
    startedUtc,
    endedUtc: startedUtc,
    wallMs: 0,
    exitCode: null,
    signal: null,
    timedOut,
    canceled,
    resourceUsage: null,
    stdout: '',
    stderr: '',
  };
  const abort = (): void => {
    canceled = true;
    if (proc) killCommand(proc, process.platform);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    if (proc) killCommand(proc, process.platform);
  }, spec.timeoutMs);
  try {
    if (signal.aborted)
      throw new Error('Command canceled before spawn; expected an active measurement');
    proc = Bun.spawn(spec.argv, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: process.platform !== 'win32',
    });
    signal.addEventListener('abort', abort, { once: true });
    captures = [
      captureStream(proc.stdout, 'stdout', spec.label, output, started, captureController.signal),
      captureStream(proc.stderr, 'stderr', spec.label, output, started, captureController.signal),
    ];
    const [exitCode, captured] = await Promise.all([proc.exited, Promise.all(captures)]);
    sample.exitCode = exitCode;
    sample.stdout = captured[0];
    sample.stderr = captured[1];
    sample.signal = proc.signalCode ?? null;
    sample.resourceUsage = serializeResourceUsage(proc.resourceUsage());
  } catch (caught) {
    sample.error = caught instanceof Error ? caught.message : String(caught);
    captureController.abort();
    if (proc) {
      killCommand(proc, process.platform);
      sample.exitCode = proc.exitCode;
      try {
        const settled = await settleCommandCleanup([proc.exited, ...captures], 2000);
        if (settled[0]?.status === 'fulfilled' && typeof settled[0].value === 'number') {
          sample.exitCode = settled[0].value;
        }
        if (settled[1]?.status === 'fulfilled') sample.stdout = String(settled[1].value);
        if (settled[2]?.status === 'fulfilled') sample.stderr = String(settled[2].value);
      } catch (cleanupError) {
        sample.error += `\n${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
      }
      sample.signal = proc.signalCode ?? null;
      sample.resourceUsage = serializeResourceUsage(proc.resourceUsage());
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    sample.endedUtc = new Date().toISOString();
    sample.wallMs = performance.now() - started;
    sample.timedOut = timedOut;
    sample.canceled = canceled;
  }
  return sample;
}

async function captureStream(
  stream: ReadableStream<Uint8Array>,
  channel: 'stdout' | 'stderr',
  label: string,
  output: string,
  started: number,
  signal: AbortSignal
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const decoded = decoder.decode(chunk.value, { stream: true });
      text += decoded;
      appendFileSync(
        join(output, `${label}.output.jsonl`),
        `${JSON.stringify({ utc: new Date().toISOString(), wallMs: performance.now() - started, channel, text: decoded })}\n`
      );
      appendFileSync(join(output, `${label}.${channel}.txt`), chunk.value);
      process[channel].write(decoded);
    }
    return text + decoder.decode();
  } catch (caught) {
    throw new Error(
      `Failed ${channel} capture for ${label} at ${output}: ${caught instanceof Error ? caught.message : String(caught)}; expected writable regular receipt files`,
      { cause: caught }
    );
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function hostMetadata(): Record<string, unknown> {
  const hack = Bun.which('cargo-hack');
  if (!hack) throw new Error('Missing cargo-hack on PATH; expected installed cargo-hack 0.6.45');
  const harnessRoot = resolve(dirname(import.meta.path), '../..');
  const harness = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: harnessRoot });
  const harnessStatus = Bun.spawnSync(
    ['git', 'status', '--porcelain=v1', '--untracked-files=all'],
    { cwd: harnessRoot }
  );
  if (!harness.success || !harnessStatus.success)
    throw new Error(`Invalid harness checkout ${harnessRoot}; expected a Git HEAD`);
  const harnessSha = harness.stdout.toString().trim();
  if (
    process.env.GITHUB_SHA &&
    (harnessSha !== process.env.GITHUB_SHA || harnessStatus.stdout.toString().trim() !== '')
  ) {
    throw new Error(
      `Invalid harness checkout ${harnessSha}; expected clean workflow HEAD ${process.env.GITHUB_SHA}`
    );
  }
  return {
    harnessSha,
    harnessStatus: harnessStatus.stdout.toString().trim(),
    harnessScriptSha256: digest(import.meta.path),
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    logicalCpus: cpus().length,
    cpuModels: [...new Set(cpus().map((cpu) => cpu.model))],
    memoryBytes: totalmem(),
    imageOS: process.env.ImageOS ?? null,
    imageVersion: process.env.ImageVersion ?? null,
    runnerOS: process.env.RUNNER_OS ?? null,
    runnerArch: process.env.RUNNER_ARCH ?? null,
    runUrl: process.env.GITHUB_RUN_ID
      ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}/attempts/${process.env.GITHUB_RUN_ATTEMPT}`
      : null,
    compilerEnvironment: Object.fromEntries(
      [
        'RUSTFLAGS',
        'CARGO_ENCODED_RUSTFLAGS',
        'RUSTC_WRAPPER',
        'RUSTC_WORKSPACE_WRAPPER',
        'RUSTC',
        'CARGO_BUILD_TARGET',
        'CARGO_BUILD_JOBS',
        'CARGO_INCREMENTAL',
      ].map((key) => [key, process.env[key] ?? null])
    ),
    cargoHack: {
      binary: hack,
      binarySha256: digest(hack),
      archive: cargoHackAsset(process.platform, process.arch),
    },
    cachePolicy:
      'No Actions cache, fresh CARGO_HOME, downloads warmed by untimed cargo fetch --locked, empty CARGO_TARGET_DIR at measured start; OS file cache uncontrolled',
    resourceAccounting: {
      provider: 'Bun 1.4.2 subprocess.resourceUsage()',
      maxRSSUnit: 'bytes',
      cpuTimeUnit: 'microseconds',
      cpuTimeEncoding: 'decimal strings, preserving native bigint precision',
      qualification:
        'Raw OS subprocess accounting for cargo-hack; neither sampled process-tree RSS nor a sum of descendant peaks. Descendant CPU/RSS inclusion is platform dependent and has not been qualified, including on Windows.',
    },
    instrumentation:
      'Monotonic command duration includes raw log writes, timestamped chunk records and forwarding output to the job log',
  };
}

function hostIo(options: MeasurementOptions, signal: AbortSignal): MeasurementIo {
  const identity = Object.fromEntries(
    [
      'GITHUB_RUN_ID',
      'GITHUB_RUN_ATTEMPT',
      'GITHUB_SHA',
      'GITHUB_REF',
      'GITHUB_WORKFLOW_REF',
      'GITHUB_REPOSITORY',
      'FEATURE_OS',
    ].map((key) => [key, process.env[key] ?? 'local'])
  );
  const root = join(
    process.env.RUNNER_TEMP ?? tmpdir(),
    `cargo-feature-${options.repo}-${options.case}-${randomUUID()}`
  );
  return {
    identity,
    metadata: hostMetadata,
    prepare() {
      mkdirSync(root);
      const target = join(root, 'target');
      const setupTarget = join(root, 'setup-target');
      const cargoHome = join(root, 'cargo-home');
      mkdirSync(target);
      mkdirSync(setupTarget);
      mkdirSync(cargoHome);
      return {
        target,
        setupTarget,
        cargoHome,
        initialState: {
          targetEntries: readdirSync(target),
          setupTargetEntries: readdirSync(setupTarget),
          cargoHomeEntries: readdirSync(cargoHome),
          actionsCache: false,
        },
      };
    },
    targetEntries: (target) => readdirSync(target),
    snapshot: snapshotSource,
    run: (spec) => runMeasuredCommand(spec, options.output, signal),
    write: async (name, content) => {
      if (/(?:stdout|stderr)\.txt$/.test(name) && existsSync(join(options.output, name))) return;
      await Bun.write(join(options.output, name), content);
    },
  };
}

async function main(args: string[]): Promise<void> {
  if (args[0] === 'compare' && args.length === 2) {
    const evidence: HostedEvidence[] = await Bun.file(args[1]).json();
    console.log(json(validatePartitionUnion(evidence)));
    return;
  }
  if (args[0] !== 'measure')
    throw new Error(
      `Invalid command ${JSON.stringify(args)}; expected measure [repo case source output] or compare evidence.json`
    );
  const positional = args.slice(1);
  const options = parseMeasurementArgs(
    positional.length
      ? positional
      : [
          process.env.FEATURE_REPO ?? '',
          process.env.FEATURE_CASE ?? '',
          process.env.FEATURE_SOURCE ?? '',
          process.env.FEATURE_OUTPUT ?? '',
        ]
  );
  if (existsSync(options.output))
    throw new Error(
      `Invalid existing receipt directory ${options.output}; expected a new output directory`
    );
  mkdirSync(options.output, { recursive: true });
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  process.on('SIGTERM', cancel);
  process.on('SIGINT', cancel);
  const receipt = await measureFeatureCase(options, hostIo(options, controller.signal));
  process.off('SIGTERM', cancel);
  process.off('SIGINT', cancel);
  if (receipt.status !== 'complete')
    throw new Error(receipt.error ?? 'Incomplete measurement; expected a complete receipt');
}

if (import.meta.main) {
  try {
    await main(Bun.argv.slice(2));
  } catch (caught) {
    console.error(caught instanceof Error ? caught.message : String(caught));
    process.exitCode = 1;
  }
}
