#!/usr/bin/env bun
/**
 * Measures compiled hub readiness against isolated fresh or migrated databases.
 * Every attempt, including warmups and failures, is retained. "Cold" means a
 * fresh database; it does not empty the OS page cache.
 * Example: bun scripts/bench/startup.ts <binary> --runs 20 --warmups 2 --resources --json
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { assertNoUnexpectedArguments, fatal, parseArgs } from '../lib/args';
import { benchmarkCancellation, withBenchmarkCancellation } from '../lib/benchmark-cancellation';
import { appendBenchmarkJournal, writeBenchmarkProgress } from '../lib/benchmark-journal';
import { summarizeLatencies } from '../lib/latency-stats';
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
  pumpBenchmarkStream,
  recordBenchmarkCleanup,
  settleBenchmarkWork,
} from './benchmark-child-scope';
import { assertBenchmarkPlatform } from './benchmark-platform';

const READY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 5;
const BENCH_AUTH_SECRET = 'startup-bench-secret-at-least-32-chars';
const ROOT = resolve(import.meta.dir, '../..');

type ResourceStart = { monitor: ProcessResourceMonitor | null; error: string | null };
interface RunSample {
  readonly status: 'success' | 'failed';
  readonly cleanupProven: boolean;
  readonly cleanupErrors: readonly string[];
  readonly toHealthMs: number | null;
  /** Single-process VmHWM, retained separately from sampled process-tree RSS. */
  readonly peakRssKb: number | null;
  readonly resources: ProcessResourceObservation | null;
  readonly failure: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

function printHelp(): never {
  log(`Usage: bun scripts/bench/startup.ts <binary> [--runs N] [--warm] [--warmups N] [--resources] [--output file] [--json]

  --runs N      Measured attempts (default 10)
  --warm        Retain an isolated migrated database between measured attempts
  --warmups N   Labeled untimed warmups (default 1 for --warm, otherwise 0)
  --resources   Sample actual-child process-tree RSS/CPU through Linux procfs
  --journal file Append synced start/finish events (default: <output>.jsonl)
  --output file Save the complete receipt, including incomplete/failed batches
  --json        Print only the JSON receipt
  --help        Show this help message`);
  process.exit(0);
}

function benchEnv(home: string, port: number): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    ...homeEnv(home),
    NODE_ENV: 'production',
    MANGO_HOME: home,
    API_PORT: String(port),
    API_HOST: '127.0.0.1',
    AUTH_SECRET: BENCH_AUTH_SECRET,
    BETTER_AUTH_SECRET: BENCH_AUTH_SECRET,
    DATABASE_PATH: join(home, 'database.sqlite'),
    UPLOADS_DIR: join(home, 'uploads'),
    IMAGES_DIR: join(home, 'images'),
    TOOL_IMAGES_DIR: join(home, 'tool-images'),
    MANGOSTUDIO_DIAGNOSTIC_LOGS: '0',
  };
}

/** Validates that an HTTP readiness answer belongs to this isolated child. Example: ownsStartupState(state, pid, port, spawnedAt). */
export function ownsStartupState(
  state: unknown,
  pid: number,
  port: number,
  spawnedAt: number
): boolean {
  if (!state || typeof state !== 'object') return false;
  const value = state as Record<string, unknown>;
  return (
    value.pid === pid &&
    value.port === port &&
    typeof value.startedAt === 'number' &&
    Number.isFinite(value.startedAt) &&
    value.startedAt >= spawnedAt
  );
}

async function ownsServerState(
  home: string,
  pid: number,
  port: number,
  spawnedAt: number
): Promise<boolean> {
  try {
    return ownsStartupState(
      JSON.parse(await readFile(join(home, '.mango/run/server.json'), 'utf8')),
      pid,
      port,
      spawnedAt
    );
  } catch {
    return false;
  }
}

async function readPeakRssKb(pid: number): Promise<number | null> {
  if (process.platform !== 'linux') return null;
  try {
    const status = await Bun.file(`/proc/${pid}/status`).text();
    const value = status.match(/VmHWM:\s+(\d+) kB/)?.[1];
    return value === undefined ? null : Number(value);
  } catch {
    return null;
  }
}

async function reserveEphemeralPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!address || typeof address === 'string')
    throw new Error(
      'Startup port: expected an OS-selected loopback port | received: no TCP address'
    );
  return address.port;
}

function spawnHub(binary: string, home: string, port: number) {
  return Bun.spawn([binary, 'serve', String(port)], {
    env: benchEnv(home, port),
    detached: process.platform !== 'win32',
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

function resourceStart(
  pid: number,
  units: ProcessResourceUnits | undefined
): Promise<ResourceStart> {
  if (!units) return Promise.resolve({ monitor: null, error: null });
  return startProcessResourceMonitor(pid, units).then(
    (monitor) => ({ monitor, error: null }),
    (error: unknown) => ({
      monitor: null,
      error: error instanceof Error ? error.message : String(error),
    })
  );
}

async function measureOnce(
  binary: string,
  home: string,
  port: number,
  units: ProcessResourceUnits | undefined,
  signal: AbortSignal
): Promise<RunSample> {
  const startedAt = performance.now();
  const spawnedAt = Date.now();
  const child = spawnHub(binary, home, port);
  const scope = new BenchmarkChildScope({
    pid: child.pid,
    exited: child.exited,
    alive: () => child.exitCode === null && child.signalCode === null,
    kill: (signal) => child.kill(signal),
  });
  const stdout = pumpBenchmarkStream(child.stdout);
  const stderr = pumpBenchmarkStream(child.stderr);
  const monitoring = resourceStart(child.pid, units);
  let toHealthMs: number | null = null;
  let peakRssKb: number | null = null;
  const cleanupState: { resources: ProcessResourceObservation | null } = { resources: null };
  let failure: string | null = null;
  let monitor: ProcessResourceMonitor | null = null;
  let cleanupProven: boolean;
  const cleanupErrors: string[] = [];
  const deadline = startedAt + READY_TIMEOUT_MS;
  const poll = (async () => {
    while (performance.now() < deadline && child.exitCode === null && !signal.aborted) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
          signal: AbortSignal.timeout(1000),
        });
        await response.text();
        if (
          response.status === 200 &&
          child.exitCode === null &&
          (await ownsServerState(home, child.pid, port, spawnedAt))
        ) {
          toHealthMs = performance.now() - startedAt;
          return;
        }
      } catch {
        /* Connection refused/reset while the child starts. */
      }
      await Bun.sleep(POLL_INTERVAL_MS);
    }
  })();
  try {
    await withBenchmarkCancellation(
      Promise.race([poll, child.exited]),
      AbortSignal.any([signal, AbortSignal.timeout(READY_TIMEOUT_MS)])
    );
    if (toHealthMs === null) {
      failure =
        child.exitCode === null
          ? `Startup readiness: expected HTTP 200 and matching child state within ${READY_TIMEOUT_MS} ms | received: not ready`
          : `Startup readiness: expected a live healthy child | received: exit ${child.exitCode}`;
    }
    peakRssKb = await readPeakRssKb(child.pid);
    const monitoringError = await settleBenchmarkWork(monitoring, 2_000);
    if (monitoringError) throw new Error(`Startup resource monitor: ${monitoringError}`);
    const observation = await monitoring;
    monitor = observation.monitor;
    failure ??= observation.error;
    if (toHealthMs !== null) {
      const readyError = await settleBenchmarkWork(
        monitor?.markReady(startedAt + Number(toHealthMs)) ?? Promise.resolve(),
        2_000
      );
      if (readyError) throw new Error(`Startup readiness observation: ${readyError}`);
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    const settlement = await scope.stop();
    cleanupProven = settlement.settled;
    for (const error of settlement.errors)
      failure = recordBenchmarkCleanup(cleanupErrors, failure, 'Startup', error);
    const pollError = await settleBenchmarkWork(poll, 2_000);
    const monitorError = await settleBenchmarkWork(
      monitoring.then(async (observation) => {
        monitor ??= observation.monitor;
        failure ??= observation.error;
        cleanupState.resources = (await monitor?.stop()) ?? null;
      }),
      2_000
    );
    const streamError = await settleBenchmarkWork(Promise.all([stdout.done, stderr.done]), 2_000);
    if (streamError) {
      await settleBenchmarkWork(Promise.allSettled([stdout.cancel(), stderr.cancel()]), 2_000);
    }
    for (const error of [pollError, monitorError, streamError]) {
      if (!error) continue;
      cleanupProven = false;
      failure = recordBenchmarkCleanup(cleanupErrors, failure, 'Startup', error);
    }
  }
  const resources = cleanupState.resources;
  const resourceCleanupError = units ? benchmarkResourceCleanupError(resources) : null;
  if (resourceCleanupError) {
    cleanupProven = false;
    failure = recordBenchmarkCleanup(cleanupErrors, failure, 'Startup', resourceCleanupError);
  }
  if (
    resources &&
    (resources.errors.length > 0 ||
      !resources.summary ||
      resources.summary.sampleCount === 0 ||
      resources.summary.remainingIdentities.length > 0)
  ) {
    failure ??= `Startup resources: expected sampled and settled child tree | received: ${JSON.stringify(resources.errors.length ? resources.errors : resources.summary)}`;
  }
  return {
    status: failure ? 'failed' : 'success',
    cleanupProven,
    cleanupErrors,
    toHealthMs,
    peakRssKb,
    resources,
    failure,
    stdout: stdout.text(),
    stderr: stderr.text(),
  };
}

async function main(): Promise<void> {
  const { flags, values, positional } = parseArgs({
    booleanFlags: ['--warm', '--json', '--resources'],
    valueFlags: ['--runs', '--warmups', '--output', '--journal'],
  });
  if (flags['--help']) printHelp();
  const supplied = positional.shift();
  assertNoUnexpectedArguments(positional);
  if (!supplied) fatal('Pass the path to a compiled MangoStudio executable.');
  const binary = resolve(supplied);
  if (!(await Bun.file(binary).exists())) fatal(`No such binary: ${binary}`);
  const runs = Number(values['--runs'] ?? 10);
  const warm = flags['--warm'] ?? false;
  const warmups = Number(values['--warmups'] ?? (warm ? 1 : 0));
  if (!Number.isSafeInteger(runs) || runs < 1)
    fatal(`--runs: expected a positive safe integer | received: ${values['--runs']}`);
  if (!Number.isSafeInteger(warmups) || warmups < (warm ? 1 : 0))
    fatal(
      `--warmups: expected an integer at least ${warm ? 1 : 0} | received: ${values['--warmups']}`
    );
  if (flags['--resources'] && process.platform !== 'linux')
    fatal(`--resources: expected Linux procfs | received: ${process.platform}`);
  assertBenchmarkPlatform(process.platform);
  const units = flags['--resources'] ? linuxProcessResourceUnits() : undefined;
  const binarySha256 = await sha256File(binary);
  const gitHead = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const gitStatus = Bun.spawnSync(['git', 'status', '--porcelain'], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const source = {
    head: gitHead.exitCode === 0 ? gitHead.stdout.toString().trim() : null,
    dirty: gitStatus.exitCode === 0 ? gitStatus.stdout.length > 0 : null,
  };

  if (!flags['--json'])
    header(`Startup benchmark (${warm ? 'migrated database' : 'fresh database'})`);
  const attempts: Array<RunSample & { phase: 'warmup' | 'measured'; index: number }> = [];
  const output = values['--output'] ? resolve(values['--output']) : undefined;
  const journal = values['--journal']
    ? resolve(values['--journal'])
    : output
      ? `${output}.jsonl`
      : undefined;
  await appendBenchmarkJournal(journal, {
    kind: 'batch',
    binary,
    binarySha256,
    source,
    runs,
    warmups,
    at: new Date().toISOString(),
  });
  await writeBenchmarkProgress(output, {
    complete: false,
    binary,
    binarySha256,
    source,
    runs,
    warmups,
    attempts,
  });
  const sharedHome = warm ? await mkdtemp(join(tmpdir(), 'mango-bench-')) : undefined;
  const cancellation = benchmarkCancellation();
  let cleanupError: string | null = null;
  let sharedHomeSafe = true;
  try {
    for (let index = 0; index < warmups + runs; index += 1) {
      if (cancellation.signal.aborted) break;
      const phase = index < warmups ? 'warmup' : 'measured';
      const attemptIndex = phase === 'warmup' ? index + 1 : index - warmups + 1;
      await appendBenchmarkJournal(journal, {
        kind: 'started',
        phase,
        index: attemptIndex,
        at: new Date().toISOString(),
      });
      const home = sharedHome ?? (await mkdtemp(join(tmpdir(), 'mango-bench-')));
      let sample: RunSample;
      try {
        sample = await measureOnce(
          binary,
          home,
          await reserveEphemeralPort(),
          units,
          cancellation.signal
        );
      } catch (error) {
        sample = {
          status: 'failed',
          cleanupProven: false,
          cleanupErrors: ['cleanup could not be confirmed'],
          toHealthMs: null,
          peakRssKb: null,
          resources: null,
          failure: error instanceof Error ? error.message : String(error),
          stdout: '',
          stderr: '',
        };
      }
      if (!sample.cleanupProven) {
        sharedHomeSafe = false;
        cleanupError = `Startup cleanup unconfirmed; retained home ${home}`;
      } else if (!sharedHome) {
        try {
          await rm(home, { recursive: true, force: true, maxRetries: 5 });
        } catch (error) {
          cleanupError = String(error);
        }
      }
      attempts.push({
        ...sample,
        phase,
        index: phase === 'warmup' ? index + 1 : index - warmups + 1,
      });
      await appendBenchmarkJournal(journal, {
        kind: 'finished',
        ...attempts.at(-1),
        at: new Date().toISOString(),
      });
      await writeBenchmarkProgress(output, {
        complete: false,
        binary,
        binarySha256,
        source,
        runs,
        warmups,
        attempts,
        cleanupError,
        cancellation: cancellation.signal.aborted ? String(cancellation.signal.reason) : null,
      });
      if (!flags['--json'])
        info(
          `  ${phase} ${attempts.at(-1)?.index}: ${sample.status}, health ${sample.toHealthMs?.toFixed(1) ?? 'unavailable'} ms`
        );
      if (sample.status === 'failed' || cleanupError) break;
    }
  } finally {
    cancellation.dispose();
    if (sharedHome && sharedHomeSafe) {
      try {
        await rm(sharedHome, { recursive: true, force: true, maxRetries: 5 });
      } catch (error) {
        cleanupError = String(error);
      }
    }
  }
  const measured = attempts.filter(
    (attempt) => attempt.phase === 'measured' && attempt.status === 'success'
  );
  const health = measured.flatMap((attempt) =>
    attempt.toHealthMs === null ? [] : [attempt.toHealthMs]
  );
  const rss = measured.flatMap((attempt) =>
    attempt.peakRssKb === null ? [] : [attempt.peakRssKb]
  );
  const receipt = {
    binary,
    binarySha256,
    source,
    bun: Bun.version,
    platform: process.platform,
    mode: warm ? 'warm' : 'cold',
    cache:
      'isolated fresh/migrated database; file read for identity before warmups; OS page cache uncontrolled',
    runs,
    warmups,
    cleanupError,
    cancellation: cancellation.signal.aborted ? String(cancellation.signal.reason) : null,
    complete:
      measured.length === runs &&
      !cleanupError &&
      !cancellation.signal.aborted &&
      (await sha256File(binary)) === binarySha256,
    artifactIdentityUnchanged: (await sha256File(binary)) === binarySha256,
    toHealthMs: health.length ? summarizeLatencies(health) : null,
    peakRssKb: rss.length ? summarizeLatencies(rss).median : null,
    resourceUnits: units ?? null,
    samples: health,
    journal: journal ?? null,
    attempts,
  };
  const json = `${JSON.stringify(receipt, null, 2)}\n`;
  await writeBenchmarkProgress(output, receipt);
  console.log(json.trimEnd());
  if (!receipt.complete) process.exitCode = 1;
}

if (import.meta.main) await main();
