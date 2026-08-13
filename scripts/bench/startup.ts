#!/usr/bin/env bun

/**
 * Measures how long a MangoStudio binary takes to answer its first request.
 *
 * Startup is a user-visible cost for a CLI that ships as a standalone binary,
 * and "this made it faster" is easy to assert and hard to check. This runs the
 * real binary under a throwaway HOME and reports a median plus spread, so a
 * startup claim can be re-measured instead of re-argued.
 *
 * Every run is hermetic: HOME, MANGO_HOME, the database, uploads, and images
 * all point into a temp directory that is removed afterwards. The developer's
 * real ~/.mango is never read or written.
 *
 * Usage:
 *   bun run scripts/bench/startup.ts .mango/out/linux-x64/mangostudio
 *   bun run scripts/bench/startup.ts <binary> --runs 20
 *   bun run scripts/bench/startup.ts <binary> --warm
 *
 * Cold (default) measures a first run: an empty database, so every migration
 * applies. Warm applies the migrations once, discards that run, and then
 * measures against the migrated database — which is what a restart actually
 * costs, and the only mode where framework and module-load time are visible
 * rather than buried under migration work.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertNoUnexpectedArguments, fatal, parseArgs } from '../lib/args';
import { header, info, log } from '../lib/log';

const READY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 5;
const SHUTDOWN_TIMEOUT_MS = 5_000;
/** Long enough to be a real secret, fixed so runs are comparable. */
const BENCH_AUTH_SECRET = 'startup-bench-secret-at-least-32-chars';

interface RunSample {
  /** Process spawn until `GET /api/health` first answers 200, in ms. */
  readonly toHealthMs: number;
  /** Peak resident set size while starting, in kB; 0 where unavailable. */
  readonly peakRssKb: number;
}

function printHelp(): never {
  log(`Usage: bun run scripts/bench/startup.ts <binary> [--runs N] [--warm]

  <binary>     Path to a compiled MangoStudio executable
  --runs N     Measured runs (default 10)
  --warm       Migrate once and discard, then measure against the migrated DB
  --json       Print only the JSON result
  --help       Show this help message`);
  process.exit(0);
}

function benchEnv(home: string, port: number): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    // The parent may be NODE_ENV=test, which routes config at an in-memory
    // safety net and would ignore the explicit paths below.
    NODE_ENV: 'production',
    HOME: home,
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

/** Peak RSS of a still-live process, read before it is signalled. Linux only. */
async function readPeakRssKb(pid: number): Promise<number> {
  try {
    const status = await Bun.file(`/proc/${pid}/status`).text();
    return Number(status.match(/VmHWM:\s+(\d+) kB/)?.[1] ?? 0);
  } catch {
    return 0;
  }
}

/** Bind an OS-selected loopback port, then release it for the child to claim. */
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
  if (!address || typeof address === 'string') {
    throw new Error('Failed to allocate an ephemeral benchmark port.');
  }
  return address.port;
}

async function waitForExit(child: Bun.Subprocess, timeoutMs: number): Promise<void> {
  const timedOut = Symbol('timed-out');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      child.exited,
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), timeoutMs);
      }),
    ]);
    if (result === timedOut) {
      child.kill('SIGKILL');
      await child.exited;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function stopChild(child: Bun.Subprocess): Promise<void> {
  if (child.exitCode === null) child.kill('SIGTERM');
  await waitForExit(child, SHUTDOWN_TIMEOUT_MS);
}

/** Spawn the binary, wait for a healthy answer from *this* child, then stop it. */
async function measureOnce(binary: string, home: string, port: number): Promise<RunSample> {
  const startedAt = Bun.nanoseconds();
  const child = Bun.spawn([binary, 'serve', String(port)], {
    env: benchEnv(home, port),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let toHealthMs = Number.NaN;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  const poll = (async () => {
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
          signal: AbortSignal.timeout(1000),
        });
        await response.text();
        // Require 200 from a still-live child so a leftover listener on this
        // port cannot count as this process becoming ready.
        if (response.status === 200 && child.exitCode === null) {
          toHealthMs = (Bun.nanoseconds() - startedAt) / 1e6;
          return;
        }
      } catch {
        // Not listening yet.
      }
      await Bun.sleep(POLL_INTERVAL_MS);
    }
  })();

  await Promise.race([poll, child.exited]);
  const readyExitCode = child.exitCode;

  const peakRssKb = Number.isNaN(toHealthMs) ? 0 : await readPeakRssKb(child.pid);
  await stopChild(child);

  if (Number.isNaN(toHealthMs)) {
    const stderr = await new Response(child.stderr).text();
    const reason =
      readyExitCode === null
        ? `Binary never answered /api/health within ${READY_TIMEOUT_MS} ms.`
        : `Binary exited before answering /api/health (code ${readyExitCode}).`;
    throw new Error(`${reason}\n${stderr.slice(-2000)}`);
  }

  return { toHealthMs, peakRssKb };
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? Number.NaN;
  return ((sorted[middle - 1] ?? Number.NaN) + (sorted[middle] ?? Number.NaN)) / 2;
}

const { flags, values, positional } = parseArgs({
  booleanFlags: ['--warm', '--json'],
  valueFlags: ['--runs'],
});

if (flags['--help']) printHelp();

const binary = positional.shift();
assertNoUnexpectedArguments(positional);

if (!binary) fatal('Pass the path to a compiled MangoStudio executable.');
if (!(await Bun.file(binary).exists())) fatal(`No such binary: ${binary}`);

const runs = Number(values['--runs'] ?? 10);
if (!Number.isInteger(runs) || runs < 1) fatal('`--runs` must be a positive integer.');

const warm = flags['--warm'] ?? false;
const quiet = flags['--json'] ?? false;

if (!quiet) {
  header(`Startup benchmark (${warm ? 'warm' : 'cold'})`);
  info(`${binary} — ${runs} run(s)`);
}

const samples: RunSample[] = [];
// Warm mode reuses one home across runs so the migrated database survives;
// cold mode needs a fresh one each time, or run 2 would already be warm.
let sharedHome: string | undefined;
let failure: string | undefined;

try {
  if (warm) {
    sharedHome = await mkdtemp(join(tmpdir(), 'mango-bench-'));
    await measureOnce(binary, sharedHome, await reserveEphemeralPort());
  }

  for (let run = 0; run < runs; run += 1) {
    const home = sharedHome ?? (await mkdtemp(join(tmpdir(), 'mango-bench-')));
    try {
      const sample = await measureOnce(binary, home, await reserveEphemeralPort());
      samples.push(sample);
      if (!quiet) {
        info(`  run ${run + 1}/${runs}: ${sample.toHealthMs.toFixed(1)} ms`);
      }
    } finally {
      if (!sharedHome) await rm(home, { recursive: true, force: true });
    }
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  if (sharedHome) await rm(sharedHome, { recursive: true, force: true });
}

if (failure) fatal(failure);

const healthTimings = samples.map((sample) => sample.toHealthMs);
console.log(
  JSON.stringify(
    {
      binary,
      mode: warm ? 'warm' : 'cold',
      runs,
      toHealthMs: {
        median: Number(median(healthTimings).toFixed(1)),
        min: Number(Math.min(...healthTimings).toFixed(1)),
        max: Number(Math.max(...healthTimings).toFixed(1)),
      },
      peakRssKb: median(samples.map((sample) => sample.peakRssKb)),
      samples: healthTimings.map((value) => Number(value.toFixed(1))),
    },
    null,
    2
  )
);
