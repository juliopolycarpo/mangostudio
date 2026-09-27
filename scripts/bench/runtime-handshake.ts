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

import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { Session } from '@mangostudio/protocol';
import { spawnPort } from '@mangostudio/protocol/spawn';
import {
  RUNTIME_CONTRACT_NAME,
  RUNTIME_CONTRACT_VERSION,
} from '@mangostudio/shared/runtime-contract';

import { assertNoUnexpectedArguments, fatal, parseArgs } from '../lib/args';
import { type LatencySummary, summarizeLatencies } from '../lib/latency-stats';
import { header, info, log } from '../lib/log';

/** Far above any budget the hub uses, so a slow sample is measured, not refused. */
const HANDSHAKE_CEILING_MS = 120_000;
const REQUEST_TIMEOUT_MS = 60_000;
const EXE = process.platform === 'win32' ? '.exe' : '';
const REPO_ROOT = resolve(import.meta.dir, '../..');

interface RunSample {
  /** Until the launcher returned with a process, in ms. */
  readonly spawnMs: number;
  /** Until the runtime's `hello` arrived and negotiated. */
  readonly helloMs: number;
  /** Until the first `runtime.health` answer — the child is usable. */
  readonly firstRequestMs: number;
  /** Until the first stderr byte, or null when the child wrote none before its answer. */
  readonly firstStderrMs: number | null;
}

function printHelp(): never {
  log(`Usage: bun run scripts/bench/runtime-handshake.ts [binary] [--runs N] [--fresh-copy] [--build LABEL] [--json]

  [binary]      A mangostudio-runtime executable (default: newest of target/release, target/debug)
  --runs N      Measured runs (default 20)
  --fresh-copy  Run a new copy of the binary each time (first-execution cost)
  --build LABEL Build profile to report, for a binary outside target/ (e.g. a CI artifact)
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

/** Runs `--version` once; also the untimed warm-up every session starts with. */
async function runtimeVersion(binary: string): Promise<string> {
  const child = Bun.spawn([binary, '--version'], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) fatal(`${binary} --version exited with code ${code}; expected 0.`);
  return stdout.trim();
}

/** Spawns one child, handshakes like the hub, asks for health, and tears it down. */
async function measureOnce(binary: string, mangoHome: string): Promise<RunSample> {
  let firstStderrMs: number | null = null;
  const startedAt = performance.now();
  const elapsed = () => performance.now() - startedAt;

  const peer = spawnPort({
    argv: [binary, '--stdio'],
    env: { ...(process.env as Record<string, string>), MANGO_HOME: mangoHome },
    onStderr: () => {
      firstStderrMs ??= elapsed();
    },
  });
  const spawnMs = elapsed();
  if (peer.pid === undefined) {
    fatal(`could not start ${binary}: ${peer.stderrTail().trim() || 'no pid assigned'}`);
  }

  const session = new Session(peer.port, {
    peer: { name: 'mangostudio-bench', version: 'bench', role: 'hub' },
    capabilities: { contracts: { [RUNTIME_CONTRACT_NAME]: RUNTIME_CONTRACT_VERSION } },
    handshakeTimeoutMs: HANDSHAKE_CEILING_MS,
  });
  try {
    await session.ready;
    const helloMs = elapsed();
    await session.request('runtime.health', {}, { timeoutMs: REQUEST_TIMEOUT_MS });
    const firstRequestMs = elapsed();
    return { spawnMs, helloMs, firstRequestMs, firstStderrMs };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason}\nRuntime stderr:\n${peer.stderrTail().trim().slice(-2_000)}`);
  } finally {
    session.closeNow();
    await peer.terminate();
  }
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

const { flags, values, positional } = parseArgs({
  booleanFlags: ['--fresh-copy', '--json'],
  valueFlags: ['--runs', '--build'],
});
if (flags['--help']) printHelp();

const supplied = positional.shift();
assertNoUnexpectedArguments(positional);
const binary = supplied ? resolve(supplied) : await newestWorkspaceBuild();
if (!binary)
  fatal('No runtime binary. Build one with `cargo build -p mangostudio-runtime --locked`.');
if (!(await Bun.file(binary).exists())) fatal(`No such binary: ${binary}`);

const runs = Number(values['--runs'] ?? 20);
if (!Number.isInteger(runs) || runs < 1) {
  fatal(`\`--runs\` must be a positive integer | received: ${values['--runs']}`);
}
const freshCopy = flags['--fresh-copy'] ?? false;
const quiet = flags['--json'] ?? false;

const version = await runtimeVersion(binary);
if (!quiet) {
  header(`Runtime handshake benchmark${freshCopy ? ' (fresh copy)' : ''}`);
  info(`${binary} (${version}) — ${runs} run(s)`);
}

const samples: RunSample[] = [];
const scratch = await mkdtemp(join(tmpdir(), 'mango-handshake-bench-'));
try {
  for (let run = 0; run < runs; run += 1) {
    const home = join(scratch, `home-${run}`);
    let target = binary;
    if (freshCopy) {
      target = join(scratch, `mangostudio-runtime-${run}${EXE}`);
      await copyFile(binary, target);
    }
    const sample = await measureOnce(target, home);
    samples.push(sample);
    if (!quiet) {
      info(
        `  run ${run + 1}/${runs}: hello ${sample.helloMs.toFixed(1)} ms, first request ${sample.firstRequestMs.toFixed(1)} ms`
      );
    }
  }
} catch (error) {
  fatal(error instanceof Error ? error.message : String(error));
} finally {
  await rm(scratch, { recursive: true, force: true });
}

const phase = (pick: (sample: RunSample) => number): LatencySummary =>
  summarizeLatencies(samples.map(pick));
const stderrSamples = samples.filter((sample) => sample.firstStderrMs !== null).length;
const first = samples[0] as RunSample;

console.log(
  JSON.stringify(
    {
      environment: await environmentNotes(binary, version, freshCopy, values['--build']),
      runs,
      phasesMs: {
        spawn: phase((sample) => sample.spawnMs),
        hello: phase((sample) => sample.helloMs),
        // What the hub's handshake budget bounds: its clock starts once the
        // launcher has returned a process, so the spawn itself is not in it.
        spawnToHello: phase((sample) => sample.helloMs - sample.spawnMs),
        firstRequest: phase((sample) => sample.firstRequestMs),
        helloToFirstRequest: phase((sample) => sample.firstRequestMs - sample.helloMs),
      },
      firstRunMs: {
        hello: Math.round(first.helloMs * 10) / 10,
        firstRequest: Math.round(first.firstRequestMs * 10) / 10,
      },
      runsWithStderrBeforeAnswer: stderrSamples,
    },
    null,
    2
  )
);
