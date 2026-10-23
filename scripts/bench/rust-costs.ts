#!/usr/bin/env bun
/**
 * Records a current-source Rust baseline without selecting an optimization candidate.
 * Defaults to printing the frozen schedule. Execution needs a clean tree and an exclusive host.
 * Example: bun scripts/bench/rust-costs.ts --execute --out /tmp/rust-cost-receipts
 */
import { mkdir, readFile, rm } from 'node:fs/promises';
import { arch, cpus, homedir, platform, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { assertNoUnexpectedArguments, fatal, parseArgs } from '../lib/args';
import { benchmarkCancellation } from '../lib/benchmark-cancellation';
import { appendBenchmarkJournal, writeBenchmarkProgress } from '../lib/benchmark-journal';
import {
  type NativeCommandReceipt,
  runNativeCommand,
} from '../lib/native-bun-qualification-process';
import { linuxProcessResourceUnits, readLinuxProcessResources } from '../lib/process-resource-host';
import {
  type ProcessResourceSummary,
  ProcessResourceTracker,
} from '../lib/process-resource-sample';
import {
  attributeRustArtifact,
  identifyRustArtifactVersion,
  inspectRustArtifact,
  preserveRustArtifact,
  type RustArtifactReceipt,
  rustLibraryHashes,
} from '../lib/rust-artifact-receipt';
import {
  parseBuildCpu,
  qualifiesRustIncremental,
  rustCostWorkloads,
  shippingRustProfile,
  summarizeRustCosts,
} from '../lib/rust-cost-receipt';
import { homeEnv } from '../lib/temp-home';
import { sha256File } from '../release/verify-checksum';

const ROOT = resolve(import.meta.dir, '../..');
const TARGET = 'x86_64-unknown-linux-gnu';
const JOBS = 8;
const BUDGET_BYTES = 40 * 2 ** 30;
const BATCH_SECONDS = 3 * 60 * 60;
const POLL_MS = 20;
class DiscardedInspectionOutput extends Writable {
  override _write(_chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    done();
  }
}

function syncText(command: readonly string[]): string {
  const result = Bun.spawnSync([...command], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0)
    throw new Error(
      `${command.join(' ')}: expected exit 0 | received: ${result.exitCode}: ${result.stderr.toString()}`
    );
  return result.stdout.toString().trim();
}

async function sourceSeal(): Promise<string> {
  const names = syncText([
    'git',
    'ls-files',
    'Cargo.toml',
    'Cargo.lock',
    'rust-toolchain.toml',
    '.cargo',
    'crates',
    'scripts/bench',
    'scripts/lib',
  ])
    .split('\n')
    .filter(Boolean);
  const hasher = new Bun.CryptoHasher('sha256');
  for (const name of names) {
    hasher.update(`${name}\0`);
    hasher.update(await Bun.file(join(ROOT, name)).arrayBuffer());
  }
  const cargoHome = process.env.CARGO_HOME || join(homedir(), '.cargo');
  for (const name of ['config', 'config.toml']) {
    const file = Bun.file(join(cargoHome, name));
    hasher.update(`external-cargo-config/${name}\0`);
    hasher.update((await file.exists()) ? await file.arrayBuffer() : 'absent');
  }
  return hasher.digest('hex');
}

function allocatedBytes(path: string): number {
  return Number(syncText(['du', '-s', '-B1', path]).split(/\s/)[0]);
}

function successful(command: NativeCommandReceipt): boolean {
  return (
    command.exitCode === 0 &&
    !command.timedOut &&
    !command.canceled &&
    command.signal === null &&
    command.errors.length === 0 &&
    command.settlement.empty &&
    !command.settlement.pollErrors?.length
  );
}

async function main(): Promise<void> {
  const { flags, values, positional } = parseArgs({
    booleanFlags: ['--execute', '--attribution'],
    valueFlags: ['--out', '--startup-hub'],
  });
  assertNoUnexpectedArguments(positional);
  if (flags['--help']) {
    console.log(
      'Usage: bun scripts/bench/rust-costs.ts [--execute --out DIR] [--attribution] [--startup-hub COMPILED_HUB]\nWithout --execute, print the fixed schedule only. Run after exclusive-host authorization.'
    );
    return;
  }
  const version = (await Bun.file(join(ROOT, 'package.json')).json()).version as string;
  const workloads = rustCostWorkloads(version);
  const profileArgs = shippingRustProfile(await Bun.file(join(ROOT, 'Cargo.toml')).text());
  const schedule = {
    target: TARGET,
    jobs: JOBS,
    budgetBytes: BUDGET_BYTES,
    batchTimeoutSeconds: BATCH_SECONDS,
    pollIntervalMs: POLL_MS,
    workloads,
    startup: {
      warmups: 2,
      measured: 20,
      modes: ['runtime-hello-health', 'hub-fresh-database', 'hub-migrated-database'],
    },
    profile: 'repository shipping profile: opt3/fat LTO/one CGU/stripped/unwind',
    cache: 'retained registry/toolchain; empty target per clean trial; OS page cache uncontrolled',
    attributionRequested: flags['--attribution'] ?? false,
    startupRequested: Boolean(values['--startup-hub']),
    comparison: 'repeated baseline only; no optimization candidate or savings delta',
  };
  if (!flags['--execute']) {
    console.log(JSON.stringify(schedule, null, 2));
    return;
  }
  if (process.platform !== 'linux' || process.arch !== 'x64')
    fatal(`Rust baseline host: expected Linux x64 | received: ${process.platform} ${process.arch}`);
  if (!values['--out']) fatal('--out: expected a fresh receipt directory for an executable batch');
  if (syncText(['git', 'status', '--porcelain']))
    fatal(
      'Rust baseline source: expected a clean committed worktree | received: uncommitted changes'
    );
  const forbidden = Object.keys(process.env)
    .filter(
      (name) =>
        name.startsWith('CARGO_PROFILE_') ||
        name.endsWith('_RUSTFLAGS') ||
        [
          'RUSTFLAGS',
          'CARGO_ENCODED_RUSTFLAGS',
          'RUSTC_WRAPPER',
          'RUSTC_WORKSPACE_WRAPPER',
          'CARGO_BUILD_TARGET',
          'CARGO_TARGET_DIR',
          'RUSTC',
        ].includes(name)
    )
    .filter((name) => process.env[name]);
  if (forbidden.length)
    fatal(
      `Rust baseline environment: expected repository profile and compiler | received override names: ${forbidden.join(', ')}`
    );
  const out = resolve(values['--out']);
  await mkdir(out); // Never overwrite an earlier complete or failed batch.
  const targetRoot = join(ROOT, 'target', `rust-cost-baseline-${Date.now()}`);
  await mkdir(targetRoot, { recursive: true });
  const marker = join(targetRoot, '.rust-cost-baseline-owner');
  await Bun.write(marker, out);
  const targetFileSystem = syncText(['stat', '-f', '-c', '%T', targetRoot]);
  if (targetFileSystem !== 'ext2/ext3')
    fatal(
      `Rust baseline target: expected private ext4 storage | received filesystem: ${targetFileSystem}`
    );
  const units = linuxProcessResourceUnits();
  const seal = await sourceSeal();
  const started = Date.now();
  const attempts: Array<{
    label: string;
    valid: boolean;
    durationMs: number;
    [name: string]: unknown;
  }> = [];
  const rustc = syncText(['rustc', '-Vv']);
  const pinnedToolchain = (await Bun.file(join(ROOT, 'rust-toolchain.toml')).text()).match(
    /channel\s*=\s*"([^"]+)"/
  )?.[1];
  if (!pinnedToolchain || !rustc.startsWith(`rustc ${pinnedToolchain} `))
    fatal(
      `Rust baseline compiler: expected pinned ${pinnedToolchain} | received: ${rustc.split('\n')[0]}`
    );
  const cargoHome = process.env.CARGO_HOME || join(homedir(), '.cargo');
  const cargoConfigHashes: Record<string, string> = {};
  for (const name of ['config', 'config.toml']) {
    const path = join(cargoHome, name);
    if (await Bun.file(path).exists()) cargoConfigHashes[path] = await sha256File(path);
  }
  const environment = {
    inputSealScope:
      'tracked Rust/Cargo/toolchain/config plus benchmark scripts and shared script helpers',
    sourceHead: syncText(['git', 'rev-parse', 'HEAD']),
    sourceSeal: seal,
    rustc,
    cargoConfigHashes,
    cargo: syncText(['cargo', '-V']),
    bun: Bun.version,
    host: `${platform()} ${release()} ${arch()}`,
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    totalMemoryBytes: totalmem(),
    resourceUnits: units,
    targetRoot,
    targetFileSystem,
    diskBudgetEnforcement:
      'allocated bytes checked between attempts; excludes Cargo registry/toolchain caches',
  };
  const save = (failure: string | null, complete = false) =>
    writeBenchmarkProgress(join(out, 'receipt.json'), {
      schedule,
      environment,
      complete,
      completeScope: 'requested workloads only',
      unperformed: [
        ...(!flags['--attribution'] ? ['symbol-attribution'] : []),
        ...(!values['--startup-hub'] ? schedule.startup.modes : []),
        'native Windows',
        'native macOS',
      ],
      failure,
      attempts,
      summariesMs: summarizeRustCosts(attempts),
    });
  const cancellation = benchmarkCancellation();
  let commandIndex = 0;
  const capture = async (
    label: string,
    command: readonly string[],
    env: NodeJS.ProcessEnv = process.env
  ): Promise<string> => {
    const name = `${++commandIndex}-${label}`;
    const result = await runNativeCommand({
      label: name,
      signal: cancellation.signal,
      command,
      root: ROOT,
      out,
      env: { ...env },
      timeoutSeconds: Math.max(1, Math.min(1800, BATCH_SECONDS - (Date.now() - started) / 1000)),
      stream: new DiscardedInspectionOutput(),
    });
    await Bun.write(join(out, `${name}.json`), JSON.stringify(result, null, 2));
    if (!successful(result))
      throw new Error(
        `${label}: expected successful settled command | received: ${JSON.stringify(result)}`
      );
    return readFile(join(out, `logs/${name}.stdout.log`), 'utf8');
  };
  const inspector = { capture, hash: sha256File };
  const checkBudget = async () => {
    const targetAllocatedBytes = await allocatedBytes(targetRoot);
    const receiptAllocatedBytes = await allocatedBytes(out);
    const bytes = targetAllocatedBytes + receiptAllocatedBytes;
    if (bytes > BUDGET_BYTES)
      throw new Error(
        `Rust study disk: expected <= ${BUDGET_BYTES} allocated bytes at attempt boundary | received: ${bytes}`
      );
    if (Date.now() - started > BATCH_SECONDS * 1000)
      throw new Error('Rust study: expected completion within fixed three-hour batch');
    return { targetAllocatedBytes, receiptAllocatedBytes, combinedAllocatedBytes: bytes };
  };
  const removeTarget = async (target: string) => {
    if ((await readFile(marker, 'utf8')) !== out || !target.startsWith(`${targetRoot}/`))
      throw new Error(`Rust target cleanup: expected marked private target | received: ${target}`);
    await rm(target, { recursive: true, force: true });
  };
  const measured = new Map<string, RustArtifactReceipt>();
  let priorRuntimeHash: string | undefined;
  try {
    await save(null);
    for (const [label, command] of [
      ['metadata-default', ['cargo', 'metadata', '--format-version', '1', '--locked']],
      [
        'metadata-all-features',
        ['cargo', 'metadata', '--format-version', '1', '--all-features', '--locked'],
      ],
      [
        'metadata-fuzz',
        [
          'cargo',
          'metadata',
          '--format-version',
          '1',
          '--manifest-path',
          'crates/mango-protocol/fuzz/Cargo.toml',
          '--all-features',
          '--locked',
        ],
      ],
      [
        'tree-all-targets',
        [
          'cargo',
          'tree',
          '--workspace',
          '--all-features',
          '--target',
          'all',
          '--edges',
          'normal,build,dev',
          '--locked',
        ],
      ],
    ] as const)
      await Bun.write(
        join(out, `${label}.${label.startsWith('tree') ? 'txt' : 'json'}`),
        await capture(label, command)
      );
    for (const workload of workloads) {
      if (cancellation.signal.aborted) throw cancellation.signal.reason;
      await checkBudget();
      if ((await sourceSeal()) !== seal)
        throw new Error('Rust study source: expected unchanged Rust/Cargo seal before attempt');
      const targetDir = join(targetRoot, workload.target);
      const attemptOut = join(out, workload.label);
      await mkdir(attemptOut);
      if (workload.emptyTarget && (await Bun.file(join(targetDir, '.started')).exists()))
        throw new Error(`Empty build: expected unused target | received: ${targetDir}`);
      await mkdir(targetDir, { recursive: true });
      await Bun.write(join(targetDir, '.started'), workload.label);
      const beforeLibraries = workload.emptyTarget
        ? null
        : await rustLibraryHashes(join(targetDir, TARGET, 'release/deps'));
      const cpuPath = join(attemptOut, 'gnu-time.txt');
      const env = {
        ...process.env,
        CARGO_TARGET_DIR: targetDir,
        CARGO_BUILD_JOBS: String(JOBS),
        MANGOSTUDIO_RELEASE_VERSION: workload.stamp,
      };
      const resourceState: { tracker?: ProcessResourceTracker } = {};
      const clock = performance.now();
      await appendBenchmarkJournal(join(out, 'attempts.jsonl'), {
        kind: 'started',
        workload,
        sourceSeal: seal,
        at: new Date().toISOString(),
      });
      const result = await runNativeCommand({
        label: workload.label,
        signal: cancellation.signal,
        command: [
          '/usr/bin/time',
          '-f',
          '%U %S %M %e',
          '-o',
          cpuPath,
          'cargo',
          'build',
          ...profileArgs,
          '--release',
          '--locked',
          '--target',
          TARGET,
          '-j',
          String(JOBS),
          '-p',
          workload.package,
          '--message-format=json',
        ],
        root: ROOT,
        out: attemptOut,
        env,
        timeoutSeconds: Math.max(1, Math.min(1800, BATCH_SECONDS - (Date.now() - started) / 1000)),
        pollIntervalMs: POLL_MS,
        snapshot: async () => {
          const rows = await readLinuxProcessResources(units.pageBytes);
          const root = rows.find(
            (row) =>
              row.parentPid === process.pid && row.group === row.pid && row.command === 'time'
          );
          if (!resourceState.tracker && root)
            resourceState.tracker = new ProcessResourceTracker(root);
          resourceState.tracker?.observe({ atMs: performance.now() - clock, processes: rows });
          return rows.map((row) => ({
            pid: row.pid,
            parentPid: row.parentPid,
            group: row.group,
            identity: `${row.pid}:${row.startTicks}`,
            command: row.command,
          }));
        },
      });
      const resources: ProcessResourceSummary | null =
        resourceState.tracker?.summarize({
          ticksPerSecond: units.ticksPerSecond,
          omitRootFromMetrics: true,
        }) ?? null;
      let valid =
        successful(result) &&
        resources !== null &&
        resources.sampleCount > 0 &&
        resources.remainingIdentities.length === 0 &&
        (await sourceSeal()) === seal;
      const attempt: {
        label: string;
        valid: boolean;
        durationMs: number;
        [name: string]: unknown;
      } = {
        label: workload.label,
        valid: false,
        durationMs: result.durationMs,
        workload,
        status: result.canceled ? 'canceled' : successful(result) ? 'completed' : 'failed',
        command: result,
        resources,
        resourceIntervalMs: POLL_MS,
      };
      attempts.push(attempt);
      await appendBenchmarkJournal(join(out, 'attempts.jsonl'), {
        kind: 'finished',
        ...attempt,
        at: new Date().toISOString(),
      });
      await save(null); // Keep terminal raw command even if inspection fails.
      if (!valid)
        throw new Error(
          `${workload.label}: expected successful, sampled, settled and source-sealed build`
        );
      const cpu = parseBuildCpu(await readFile(cpuPath, 'utf8'));
      attempt.cpu = cpu;
      attempt.supervisedCommandDurationMs = result.durationMs;
      attempt.durationMs = cpu.elapsedSeconds * 1000;
      attempt.wallTimeResolutionMs = 10;
      const binary = join(
        targetDir,
        TARGET,
        'release',
        workload.package === 'mangostudio' ? 'mangostudio' : 'mangostudio-runtime'
      );
      const kept = await preserveRustArtifact(binary, join(attemptOut, 'artifact'));
      const artifact = await inspectRustArtifact(
        kept.path,
        join(attemptOut, 'sections'),
        inspector
      );
      attempt.artifact = artifact;
      const versionHome = join(attemptOut, 'version-home');
      await mkdir(versionHome);
      const manifestPath = join(
        ROOT,
        'crates',
        workload.package === 'mangostudio' ? 'mangostudio-launcher' : 'mangostudio-runtime',
        'Cargo.toml'
      );
      const versionReceipt = await identifyRustArtifactVersion(
        workload.package,
        await Bun.file(manifestPath).text(),
        kept.path,
        workload.stamp,
        (command) =>
          capture(`${workload.label}-version`, command, {
            ...env,
            ...homeEnv(versionHome),
            MANGO_HOME: versionHome,
          })
      );
      attempt.version = versionReceipt;
      valid &&= versionReceipt.valid;
      const libraries = await rustLibraryHashes(join(targetDir, TARGET, 'release/deps'));
      attempt.libraryHashes = libraries;
      attempt.diskBeforeCleanup = await checkBudget();
      if (beforeLibraries) valid &&= JSON.stringify(beforeLibraries) === JSON.stringify(libraries);
      const messages = (
        await readFile(join(attemptOut, `logs/${workload.label}.stdout.log`), 'utf8')
      )
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const compiled = messages.filter(
        (message) => message.reason === 'compiler-artifact' && message.fresh === false
      );
      attempt.compiledUnits = compiled;
      if (workload.label.startsWith('runtime-noop'))
        valid &&= qualifiesRustIncremental('noop', priorRuntimeHash, kept.sha256, compiled.length);
      if (workload.label.startsWith('runtime-restamp'))
        valid &&= qualifiesRustIncremental(
          'restamp',
          priorRuntimeHash,
          kept.sha256,
          compiled.length
        );
      if (workload.package === 'mangostudio-runtime') priorRuntimeHash = kept.sha256;
      attempt.valid = valid;
      measured.set(workload.package, artifact);
      await save(valid ? null : `${workload.label}: workload invariant failed`);
      if (!valid)
        throw new Error(
          `${workload.label}: expected version, library and incremental workload invariants`
        );
      // Retain only the final runtime target for repeated builds and attribution.
      if (workload.emptyTarget && workload.target !== 'runtime-3') await removeTarget(targetDir);
      attempt.diskAfterCleanup = await checkBudget();
      await save(null);
    }
    if (flags['--attribution']) {
      const targetDir = join(targetRoot, 'runtime-3');
      const env = {
        ...process.env,
        CARGO_TARGET_DIR: targetDir,
        CARGO_BUILD_JOBS: String(JOBS),
        MANGOSTUDIO_RELEASE_VERSION: `${version}-bench.10`,
        CARGO_PROFILE_RELEASE_STRIP: 'none',
      };
      // cargo-bloat 0.12 accepts one --config, so use one explicit profile file.
      const attributionConfig = join(out, 'attribution-profile.toml');
      await Bun.write(
        attributionConfig,
        '[profile.release]\nopt-level = 3\nlto = "fat"\ncodegen-units = 1\nstrip = "none"\npanic = "unwind"\n'
      );
      const bloat = await capture(
        'attribution',
        [
          'cargo',
          'bloat',
          '--config',
          attributionConfig,
          '--release',
          '--locked',
          '-j',
          String(JOBS),
          '--target',
          TARGET,
          '--target-dir',
          targetDir,
          '-p',
          'mangostudio-runtime',
          '--crates',
          '--split-std',
          '-n',
          '0',
          '--message-format',
          'json',
        ],
        env
      );
      const symbols = await inspectRustArtifact(
        join(targetDir, TARGET, 'release/mangostudio-runtime'),
        join(out, 'symbols'),
        inspector
      );
      const runtime = measured.get('mangostudio-runtime');
      if (!runtime) throw new Error('Attribution: expected measured runtime artifact');
      await Bun.write(
        join(out, 'attribution.json'),
        JSON.stringify(attributeRustArtifact(runtime, symbols, bloat), null, 2)
      );
    }
    if (values['--startup-hub']) {
      const runtime = measured.get('mangostudio-runtime');
      if (!runtime) throw new Error('Startup study: expected the preserved measured runtime');
      const hub = resolve(values['--startup-hub']);
      const hubHash = await sha256File(hub);
      const startupCommands = [
        [
          'runtime-readiness',
          [
            'bun',
            'scripts/bench/runtime-handshake.ts',
            runtime.path,
            '--runs',
            '20',
            '--warmups',
            '2',
            '--resources',
            '--build',
            'host GNU shipping profile',
            '--json',
            '--output',
            join(out, 'runtime-readiness.json'),
            '--journal',
            join(out, 'runtime-readiness.jsonl'),
          ],
        ],
        [
          'hub-fresh-readiness',
          [
            'bun',
            'scripts/bench/startup.ts',
            hub,
            '--runs',
            '20',
            '--warmups',
            '2',
            '--resources',
            '--json',
            '--output',
            join(out, 'hub-fresh-readiness.json'),
            '--journal',
            join(out, 'hub-fresh-readiness.jsonl'),
          ],
        ],
        [
          'hub-migrated-readiness',
          [
            'bun',
            'scripts/bench/startup.ts',
            hub,
            '--runs',
            '20',
            '--warmups',
            '2',
            '--warm',
            '--resources',
            '--json',
            '--output',
            join(out, 'hub-migrated-readiness.json'),
            '--journal',
            join(out, 'hub-migrated-readiness.jsonl'),
          ],
        ],
      ] as const;
      for (const [label, command] of startupCommands) {
        const stdout = await capture(label, command);
        const receipt = JSON.parse(stdout) as { complete?: unknown };
        if (receipt.complete !== true)
          throw new Error(`${label}: expected complete readiness batch`);
        if (
          (await sha256File(hub)) !== hubHash ||
          (await sha256File(runtime.path)) !== runtime.sha256
        )
          throw new Error(`${label}: expected unchanged startup artifact identities`);
        await checkBudget();
      }
    }
    await checkBudget();
    if ((await sourceSeal()) !== seal)
      throw new Error('Rust study source: expected unchanged final Rust/Cargo seal');
    await save(null, true);
  } catch (error) {
    await save(String(error));
    process.exitCode = 1;
    console.error(String(error));
  } finally {
    cancellation.dispose();
  }
}

if (import.meta.main) await main();
