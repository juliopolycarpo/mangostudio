#!/usr/bin/env bun

// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Manual measurement runs outside Turbo; environment values are receipt identities and action results.

/**
 * Hosted three-job cache persistence experiment. The fixture is always the same
 * Git tree; change/replay append the same comment without changing tsc flags.
 * Local receipts stay incomplete until the collector verifies six hosted jobs.
 * @example bun scripts/bench/turbo-snapshot-measurement.ts prepare
 */
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import {
  assertSuccessfulSample,
  type CommandSample,
  type CommandSpec,
  runMeasuredCommand,
} from './cargo-feature-measurement';

export const SNAPSHOT_SOURCE = '9a3d8ee5e5d329760accc840a5dcdf334083d3c4';
export const COMMENT_PATH = 'packages/protocol/src/index.ts';
export const SOURCE_COMMENT =
  '\n// Hosted Turbo snapshot persistence fixture: identical in change and replay.\n';
export const MAX_PAYLOAD_BYTES = 1024 * 1024;
export const TASK_LOGS = {
  '@mangostudio/api#typecheck': 'apps/api/.turbo/turbo-typecheck.log',
  '@mangostudio/frontend#typecheck': 'apps/frontend/.turbo/turbo-typecheck.log',
  '@mangostudio/protocol#typecheck': 'packages/protocol/.turbo/turbo-typecheck.log',
  '@mangostudio/shared#typecheck': 'apps/shared/.turbo/turbo-typecheck.log',
} as const;
const IDENTITY_FILES = [
  '.bun-version',
  'bun.lock',
  'package.json',
  'turbo.jsonc',
  'tsconfig.json',
  'apps/api/package.json',
  'apps/frontend/package.json',
  'apps/shared/package.json',
  'packages/protocol/package.json',
  'apps/api/tsconfig.json',
  'apps/frontend/tsconfig.json',
  'apps/shared/tsconfig.json',
  'packages/protocol/tsconfig.json',
];

export type Phase = 'prime' | 'change' | 'replay';
export type Variant = 'baseline' | 'candidate';
export interface SnapshotOptions {
  phase: Phase;
  variant: Variant;
  source: string;
  output: string;
  runId: string;
  attempt: string;
}
export interface TurboTask {
  taskId: string;
  hash: string;
  command: string;
  cache: { status: string; local: boolean; remote: boolean };
  execution?: { exitCode?: number; startTime: number; endTime: number };
}
export interface TurboSummary {
  turboVersion: string;
  tasks: TurboTask[];
  globalCacheInputs: unknown;
}
export interface PayloadEntry {
  name: string;
  bytes: number;
  sha256: string;
  regular: boolean;
}
export interface SnapshotReceipt {
  schemaVersion: 1;
  options: SnapshotOptions;
  status: 'incomplete';
  localComplete: boolean;
  resourceAccounting: 'unavailable; this experiment qualifies wall time and cache persistence only';
  identity: Record<string, string>;
  keys: {
    prefix: string;
    k0: string;
    k1: string;
    restore: string;
    save: string;
    restorePrefix: string;
  };
  comment: {
    path: string;
    bytes: string;
    sha256: string;
    baseSha256?: string;
    fixtureSha256?: string;
  };
  setup: CommandSample[];
  baseline?: TurboSummary;
  fixture?: TurboSummary;
  sample?: CommandSample;
  summary?: TurboSummary;
  restored?: PayloadEntry[];
  payload?: { files: PayloadEntry[]; rawBytes: number; conservativeArchiveBytes: number };
  actions?: Record<string, string>;
  error?: string;
}

/** External operations are named and injected; fake tests never run a compiler or cache service. */
export interface SnapshotIo {
  read: (path: string) => string;
  write: (path: string, content: string) => void;
  files: (path: string) => PayloadEntry[];
  summary: (source: string) => string;
  archive: (path: string) => Promise<string[]>;
  run: (spec: CommandSpec) => Promise<CommandSample>;
  output: (values: Record<string, string>) => void;
}

/** Hash exact UTF-8 fixture/config bytes. @example digest(SOURCE_COMMENT); */
export function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Drop inherited native resource getters rather than serializing them as false empty accounting. @example snapshotJson(receipt); */
export function snapshotJson(value: unknown): string {
  return JSON.stringify(value, (key, item) => (key === 'resourceUsage' ? null : item), 2);
}

/** Reject missing or malformed hosted identities before making a cache key. @example snapshotOptions(process.env); */
export function snapshotOptions(env: Record<string, string | undefined>): SnapshotOptions {
  const phase = env.SNAPSHOT_PHASE;
  const variant = env.SNAPSHOT_VARIANT;
  if (
    !['prime', 'change', 'replay'].includes(phase ?? '') ||
    !['baseline', 'candidate'].includes(variant ?? '')
  )
    throw new Error(
      `Invalid phase/variant ${phase}/${variant}; expected prime|change|replay and baseline|candidate`
    );
  if (!/^\d+$/.test(env.GITHUB_RUN_ID ?? '') || !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? ''))
    throw new Error(
      `Invalid run/attempt ${env.GITHUB_RUN_ID}/${env.GITHUB_RUN_ATTEMPT}; expected decimal hosted identities`
    );
  return {
    phase: phase as Phase,
    variant: variant as Variant,
    source: resolve(env.SNAPSHOT_SOURCE ?? 'source'),
    output: resolve(env.SNAPSHOT_OUTPUT ?? 'receipts'),
    runId: env.GITHUB_RUN_ID ?? '',
    attempt: env.GITHUB_RUN_ATTEMPT ?? '',
  };
}

/** Preserve all four real commands and explicitly account for the CLI's virtual task. @example realTasks(summary); */
export function realTasks(summary: TurboSummary): TurboTask[] {
  if (summary.turboVersion !== '2.11.6' || !Array.isArray(summary.tasks))
    throw new Error(
      `Invalid Turbo summary ${JSON.stringify(summary)}; expected Turbo 2.11.6 tasks`
    );
  const real = summary.tasks.filter((task) => task.command !== '<NONEXISTENT>');
  const ids = real.map((task) => task.taskId).sort();
  if (
    JSON.stringify(ids) !== JSON.stringify(Object.keys(TASK_LOGS).sort()) ||
    real.some((task) => task.command !== 'tsc --noEmit' || !/^[a-f0-9]{16}$/.test(task.hash)) ||
    summary.tasks.some(
      (task) => task.command === '<NONEXISTENT>' && task.taskId !== 'mangostudio#typecheck'
    )
  )
    throw new Error(
      `Invalid task coverage ${JSON.stringify(summary.tasks)}; expected four distinct tsc --noEmit tasks and only the known virtual CLI task`
    );
  return real;
}

/** Pin the sole allowed tracked mutation, including its exact bytes. @example assertFixture(head, status, original, changed, 'change'); */
export function assertFixture(
  head: string,
  status: string,
  original: string,
  current: string,
  phase: Phase
): void {
  const expectedStatus = phase === 'prime' ? '' : ` M ${COMMENT_PATH}`;
  if (
    head.trim() !== SNAPSHOT_SOURCE ||
    status.trimEnd() !== expectedStatus ||
    current !== original + (phase === 'prime' ? '' : SOURCE_COMMENT)
  )
    throw new Error(
      `Invalid source fixture ${JSON.stringify({ head, status, phase, currentHash: digest(current) })}; expected ${SNAPSHOT_SOURCE} and only the exact ${COMMENT_PATH} comment`
    );
}

/** Keep arm-specific namespaces stable across jobs, rotating only the candidate key. @example snapshotKeys(options, identity); */
export function snapshotKeys(
  options: SnapshotOptions,
  identity: Record<string, string>
): SnapshotReceipt['keys'] {
  const prefix = `mng398-typecheck-snapshot-${options.runId}-${options.attempt}-${options.variant}-${digest(JSON.stringify(identity)).slice(0, 24)}-`;
  const k0 = `${prefix}K0`;
  const k1 = `${prefix}K1`;
  const rotate = options.variant === 'candidate' && options.phase !== 'prime';
  return {
    prefix,
    k0,
    k1,
    restore: rotate ? k1 : k0,
    save: rotate ? k1 : k0,
    restorePrefix: rotate ? prefix : '',
  };
}

/** Resolve tracked task hashes to their only permitted cache output. @example allowedLogs(receipt); */
export function allowedLogs(receipt: SnapshotReceipt): Record<string, string> {
  const summaries = [receipt.baseline, receipt.fixture].filter((value) => value !== undefined);
  return Object.fromEntries(
    summaries.flatMap((summary) =>
      realTasks(summary).map((task) => [
        task.hash,
        TASK_LOGS[task.taskId as keyof typeof TASK_LOGS],
      ])
    )
  );
}

/** Reject foreign entries and reserve conservative tar/zstd overhead before Actions save. @example boundPayload(files, allowedLogs(receipt)); */
export function boundPayload(
  files: PayloadEntry[],
  allowed: Record<string, string>
): NonNullable<SnapshotReceipt['payload']> {
  if (files.length === 0)
    throw new Error('Invalid empty Turbo payload; expected typecheck receipts');
  for (const file of files) {
    const match = /^([a-f0-9]{16})(\.tar\.zst|-meta\.json|-manifest\.json)$/.exec(file.name);
    if (
      !file.regular ||
      !match ||
      !allowed[match[1]] ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0
    )
      throw new Error(
        `Invalid cache entry ${JSON.stringify(file)}; expected regular known typecheck archive/metadata/manifest`
      );
  }
  for (const hash of new Set(files.map((file) => file.name.slice(0, 16)))) {
    if (
      !['.tar.zst', '-meta.json', '-manifest.json'].every((suffix) =>
        files.some((file) => file.name === hash + suffix)
      )
    )
      throw new Error(
        `Invalid incomplete cache hash ${hash}; expected archive, metadata and manifest`
      );
  }
  const rawBytes = files.reduce((total, file) => total + file.bytes, 0);
  // One KiB header allowance per short regular filename, tar block padding,
  // plus 64 KiB for archive framing/compression overhead. The fixed cache path
  // and accepted filenames cannot contain long names or symlink metadata.
  const conservativeArchiveBytes = files.reduce(
    (total, file) => total + Math.ceil(file.bytes / 512) * 512 + 1024,
    65536
  );
  if (conservativeArchiveBytes > MAX_PAYLOAD_BYTES)
    throw new Error(
      `Invalid cache payload ${conservativeArchiveBytes} bytes (${rawBytes} raw); expected at most ${MAX_PAYLOAD_BYTES} bytes including reserved archive overhead`
    );
  return { files, rawBytes, conservativeArchiveBytes };
}

/** Assert real executions versus replays using both task hashes and local-only cache state. @example assertTaskResults(receipt); */
export function assertTaskResults(receipt: SnapshotReceipt): void {
  if (!receipt.baseline || !receipt.fixture || !receipt.summary || !receipt.sample)
    throw new Error('Invalid missing measurement; expected baseline, fixture, summary and sample');
  assertSuccessfulSample(receipt.sample);
  const baseline = new Map(realTasks(receipt.baseline).map((task) => [task.taskId, task.hash]));
  const fixture = new Map(realTasks(receipt.fixture).map((task) => [task.taskId, task.hash]));
  const expected =
    receipt.options.phase === 'replay' && receipt.options.variant === 'candidate' ? 'HIT' : 'MISS';
  for (const task of realTasks(receipt.summary)) {
    if (
      task.hash !== fixture.get(task.taskId) ||
      task.cache.status !== expected ||
      task.cache.remote ||
      task.cache.local !== (expected === 'HIT') ||
      task.execution?.exitCode !== 0 ||
      !task.execution ||
      !Number.isFinite(task.execution.startTime) ||
      task.execution.endTime < task.execution.startTime ||
      (receipt.options.phase !== 'prime' && baseline.get(task.taskId) === task.hash)
    )
      throw new Error(
        `Invalid ${task.taskId} result ${JSON.stringify(task)}; expected fixture hash, local ${expected}, exit 0 and changed hash in non-prime jobs`
      );
  }
}

/** Execute each CLI phase against injected host operations. Receipts remain incomplete until hosted collection. @example await snapshotCommand('prepare', options, io); */
export async function snapshotCommand(
  action: string,
  options: SnapshotOptions,
  io: SnapshotIo
): Promise<SnapshotReceipt> {
  if (!['prepare', 'measure', 'cap'].includes(action))
    throw new Error(`Invalid snapshot command ${action}; expected prepare, measure or cap`);
  const path = join(options.output, 'receipt.json');
  const receipt: SnapshotReceipt =
    action === 'prepare'
      ? {
          schemaVersion: 1,
          options,
          status: 'incomplete',
          localComplete: false,
          resourceAccounting:
            'unavailable; this experiment qualifies wall time and cache persistence only',
          identity: {},
          keys: { prefix: '', k0: '', k1: '', restore: '', save: '', restorePrefix: '' },
          comment: { path: COMMENT_PATH, bytes: SOURCE_COMMENT, sha256: digest(SOURCE_COMMENT) },
          setup: [],
        }
      : JSON.parse(io.read(path));
  const cache = join(options.source, '.mango/turbo-snapshot');
  const spec = (label: string, argv: string[]): CommandSpec => ({
    label,
    argv,
    cwd: options.source,
    env: { TURBO_TELEMETRY_DISABLED: '1' },
    timeoutMs: 20 * 60 * 1000,
  });
  const checked = async (label: string, argv: string[]): Promise<CommandSample> => {
    const sample = await io.run(spec(label, argv));
    receipt.setup.push(sample);
    assertSuccessfulSample(sample);
    return sample;
  };
  const verifySource = async (): Promise<void> => {
    const head = await checked('source-head', ['git', 'rev-parse', 'HEAD']);
    const status = await checked('source-status', [
      'git',
      'status',
      '--porcelain',
      '--untracked-files=no',
    ]);
    const original = await checked('source-original', ['git', 'show', `HEAD:${COMMENT_PATH}`]);
    const current = io.read(join(options.source, COMMENT_PATH));
    assertFixture(head.stdout, status.stdout, original.stdout, current, options.phase);
    receipt.comment.baseSha256 = digest(original.stdout);
    receipt.comment.fixtureSha256 = digest(current);
  };
  const turbo = join(options.source, 'node_modules/.bin/turbo');
  const turboArgs = [turbo, 'run', 'typecheck', '--cache=local:rw', `--cache-dir=${cache}`];
  try {
    if (action === 'prepare') {
      if (io.files(cache).length !== 0)
        throw new Error('Invalid preexisting private cache; expected empty fresh-job directory');
      await verifySourceForPreparation(options, io, checked);
      const bun = await checked('bun-version', ['bun', '--version']);
      if (bun.stdout.trim() !== '1.4.2')
        throw new Error(`Invalid Bun ${bun.stdout}; expected 1.4.2`);
      await checked('frozen-install', ['bun', 'install', '--frozen-lockfile']);
      const turboVersion = await checked('turbo-version', [turbo, '--version']);
      const ts = await checked('typescript-version', [
        'bun',
        'node_modules/typescript/bin/tsc',
        '--version',
      ]);
      if (turboVersion.stdout.trim() !== '2.11.6' || ts.stdout.trim() !== 'Version 7.0.2')
        throw new Error(
          `Invalid Turbo/TypeScript ${turboVersion.stdout}/${ts.stdout}; expected 2.11.6/Version 7.0.2`
        );
      receipt.identity = Object.fromEntries(
        IDENTITY_FILES.map((file) => [file, digest(io.read(join(options.source, file)))])
      );
      Object.assign(receipt.identity, {
        source: SNAPSHOT_SOURCE,
        bun: bun.stdout.trim(),
        turbo: turboVersion.stdout.trim(),
        typescript: ts.stdout.trim(),
        platform: process.platform,
        arch: process.arch,
        comment: digest(SOURCE_COMMENT),
        harnessScript: digest(io.read(import.meta.path)),
        subprocessHelper: digest(io.read(join(import.meta.dir, 'cargo-feature-measurement.ts'))),
        harnessWorkflow: digest(
          io.read(join(import.meta.dir, '../../.github/workflows/protocol-ci.yml'))
        ),
      });
      const before = await checked('baseline-dry', [...turboArgs, '--dry=json']);
      receipt.baseline = JSON.parse(before.stdout);
      realTasks(receipt.baseline as TurboSummary);
      if (options.phase !== 'prime')
        io.write(
          join(options.source, COMMENT_PATH),
          io.read(join(options.source, COMMENT_PATH)) + SOURCE_COMMENT
        );
      await verifySource();
      const fixture = await checked('fixture-dry', [...turboArgs, '--dry=json']);
      receipt.fixture = JSON.parse(fixture.stdout);
      realTasks(receipt.fixture as TurboSummary);
      receipt.keys = snapshotKeys(options, receipt.identity);
      io.output({
        key: receipt.keys.restore,
        save_key: receipt.keys.save,
        restore_prefix: receipt.keys.restorePrefix,
      });
    } else if (action === 'measure') {
      await verifySource();
      receipt.restored = io.files(cache);
      receipt.sample = await io.run(spec('real-typechecks', [...turboArgs, '--summarize']));
      // Even failed runs retain the subprocess sample and raw output before
      // rejecting a missing summary or incomplete compiler execution.
      io.write(path, snapshotJson(receipt));
      const summary = io.summary(options.source);
      io.write(join(options.output, 'turbo-summary.json'), summary);
      receipt.summary = JSON.parse(summary);
      assertTaskResults(receipt);
      await verifySource();
    } else if (action === 'cap') {
      const allowed = allowedLogs(receipt);
      receipt.payload = boundPayload(io.files(cache), allowed);
      for (const hash of new Set(receipt.payload.files.map((file) => file.name.slice(0, 16)))) {
        const manifest = JSON.parse(io.read(join(cache, `${hash}-manifest.json`))) as {
          files: Record<string, { is_dir: boolean }>;
          order: string[];
        };
        const meta = JSON.parse(io.read(join(cache, `${hash}-meta.json`))) as {
          hash: string;
          sha: string;
        };
        const listing = await io.archive(join(cache, `${hash}.tar.zst`));
        if (
          meta.hash !== hash ||
          meta.sha !== SNAPSHOT_SOURCE ||
          JSON.stringify(Object.keys(manifest.files)) !== JSON.stringify([allowed[hash]]) ||
          JSON.stringify(manifest.order) !== JSON.stringify([allowed[hash]]) ||
          manifest.files[allowed[hash]].is_dir ||
          JSON.stringify(listing) !== JSON.stringify([allowed[hash]])
        )
          throw new Error(
            `Invalid cache contents for ${hash}; expected only ${allowed[hash]} at source ${SNAPSHOT_SOURCE}`
          );
      }
      for (const task of realTasks(receipt.fixture as TurboSummary)) {
        if (!receipt.payload.files.some((file) => file.name === `${task.hash}.tar.zst`))
          throw new Error(
            `Invalid missing receipt ${task.hash}; expected every actual typecheck archive`
          );
      }
      io.output({ bounded: 'true', bytes: String(receipt.payload.conservativeArchiveBytes) });
    } else {
      throw new Error(`Invalid snapshot command ${action}; expected prepare, measure or cap`);
    }
  } catch (caught) {
    receipt.error = caught instanceof Error ? caught.message : String(caught);
    io.write(path, snapshotJson(receipt));
    throw caught;
  }
  io.write(path, snapshotJson(receipt));
  return receipt;
}

/** Check the clean base before setup or comment insertion. @example await verifySourceForPreparation(options, io, checked); */
export async function verifySourceForPreparation(
  options: SnapshotOptions,
  io: SnapshotIo,
  checked: (label: string, argv: string[]) => Promise<CommandSample>
): Promise<void> {
  const head = await checked('initial-head', ['git', 'rev-parse', 'HEAD']);
  const status = await checked('initial-status', [
    'git',
    'status',
    '--porcelain',
    '--untracked-files=no',
  ]);
  const original = await checked('initial-original', ['git', 'show', `HEAD:${COMMENT_PATH}`]);
  assertFixture(
    head.stdout,
    status.stdout,
    original.stdout,
    io.read(join(options.source, COMMENT_PATH)),
    'prime'
  );
}

/** Retain action outcomes without upgrading missing, failed or canceled legs to complete. @example finishSnapshot(receipt, outcomes); */
export function finishSnapshot(
  receipt: SnapshotReceipt,
  actions: Record<string, string>
): SnapshotReceipt {
  receipt.actions = actions;
  try {
    assertTaskResults(receipt);
    const expectedKey =
      receipt.options.phase === 'prime'
        ? ''
        : receipt.options.variant === 'baseline' || receipt.options.phase === 'change'
          ? receipt.keys.k0
          : receipt.keys.k1;
    const exact =
      receipt.options.phase !== 'prime' &&
      !(receipt.options.variant === 'candidate' && receipt.options.phase === 'change');
    if (
      !receipt.payload ||
      receipt.error ||
      ['prepare', 'restore', 'measure', 'cap'].some((key) => actions[key] !== 'success') ||
      actions.save !== (receipt.options.phase === 'replay' ? 'skipped' : 'success') ||
      (actions.matched ?? '') !== expectedKey ||
      (actions.hit === 'true') !== exact ||
      (receipt.options.phase === 'prime' && receipt.restored?.length !== 0)
    )
      throw new Error(
        `Invalid action outcomes ${JSON.stringify(actions)}; expected successful bounded steps and outer key ${expectedKey || '(miss)'}`
      );
    receipt.localComplete = true;
  } catch (caught) {
    receipt.localComplete = false;
    receipt.error = caught instanceof Error ? caught.message : String(caught);
  }
  return receipt;
}

export interface HostedJob {
  name: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  steps: {
    name: string;
    conclusion: string | null;
    started_at: string | null;
    completed_at: string | null;
  }[];
}

export interface HostedCache {
  id: number;
  key: string;
  ref: string;
  version: string;
  size_in_bytes: number;
  created_at: string;
  last_accessed_at: string;
}

/** Compare all six jobs; a missing leg or inconsistent hash prevents a persistence claim. @example compareSnapshots(receipts, jobs); */
export function compareSnapshots(
  receipts: SnapshotReceipt[],
  jobs: HostedJob[]
): { status: 'complete' | 'incomplete'; errors: string[]; timings: unknown[] } {
  const errors: string[] = [];
  const timings: unknown[] = [];
  let identity: string | undefined;
  const signatures = new Map<string, string>();
  for (const variant of ['baseline', 'candidate'] as const) {
    let prime: SnapshotReceipt | undefined;
    let changed: SnapshotReceipt | undefined;
    for (const phase of ['prime', 'change', 'replay'] as const) {
      const matches = receipts.filter(
        (receipt) => receipt.options.phase === phase && receipt.options.variant === variant
      );
      const name = `Turbo snapshot (${phase} / ${variant})`;
      const jobMatches = jobs.filter((job) => job.name === name);
      const receipt = matches[0];
      const job = jobMatches[0];
      if (
        matches.length !== 1 ||
        jobMatches.length !== 1 ||
        !receipt?.localComplete ||
        job?.conclusion !== 'success' ||
        !job.started_at ||
        !job.completed_at
      ) {
        errors.push(
          `Incomplete ${name}; expected one complete receipt and one successful hosted job`
        );
        continue;
      }
      try {
        assertTaskResults(receipt);
        const currentIdentity = JSON.stringify(receipt.identity);
        identity ??= currentIdentity;
        if (identity !== currentIdentity)
          throw new Error(`Identity drift in ${name}; expected identical source/config/lock/tools`);
        const signature = JSON.stringify(
          realTasks(receipt.summary as TurboSummary)
            .map((task) => [task.taskId, task.hash])
            .sort()
        );
        const expectedSignature = signatures.get(phase);
        if (expectedSignature && signature !== expectedSignature)
          throw new Error(`Hash drift in ${name}; expected identical cross-arm task hashes`);
        signatures.set(phase, signature);
        if (phase === 'prime') prime = receipt;
        if (phase === 'change') changed = receipt;
        if (phase !== 'prime') {
          const saved = phase === 'replay' && variant === 'candidate' ? changed : prime;
          if (
            !saved?.payload ||
            JSON.stringify(saved.payload.files) !== JSON.stringify(receipt.restored)
          )
            throw new Error(
              `Snapshot drift in ${name}; expected byte-identical ${phase === 'replay' && variant === 'candidate' ? 'K1' : 'K0'} cache files`
            );
        }
        if (
          phase === 'replay' &&
          changed &&
          JSON.stringify(
            realTasks(changed.summary as TurboSummary)
              .map((task) => [task.taskId, task.hash])
              .sort()
          ) !== signature
        )
          throw new Error(
            `Replay hash drift in ${name}; expected the same comment bytes/task hashes as change`
          );
        const wall = Date.parse(job.completed_at) - Date.parse(job.started_at);
        if (!Number.isFinite(wall) || wall < 0)
          throw new Error(`Invalid hosted job wall ${wall}; expected nonnegative timestamps`);
        const cacheSteps = job.steps.filter((step) =>
          ['Restore private snapshot', 'Save bounded private snapshot'].includes(step.name)
        );
        if (
          cacheSteps.length !== 2 ||
          cacheSteps.some(
            (step) =>
              step.conclusion !==
                (step.name.startsWith('Save') && phase === 'replay' ? 'skipped' : 'success') ||
              (step.conclusion !== 'skipped' &&
                (!step.started_at ||
                  !step.completed_at ||
                  !Number.isFinite(Date.parse(step.completed_at) - Date.parse(step.started_at)) ||
                  Date.parse(step.completed_at) < Date.parse(step.started_at)))
          )
        )
          throw new Error(
            `Incomplete cache action timings in ${name}; expected successful restore/save steps with timestamps, or the planned replay save skip`
          );
        timings.push({
          name,
          jobWallMs: wall,
          turboProcessWallMs: receipt.sample?.wallMs,
          taskExecutions: realTasks(receipt.summary as TurboSummary).map((task) => ({
            taskId: task.taskId,
            hash: task.hash,
            cache: task.cache,
            execution: task.execution,
          })),
          untimedSetupAndVerificationSamples: receipt.setup
            .filter((sample) => sample.label !== 'real-typechecks')
            .map((sample) => ({ label: sample.label, wallMs: sample.wallMs })),
          cacheActionSteps: cacheSteps.map((step) => ({
            ...step,
            wallMs:
              step.started_at && step.completed_at
                ? Date.parse(step.completed_at) - Date.parse(step.started_at)
                : null,
          })),
        });
      } catch (caught) {
        errors.push(caught instanceof Error ? caught.message : String(caught));
      }
    }
  }
  return { status: errors.length === 0 ? 'complete' : 'incomplete', errors, timings };
}

/** Read only regular, immediate cache files; reject symlinks and directories before save. @example cacheFiles('/source/.mango/turbo-snapshot'); */
export function cacheFiles(path: string): PayloadEntry[] {
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .sort()
    .map((name) => {
      const file = join(path, name);
      const stat = lstatSync(file);
      return {
        name,
        bytes: stat.size,
        regular: stat.isFile(),
        sha256: stat.isFile() ? digest(readFileSync(file)) : '',
      };
    });
}

/** A fresh job must produce exactly one native Turbo summary; retain its full JSON. @example readTurboSummary('/source'); */
export function readTurboSummary(source: string): string {
  const directory = join(source, '.turbo/runs');
  const files = existsSync(directory)
    ? readdirSync(directory).filter((name) => name.endsWith('.json'))
    : [];
  if (files.length !== 1)
    throw new Error(
      `Invalid Turbo summary count ${files.length}; expected one generated summary in a fresh source job`
    );
  return readFileSync(join(directory, files[0]), 'utf8');
}

/** Inspect bounded Zstandard tar bytes in memory without an external zstd executable or extraction. @example await archiveLogs('/cache/hash.tar.zst'); */
export async function archiveLogs(path: string): Promise<string[]> {
  const tar = zstdDecompressSync(readFileSync(path), { maxOutputLength: MAX_PAYLOAD_BYTES });
  return [...(await new Bun.Archive(tar).files()).keys()];
}

/** Stage measurements and forward termination to the shared subprocess supervisor. @example hostSnapshotIo(options, signal); */
export function hostSnapshotIo(options: SnapshotOptions, signal: AbortSignal): SnapshotIo {
  mkdirSync(options.output, { recursive: true });
  return {
    read: (path) => readFileSync(path, 'utf8'),
    write: (path, content) => writeFileSync(path, content),
    files: cacheFiles,
    summary: readTurboSummary,
    archive: archiveLogs,
    run: (spec) => runMeasuredCommand(spec, options.output, signal),
    output: (values) => {
      const target = process.env.GITHUB_OUTPUT;
      if (target)
        appendFileSync(
          target,
          Object.entries(values)
            .map(([key, value]) => `${key}=${value}\n`)
            .join('')
        );
    },
  };
}

/** Paginate read-only job metadata for this exact run attempt. @example await hostedJobs(env, fetch); */
export async function hostedJobs(
  env: Record<string, string | undefined>,
  request: typeof fetch
): Promise<HostedJob[]> {
  const { runId, attempt } = snapshotOptions({
    ...env,
    SNAPSHOT_PHASE: 'prime',
    SNAPSHOT_VARIANT: 'baseline',
  });
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? '') || !env.GITHUB_TOKEN)
    throw new Error(
      `Invalid hosted API identity ${env.GITHUB_REPOSITORY}; expected owner/repo and a read-only token`
    );
  const jobs: HostedJob[] = [];
  for (let page = 1; ; page++) {
    const response = await request(
      `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
        },
        signal: AbortSignal.timeout(30_000),
      }
    );
    if (!response.ok)
      throw new Error(`Invalid job metadata HTTP ${response.status}; expected a successful read`);
    const body = (await response.json()) as { jobs: HostedJob[] };
    if (!Array.isArray(body.jobs))
      throw new Error('Invalid job metadata body; expected jobs array');
    jobs.push(...body.jobs);
    if (body.jobs.length < 100) return jobs;
  }
}

/** Read only run-private cache identities and enforce the actual hosted size cap. @example await hostedCaches(env, receipts, fetch); */
export async function hostedCaches(
  env: Record<string, string | undefined>,
  receipts: SnapshotReceipt[],
  request: typeof fetch
): Promise<HostedCache[]> {
  const saved = receipts.filter(
    (receipt) =>
      receipt.options.phase === 'prime' ||
      (receipt.options.phase === 'change' && receipt.options.variant === 'candidate')
  );
  const expected = new Set(saved.map((receipt) => receipt.keys.save));
  if (
    expected.size !== 3 ||
    saved.length !== 3 ||
    !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? '') ||
    !env.GITHUB_TOKEN
  )
    throw new Error(
      'Invalid hosted cache identities; expected two K0 keys, candidate K1, owner/repo and a read-only token'
    );
  const caches: HostedCache[] = [];
  for (const prefix of new Set(saved.map((receipt) => receipt.keys.prefix))) {
    for (let page = 1; ; page++) {
      const response = await request(
        `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/caches?key=${encodeURIComponent(prefix)}&ref=refs%2Fheads%2Fmeasure%2Fturbo-snapshot-cache&per_page=100&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
          },
          signal: AbortSignal.timeout(30_000),
        }
      );
      if (!response.ok)
        throw new Error(
          `Invalid cache metadata HTTP ${response.status}; expected a successful read`
        );
      const body = (await response.json()) as { actions_caches: HostedCache[] };
      if (!Array.isArray(body.actions_caches))
        throw new Error('Invalid cache metadata body; expected actions_caches array');
      caches.push(...body.actions_caches);
      if (body.actions_caches.length < 100) break;
    }
  }
  if (
    caches.length !== 3 ||
    new Set(caches.map((cache) => cache.key)).size !== 3 ||
    new Set(caches.map((cache) => cache.version)).size !== 1 ||
    caches.some(
      (cache) =>
        !expected.has(cache.key) ||
        !Number.isSafeInteger(cache.id) ||
        cache.id <= 0 ||
        cache.ref !== 'refs/heads/measure/turbo-snapshot-cache' ||
        !cache.version ||
        !Number.isSafeInteger(cache.size_in_bytes) ||
        cache.size_in_bytes <= 0 ||
        cache.size_in_bytes > MAX_PAYLOAD_BYTES
    )
  )
    throw new Error(
      `Invalid hosted cache inventory ${JSON.stringify(caches)}; expected exactly three private keys, one archive version and positive payload sizes <= ${MAX_PAYLOAD_BYTES}`
    );
  return caches;
}

/** Dependency-free CLI entrypoint; hosted collection never hides failed or absent legs. @example await snapshotMain(['collect'], process.env); */
export async function snapshotMain(
  args: string[],
  env: Record<string, string | undefined>,
  request: typeof fetch = fetch
): Promise<void> {
  const action = args[0];
  if (action === 'collect') {
    const output = resolve(env.SNAPSHOT_OUTPUT ?? 'collected-summary');
    mkdirSync(output, { recursive: true });
    let jobs: HostedJob[] = [];
    let caches: HostedCache[] = [];
    const receipts: SnapshotReceipt[] = [];
    const errors: string[] = [];
    try {
      const input = resolve(env.SNAPSHOT_INPUT ?? 'collected');
      for (const name of readdirSync(input).sort()) {
        const path = join(input, name, 'receipt.json');
        if (existsSync(path)) receipts.push(JSON.parse(readFileSync(path, 'utf8')));
      }
      jobs = await hostedJobs(env, request);
      caches = await hostedCaches(env, receipts, request);
    } catch (caught) {
      errors.push(caught instanceof Error ? caught.message : String(caught));
    }
    const comparison = compareSnapshots(receipts, jobs);
    if (errors.length) {
      comparison.status = 'incomplete';
      comparison.errors.push(...errors);
    }
    writeFileSync(
      join(output, 'comparison.json'),
      snapshotJson({ ...comparison, receipts, jobs, caches })
    );
    if (comparison.status !== 'complete') throw new Error(comparison.errors.join('\n'));
    return;
  }
  const options = snapshotOptions(env);
  if (action === 'finish') {
    const path = join(options.output, 'receipt.json');
    const actions = Object.fromEntries(
      ['prepare', 'restore', 'measure', 'cap', 'save', 'hit', 'matched'].map((key) => [
        key,
        env[`SNAPSHOT_${key.toUpperCase()}`] ?? '',
      ])
    );
    const receipt = finishSnapshot(JSON.parse(readFileSync(path, 'utf8')), actions);
    writeFileSync(path, snapshotJson(receipt));
    if (!receipt.localComplete) throw new Error(receipt.error ?? 'Incomplete snapshot receipt');
    return;
  }
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  process.on('SIGTERM', cancel);
  process.on('SIGINT', cancel);
  try {
    await snapshotCommand(action ?? '', options, hostSnapshotIo(options, controller.signal));
  } finally {
    process.off('SIGTERM', cancel);
    process.off('SIGINT', cancel);
  }
}

if (import.meta.main) {
  try {
    await snapshotMain(Bun.argv.slice(2), process.env);
  } catch (caught) {
    console.error(caught instanceof Error ? caught.message : String(caught));
    process.exitCode = 1;
  }
}
