#!/usr/bin/env bun

/**
 * Measures how long a `mangostudio-runtime` child takes to become usable over
 * stdio: process start → `hello` → first answered request.
 *
 * The hub bounds exactly this with its handshake budget
 * (`apps/api/src/services/runtime-client/handshake-budget.ts`), and every
 * argument about that number has so far rested on a handful of CI log lines.
 * This spawns the real binary N times the way the hub does — the SDK launcher,
 * a hub `hello`, then `runtime.health` — and reports min / median / p95 / max
 * for each phase, plus the machine it ran on.
 *
 * Every run gets a fresh `MANGO_HOME`, so the slot is as new as a first
 * connect's; the developer's real `~/.mango` is never read or written.
 *
 * Usage:
 *   bun run scripts/bench/runtime-handshake.ts                       # newest target/ build
 *   bun run scripts/bench/runtime-handshake.ts <binary> --runs 30
 *   bun run scripts/bench/runtime-handshake.ts <binary> --fresh-copy # new file per run
 *
 * `--fresh-copy` runs a byte-identical copy at a new path each time. On Windows
 * that is what makes an antivirus scan and the loader's first look at a file
 * part of every sample — the cost a just-installed or just-upgraded runtime
 * pays once. It does not empty the OS page cache; nothing short of a reboot
 * (or `drop_caches` as root on Linux) does, so the first sample of a session is
 * reported separately and is the closest this gets to a cold disk.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';

import { Session } from '@mangostudio/protocol';
import { spawnPort } from '@mangostudio/protocol/spawn';
import {
  RUNTIME_CONTRACT_NAME,
  RUNTIME_CONTRACT_VERSION,
} from '@mangostudio/shared/runtime-contract';

import { assertNoUnexpectedArguments, fatal, parseArgs } from '../lib/args';
import { benchmarkCancellation, withBenchmarkCancellation } from '../lib/benchmark-cancellation';
import { appendBenchmarkJournal, writeBenchmarkProgress } from '../lib/benchmark-journal';
import { type LatencySummary, summarizeLatencies } from '../lib/latency-stats';
import { header, info, log } from '../lib/log';
import { linuxProcessResourceUnits, type ProcessResourceUnits } from '../lib/process-resource-host';
import {
  type ProcessResourceMonitor,
  type ProcessResourceObservation,
  startProcessResourceMonitor,
} from '../lib/process-resource-monitor';
import { homeEnv } from '../lib/temp-home';
import { sha256File } from '../release/verify-checksum';
import {
  BenchmarkChildScope,
  benchmarkResourceCleanupError,
  recordBenchmarkCleanup,
  settleBenchmarkWork,
} from './benchmark-child-scope';
import { runtimeVersion, RuntimeVersionError } from './runtime-version';

/** Far above any budget the hub uses, so a slow sample is measured, not refused. */
const HANDSHAKE_CEILING_MS = 120_000;
const REQUEST_TIMEOUT_MS = 60_000;
const EXE = process.platform === 'win32' ? '.exe' : '';
const REPO_ROOT = resolve(import.meta.dir, '../..');

interface RunSample {
  readonly status: 'success' | 'failed';
  readonly cleanupProven: boolean;
  readonly cleanupErrors: readonly string[];
  readonly failure: string | null;
  readonly resources: ProcessResourceObservation | null;
  /** Until the launcher returned with a process, in ms. */
  readonly spawnMs: number | null;
  /** Until the runtime's `hello` arrived and negotiated. */
  readonly helloMs: number | null;
  /** Until the first `runtime.health` answer — the child is usable. */
  readonly firstRequestMs: number | null;
  /** Until the first stderr byte, or null when the child wrote none before its answer. */
  readonly firstStderrMs: number | null;
}

function printHelp(): never {
  log(`Usage: bun run scripts/bench/runtime-handshake.ts [binary] [--runs N] [--fresh-copy] [--build LABEL] [--warmups N] [--resources] [--output file] [--json]

  [binary]      A mangostudio-runtime executable (default: newest of target/release, target/debug)
  --runs N      Measured runs (default 20)
  --fresh-copy  Run a new copy of the binary each time (first-execution cost)
  --build LABEL Build profile to report, for a binary outside target/ (e.g. a CI artifact)
  --warmups N   Labeled protocol warmups (default 2)
  --resources   Sample actual-child process-tree RSS/CPU through Linux procfs
  --journal file Append synced start/finish events (default: <output>.jsonl)
  --output file Save complete attempts, including failed batches
  --json        Print only the JSON result
  --help        Show this help message`);
  process.exit(0);
}

/** The newest cargo build of the runtime in this checkout, or undefined. */
async function newestWorkspaceBuild(): Promise<string | undefined> {
  const candidates = ['release', 'debug'].map((profile) =>
    join(REPO_ROOT, 'target', profile, `mangostudio-runtime${EXE}`)
  );
  let newest: { path: string; mtimeMs: number } | undefined;
  for (const path of candidates) {
    const info = await stat(path).catch(() => undefined);
    if (info && (!newest || info.mtimeMs > newest.mtimeMs))
      newest = { path, mtimeMs: info.mtimeMs };
  }
  return newest?.path;
}

async function measureOnce(
  binary: string,
  mangoHome: string,
  units: ProcessResourceUnits | undefined,
  signal: AbortSignal
): Promise<RunSample> {
  await mkdir(mangoHome, { recursive: true });
  let firstStderrMs: number | null = null;
  const startedAt = performance.now();
  const elapsed = () => performance.now() - startedAt;
  const owned: { scope?: BenchmarkChildScope; child?: ChildProcess; closed?: Promise<void> } = {};
  const peer = spawnPort(
    {
      argv: [binary, '--stdio'],
      env: {
        ...(process.env as Record<string, string>),
        ...homeEnv(mangoHome),
        MANGO_HOME: mangoHome,
      },
      onStderr: () => {
        firstStderrMs ??= elapsed();
      },
    },
    (command, args, options) => {
      const child = spawn(command, args, { ...options, detached: process.platform !== 'win32' });
      owned.child = child;
      const exited = new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.once('error', () => resolve());
      });
      owned.closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      if (child.pid !== undefined) {
        owned.scope = new BenchmarkChildScope({
          pid: child.pid,
          exited,
          alive: () => child.exitCode === null && child.signalCode === null,
          kill: (signal) => {
            child.kill(signal);
          },
        });
      }
      return child;
    }
  );
  const spawnMs = elapsed();
  const resourceState: { monitor: ProcessResourceMonitor | null; error: string | null } = {
    monitor: null,
    error: null,
  };
  const cleanupState: { resources: ProcessResourceObservation | null } = { resources: null };
  let helloMs: number | null = null;
  let firstRequestMs: number | null = null;
  let failure: string | null = null;
  let cleanupProven = true;
  const cleanupErrors: string[] = [];
  // Register handshake listeners immediately: procfs must not delay Session construction.
  const session = new Session(peer.port, {
    peer: { name: 'mangostudio-bench', version: 'bench', role: 'hub' },
    capabilities: { contracts: { [RUNTIME_CONTRACT_NAME]: RUNTIME_CONTRACT_VERSION } },
    handshakeTimeoutMs: HANDSHAKE_CEILING_MS,
  });
  const monitoring =
    units && peer.pid !== undefined
      ? startProcessResourceMonitor(peer.pid, units).then(
          (value) => {
            resourceState.monitor = value;
          },
          (error: unknown) => {
            resourceState.error = String(error);
          }
        )
      : Promise.resolve();
  try {
    await withBenchmarkCancellation(session.ready, signal);
    helloMs = elapsed();
    await withBenchmarkCancellation(
      session.request('runtime.health', {}, { timeoutMs: REQUEST_TIMEOUT_MS }),
      signal
    );
    firstRequestMs = elapsed();
    const monitoringError = await settleBenchmarkWork(monitoring, 2_000);
    if (monitoringError) throw new Error(`Runtime resource monitor: ${monitoringError}`);
    const readyError = await settleBenchmarkWork(
      resourceState.monitor?.markReady(startedAt + firstRequestMs) ?? Promise.resolve(),
      2_000
    );
    if (readyError) throw new Error(`Runtime readiness observation: ${readyError}`);
    failure = resourceState.error;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    const settlement = await owned.scope?.stop();
    if (!settlement?.settled) {
      cleanupProven = false;
      for (const error of settlement?.errors ?? ['child identity unavailable'])
        failure = recordBenchmarkCleanup(cleanupErrors, failure, 'Runtime', error);
    }
    session.closeNow();
    const exit = await peer.terminate();
    if (!exit && peer.pid !== undefined) {
      cleanupProven = false;
      failure = recordBenchmarkCleanup(
        cleanupErrors,
        failure,
        'Runtime',
        `expected terminal child pid ${peer.pid} | received: termination deadline`
      );
    }
    const closeError = owned.closed
      ? await settleBenchmarkWork(owned.closed, 2_000)
      : 'child close unavailable';
    if (closeError) {
      cleanupProven = false;
      failure = recordBenchmarkCleanup(cleanupErrors, failure, 'Runtime', closeError);
      owned.child?.stdin?.destroy();
      owned.child?.stdout?.destroy();
      owned.child?.stderr?.destroy();
    }
    const monitorError = await settleBenchmarkWork(
      monitoring.then(async () => {
        cleanupState.resources = (await resourceState.monitor?.stop()) ?? null;
      }),
      2_000
    );
    if (monitorError) {
      cleanupProven = false;
      failure = recordBenchmarkCleanup(cleanupErrors, failure, 'Runtime', monitorError);
    }
  }
  const resources = cleanupState.resources;
  const resourceCleanupError = units ? benchmarkResourceCleanupError(resources) : null;
  if (resourceCleanupError) {
    cleanupProven = false;
    failure = recordBenchmarkCleanup(cleanupErrors, failure, 'Runtime', resourceCleanupError);
  }
  if (
    resources &&
    (resources.errors.length ||
      !resources.summary ||
      resources.summary.sampleCount === 0 ||
      resources.summary.remainingIdentities.length)
  ) {
    failure ??= `Runtime resources: expected sampled and settled child tree | received: ${JSON.stringify(resources.errors.length ? resources.errors : resources.summary)}`;
  }
  if (failure) failure += `\nRuntime stderr:\n${peer.stderrTail().trim().slice(-2_000)}`;
  return {
    status: failure ? 'failed' : 'success',
    cleanupProven,
    cleanupErrors,
    failure,
    resources,
    spawnMs,
    helloMs,
    firstRequestMs,
    firstStderrMs,
  };
}

/** Where the numbers came from; a timing without its machine is half a measurement. */
async function environmentNotes(
  binary: string,
  version: string,
  freshCopy: boolean,
  buildLabel: string | undefined
) {
  const cpu = cpus();
  const size = (await stat(binary)).size;
  return {
    os: `${platform()} ${release()} ${arch()}`,
    cpu: `${cpu[0]?.model.trim() ?? 'unknown'} x${cpu.length}`,
    memoryGiB: Math.round(totalmem() / 2 ** 30),
    bun: Bun.version,
    binary,
    binaryMiB: Math.round((size / 2 ** 20) * 10) / 10,
    runtimeVersion: version,
    binarySha256: await sha256File(binary),
    build: buildLabel ?? buildProfileOf(binary),
    cache: freshCopy
      ? 'fresh copy per run; page cache warm after the copy'
      : 'same file every run; page cache warm after the untimed --version',
  };
}

/** The cargo profile a `target/<profile>/` path names, or `unknown`. */
function buildProfileOf(binary: string): string {
  if (/[\\/]debug[\\/]/.test(binary)) return 'debug';
  if (/[\\/]release[\\/]/.test(binary)) return 'release';
  return 'unknown';
}

async function main(): Promise<void> {
  const { flags, values, positional } = parseArgs({
    booleanFlags: ['--fresh-copy', '--json', '--resources'],
    valueFlags: ['--runs', '--build', '--warmups', '--output', '--journal'],
  });
  if (flags['--help']) printHelp();
  const supplied = positional.shift();
  assertNoUnexpectedArguments(positional);
  const binary = supplied ? resolve(supplied) : await newestWorkspaceBuild();
  if (!binary)
    fatal('No runtime binary. Build one with `cargo build -p mangostudio-runtime --locked`.');
  if (!(await Bun.file(binary).exists())) fatal(`No such binary: ${binary}`);
  const runs = Number(values['--runs'] ?? 20);
  const warmups = Number(values['--warmups'] ?? 2);
  if (!Number.isSafeInteger(runs) || runs < 1)
    fatal(`--runs: expected a positive safe integer | received: ${values['--runs']}`);
  if (!Number.isSafeInteger(warmups) || warmups < 0)
    fatal(`--warmups: expected a nonnegative safe integer | received: ${values['--warmups']}`);
  if (flags['--resources'] && process.platform !== 'linux')
    fatal(`--resources: expected Linux procfs | received: ${process.platform}`);
  const units = flags['--resources'] ? linuxProcessResourceUnits() : undefined;
  const freshCopy = flags['--fresh-copy'] ?? false;
  const quiet = flags['--json'] ?? false;
  const output = values['--output'] ? resolve(values['--output']) : undefined;
  const journal = values['--journal']
    ? resolve(values['--journal'])
    : output
      ? `${output}.jsonl`
      : undefined;
  const cancellation = benchmarkCancellation();
  let version: string;
  try {
    version = await runtimeVersion(binary, cancellation.signal);
  } catch (error) {
    cancellation.dispose();
    const failure = error instanceof Error ? error.message : String(error);
    const receipt = {
      complete: false,
      binary,
      phase: 'version',
      failure,
      retainedHome: error instanceof RuntimeVersionError ? error.home : null,
      settlement: error instanceof RuntimeVersionError ? error.settlement : 'unconfirmed',
      commandReceipt: error instanceof RuntimeVersionError ? error.commandReceipt : null,
    };
    await appendBenchmarkJournal(journal, { kind: 'version-failure', ...receipt });
    await writeBenchmarkProgress(output, receipt);
    if (quiet) log(JSON.stringify(receipt, null, 2));
    else console.error(failure);
    process.exitCode = 1;
    return;
  }
  const environment = await environmentNotes(binary, version, freshCopy, values['--build']);
  const sourceHead = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: REPO_ROOT });
  const sourceStatus = Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: REPO_ROOT });
  const source = {
    head: sourceHead.exitCode === 0 ? sourceHead.stdout.toString().trim() : null,
    dirty: sourceStatus.exitCode === 0 ? sourceStatus.stdout.length > 0 : null,
  };
  if (!quiet) {
    header(`Runtime handshake benchmark${freshCopy ? ' (fresh copy)' : ''}`);
    info(`${binary} (${version}) — ${warmups} warmups, ${runs} measured runs`);
  }
  const scratch = await mkdtemp(join(tmpdir(), 'mango-handshake-bench-'));
  const attempts: Array<RunSample & { phase: 'warmup' | 'measured'; index: number }> = [];
  await appendBenchmarkJournal(journal, {
    kind: 'batch',
    binary,
    environment,
    source,
    runs,
    warmups,
    at: new Date().toISOString(),
  });
  await writeBenchmarkProgress(output, {
    complete: false,
    binary,
    environment,
    source,
    runs,
    warmups,
    attempts,
  });
  let cleanupError: string | null = null;
  let scratchSafe = true;
  try {
    for (let run = 0; run < warmups + runs; run += 1) {
      if (cancellation.signal.aborted) break;
      const phase = run < warmups ? 'warmup' : 'measured';
      const index = phase === 'warmup' ? run + 1 : run - warmups + 1;
      await appendBenchmarkJournal(journal, {
        kind: 'started',
        phase,
        index,
        at: new Date().toISOString(),
      });
      let sample: RunSample;
      try {
        let target = binary;
        if (freshCopy) {
          target = join(scratch, `mangostudio-runtime-${run}${EXE}`);
          await copyFile(binary, target);
        }
        sample = await measureOnce(
          target,
          join(scratch, `home-${run}`),
          units,
          cancellation.signal
        );
      } catch (error) {
        sample = {
          status: 'failed',
          cleanupProven: false,
          cleanupErrors: ['cleanup could not be confirmed'],
          failure: String(error),
          resources: null,
          spawnMs: null,
          helloMs: null,
          firstRequestMs: null,
          firstStderrMs: null,
        };
      }
      if (!sample.cleanupProven) {
        scratchSafe = false;
        cleanupError = `Runtime cleanup unconfirmed; retained scratch ${scratch}`;
      }
      attempts.push({ ...sample, phase, index });
      await appendBenchmarkJournal(journal, {
        kind: 'finished',
        ...attempts.at(-1),
        at: new Date().toISOString(),
      });
      await writeBenchmarkProgress(output, {
        complete: false,
        environment,
        source,
        runs,
        warmups,
        attempts,
      });
      if (!quiet)
        info(
          `  ${phase} ${index}: ${sample.status}, hello ${sample.helloMs?.toFixed(1) ?? 'unavailable'} ms, first request ${sample.firstRequestMs?.toFixed(1) ?? 'unavailable'} ms`
        );
      if (sample.status === 'failed') break;
    }
  } finally {
    cancellation.dispose();
    if (scratchSafe) {
      try {
        await rm(scratch, { recursive: true, force: true, maxRetries: 5 });
      } catch (error) {
        cleanupError = String(error);
      }
    }
  }
  const samples = attempts.filter(
    (sample) => sample.phase === 'measured' && sample.status === 'success'
  );
  const phase = (pick: (sample: RunSample) => number | null): LatencySummary | null => {
    const values = samples.flatMap((sample) => {
      const value = pick(sample);
      return value === null ? [] : [value];
    });
    return values.length ? summarizeLatencies(values) : null;
  };
  const first = samples[0];
  const receipt = {
    environment,
    source,
    runs,
    warmups,
    resourceUnits: units ?? null,
    cleanupError,
    cancellation: cancellation.signal.aborted ? String(cancellation.signal.reason) : null,
    complete:
      samples.length === runs &&
      !cleanupError &&
      !cancellation.signal.aborted &&
      (await sha256File(binary)) === environment.binarySha256,
    artifactIdentityUnchanged: (await sha256File(binary)) === environment.binarySha256,
    phasesMs: {
      spawn: phase((sample) => sample.spawnMs),
      hello: phase((sample) => sample.helloMs),
      spawnToHello: phase((sample) =>
        sample.helloMs === null || sample.spawnMs === null ? null : sample.helloMs - sample.spawnMs
      ),
      firstRequest: phase((sample) => sample.firstRequestMs),
      helloToFirstRequest: phase((sample) =>
        sample.firstRequestMs === null || sample.helloMs === null
          ? null
          : sample.firstRequestMs - sample.helloMs
      ),
    },
    firstRunMs: first ? { hello: first.helloMs, firstRequest: first.firstRequestMs } : null,
    runsWithStderrBeforeAnswer: samples.filter((sample) => sample.firstStderrMs !== null).length,
    journal: journal ?? null,
    attempts,
  };
  const json = JSON.stringify(receipt, null, 2);
  await writeBenchmarkProgress(output, receipt);
  console.log(json);
  if (!receipt.complete) process.exitCode = 1;
}

if (import.meta.main) await main();
