#!/usr/bin/env bun

/**
 * Measures the calls whose answer is large, and the start-up path they share,
 * on real `mangostudio-runtime` children over stdio.
 *
 * Scenarios:
 *   - `list-directory`: `fs.list-directory` over a directory of many small files
 *   - `read-file`: `fs.read-file` of one multi-MiB text file, every line in the window
 *   - `hello`: child start until the first `runtime.health` answer (handshake included)
 *
 * Every sample is a fresh child under a throwaway `MANGO_HOME`, so the peak resident set
 * size (Linux `VmHWM`, read after the call; 0 elsewhere) is that call's own. Candidates
 * rotate their run order (ABBA for two). Each sample carries a SHA-256 of the answer as
 * the client parsed it, and the run stops if two candidates answered differently: a speed
 * comparison between builds that disagree on the result is not a comparison.
 *
 * Usage:
 *   bun run scripts/bench/runtime-results.ts base=<old-binary> head=<new-binary> --runs 31
 *   bun run scripts/bench/runtime-results.ts <binary> --scenario list-directory --entries 50000
 *   bun run scripts/bench/runtime-results.ts <binary> --json
 *
 * Pin the CPU for a quiet comparison, for example `taskset -c 4,5 bun run ...`.
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { loadavg, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Session } from '@mangostudio/protocol';
import { spawnPort } from '@mangostudio/protocol/spawn';
import {
  RUNTIME_CONTRACT_NAME,
  RUNTIME_CONTRACT_VERSION,
} from '@mangostudio/shared/runtime-contract';

import { fatal, parseArgs } from '../lib/args';
import { rotatedOrder } from '../lib/bench-order';
import { summarizeLatencies } from '../lib/latency-stats';
import { header, info, log } from '../lib/log';
import { buildProfileOf, newestWorkspaceBuild } from './runtime-binary';

const HANDSHAKE_CEILING_MS = 120_000;
const REQUEST_TIMEOUT_MS = 120_000;
const REPO_ROOT = resolve(import.meta.dir, '../..');
const SCENARIOS = ['list-directory', 'read-file', 'hello'] as const;
type Scenario = (typeof SCENARIOS)[number];

interface Sample {
  readonly elapsedMs: number;
  readonly peakRssKb: number;
  /** SHA-256 of the answer as parsed; empty for `hello`, whose answer carries timestamps. */
  readonly digest: string;
  /** Entries listed, or content bytes read: what the call carried. */
  readonly carried: number;
}

/** The two answer fields a scenario counts; the rest of the answer is hashed, not read. */
interface Answer {
  readonly entries?: readonly unknown[];
  readonly content?: string;
}

interface Candidate {
  readonly label: string;
  readonly binary: string;
}

function printHelp(): never {
  log(`Usage: bun run scripts/bench/runtime-results.ts [[label=]binary ...] [--runs N] [--warmup N] [--scenario a,b] [--entries N] [--read-mib N] [--json]

  [label=]binary   mangostudio-runtime executables, interleaved run by run
  --runs N         Measured runs per scenario (default 15)
  --warmup N       Untimed runs per binary before measuring (default 0)
  --scenario LIST  Comma-separated subset of: ${SCENARIOS.join(', ')}
  --entries N      Files in the list-directory fixture (default 20000)
  --read-mib N     Size of the read-file fixture (default 8)
  --json           Print only the JSON result`);
  process.exit(0);
}

async function readPeakRssKb(pid: number): Promise<number> {
  try {
    const status = await Bun.file(`/proc/${pid}/status`).text();
    return Number(status.match(/VmHWM:\s+(\d+) kB/)?.[1] ?? 0);
  } catch {
    return 0;
  }
}

function parseCandidate(argument: string): Candidate {
  const separator = argument.indexOf('=');
  if (separator <= 0) return { label: 'binary', binary: resolve(argument) };
  return { label: argument.slice(0, separator), binary: resolve(argument.slice(separator + 1)) };
}

/** Nearest-rank quartiles, so the IQR names measured samples like the summary does. */
function spread(samples: readonly number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  const at = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))] ?? 0;
  const round = (value: number) => Math.round(value * 10) / 10;
  return { p25: round(at(0.25)), p75: round(at(0.75)), iqr: round(at(0.75) - at(0.25)) };
}

const digestOf = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Spawns a child, handshakes like the hub, and hands the session to `body`. */
async function withRuntime<T>(
  binary: string,
  mangoHome: string,
  body: (session: Session, pid: number) => Promise<T>
): Promise<T> {
  const peer = spawnPort({
    argv: [binary, '--stdio'],
    env: { ...(process.env as Record<string, string>), MANGO_HOME: mangoHome },
  });
  if (peer.pid === undefined) {
    fatal(`could not start ${binary}: ${peer.stderrTail().trim() || 'no pid assigned'}`);
  }
  const session = new Session(peer.port, {
    peer: { name: 'mangostudio-bench', version: 'bench', role: 'hub' },
    capabilities: { contracts: { [RUNTIME_CONTRACT_NAME]: RUNTIME_CONTRACT_VERSION } },
    handshakeTimeoutMs: HANDSHAKE_CEILING_MS,
  });
  try {
    return await body(session, peer.pid);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason}\nRuntime stderr:\n${peer.stderrTail().trim().slice(-2_000)}`);
  } finally {
    session.closeNow();
    await peer.terminate();
  }
}

const health = (session: Session) =>
  session.request('runtime.health', {}, { timeoutMs: REQUEST_TIMEOUT_MS });

async function helloSample(binary: string, home: string): Promise<Sample> {
  const startedAt = performance.now();
  return await withRuntime(binary, home, async (session, pid) => {
    await session.ready;
    await health(session);
    const elapsedMs = performance.now() - startedAt;
    return { elapsedMs, peakRssKb: await readPeakRssKb(pid), digest: '', carried: 0 };
  });
}

async function callSample(
  binary: string,
  home: string,
  method: string,
  params: Record<string, unknown>,
  carriedBy: (result: Answer) => number
): Promise<Sample> {
  return await withRuntime(binary, home, async (session, pid) => {
    await session.ready;
    // Untimed: the first request pays lazy initialisation no call should be charged for.
    await health(session);
    const startedAt = performance.now();
    const result = (await session.request(method, params, {
      timeoutMs: REQUEST_TIMEOUT_MS,
    })) as Answer;
    const elapsedMs = performance.now() - startedAt;
    return {
      elapsedMs,
      peakRssKb: await readPeakRssKb(pid),
      digest: digestOf(result),
      carried: carriedBy(result),
    };
  });
}

const { flags, values, positional } = parseArgs({
  booleanFlags: ['--json'],
  valueFlags: ['--runs', '--warmup', '--scenario', '--entries', '--read-mib'],
});
if (flags['--help']) printHelp();

function positiveInteger(flag: string, fallback: number, minimum = 1): number {
  const value = Number(values[flag] ?? fallback);
  if (!Number.isInteger(value) || value < minimum) {
    fatal(`\`${flag}\` must be an integer >= ${minimum} | received: ${values[flag]}`);
  }
  return value;
}

const candidates: Candidate[] = positional.splice(0).map(parseCandidate);
if (candidates.length === 0) {
  const newest = await newestWorkspaceBuild(REPO_ROOT);
  if (!newest)
    fatal(
      'No runtime binary. Build one with `cargo build --release -p mangostudio-runtime --locked`.'
    );
  candidates.push({ label: 'binary', binary: newest });
}
for (const { binary } of candidates) {
  if (!(await Bun.file(binary).exists())) fatal(`No such binary: ${binary}`);
}
if (new Set(candidates.map(({ label }) => label)).size !== candidates.length) {
  fatal(
    `binary labels must be unique | received: ${candidates.map(({ label }) => label).join(', ')}`
  );
}

const runs = positiveInteger('--runs', 15);
const warmup = positiveInteger('--warmup', 0, 0);
const entries = positiveInteger('--entries', 20_000);
const readMib = positiveInteger('--read-mib', 8);
const requested = (values['--scenario'] ?? SCENARIOS.join(',')).split(',');
const unknown = requested.filter((name) => !(SCENARIOS as readonly string[]).includes(name));
if (unknown.length > 0) {
  fatal(`unknown scenario ${unknown.join(', ')} | expected one of: ${SCENARIOS.join(', ')}`);
}
const scenarios = requested as Scenario[];
const quiet = flags['--json'] ?? false;

if (!quiet) {
  header('large-answer benchmark');
  info(
    `${candidates.map(({ label, binary }) => `${label}=${binary} (${buildProfileOf(binary)})`).join(' vs ')} - ${runs} run(s) per scenario (after ${warmup} warm-up), interleaved: ${scenarios.join(', ')}`
  );
}

const scratch = await mkdtemp(join(tmpdir(), 'mango-results-bench-'));
const results: Record<string, unknown> = {};
try {
  const listDirectory = join(scratch, 'list');
  const readFixture = join(scratch, 'read', 'big.txt');
  if (scenarios.includes('list-directory')) {
    await mkdir(listDirectory, { recursive: true });
    for (let index = 0; index < entries; index += 1) {
      await writeFile(join(listDirectory, `entry-${String(index).padStart(6, '0')}.txt`), '');
    }
  }
  if (scenarios.includes('read-file')) {
    await mkdir(join(scratch, 'read'), { recursive: true });
    const line = 'the quick brown fox jumps over the lazy dog id=12345 and again id=6\n';
    await writeFile(readFixture, line.repeat(Math.ceil((readMib * 2 ** 20) / line.length)));
  }

  for (const scenario of scenarios) {
    const samples = new Map<string, Sample[]>(candidates.map(({ label }) => [label, []]));
    const loadBefore = loadavg()[0] ?? 0;
    for (let run = -warmup; run < runs; run += 1) {
      let digest: string | undefined;
      for (const { label, binary } of rotatedOrder(candidates, run)) {
        const home = join(scratch, `home-${scenario}-${label}-${run + warmup}`);
        const sample =
          scenario === 'hello'
            ? await helloSample(binary, home)
            : scenario === 'list-directory'
              ? await callSample(
                  binary,
                  home,
                  'fs.list-directory',
                  { inputPath: listDirectory, resolvedPath: listDirectory },
                  (result) => result.entries?.length ?? 0
                )
              : await callSample(
                  binary,
                  home,
                  'fs.read-file',
                  {
                    chatId: 'bench',
                    inputPath: readFixture,
                    resolvedPath: readFixture,
                    maxLines: 10_000_000,
                  },
                  (result) => result.content?.length ?? 0
                );
        if (digest !== undefined && sample.digest !== digest) {
          fatal(
            `expected every candidate to answer ${scenario} identically | received: ${label} answered with digest ${sample.digest}, an earlier one with ${digest}`
          );
        }
        digest = sample.digest;
        if (run < 0) continue;
        samples.get(label)?.push(sample);
        if (!quiet) {
          info(`  ${scenario} ${label} run ${run + 1}/${runs}: ${sample.elapsedMs.toFixed(1)} ms`);
        }
      }
    }
    const perBinary: Record<string, unknown> = {};
    for (const [label, own] of samples) {
      const elapsed = own.map((sample) => sample.elapsedMs);
      const peak = own.map((sample) => sample.peakRssKb);
      perBinary[label] = {
        carried: own[0]?.carried ?? 0,
        answerDigest: own[0]?.digest ?? '',
        elapsedMs: { ...summarizeLatencies(elapsed), ...spread(elapsed) },
        peakRssKb: { ...summarizeLatencies(peak), ...spread(peak) },
        rawElapsedMs: elapsed.map((value) => Math.round(value * 10) / 10),
        rawPeakRssKb: peak,
      };
    }
    results[scenario] = {
      loadAverage1mBefore: loadBefore,
      loadAverage1mAfter: loadavg()[0] ?? 0,
      binaries: perBinary,
    };
  }
} catch (error) {
  fatal(error instanceof Error ? error.message : String(error));
} finally {
  await rm(scratch, { recursive: true, force: true });
}

const binaries = await Promise.all(
  candidates.map(async ({ label, binary }) => ({
    label,
    binary,
    buildProfile: buildProfileOf(binary),
    binaryBytes: (await stat(binary)).size,
  }))
);
console.log(
  JSON.stringify({ binaries, entries, readMib, runs, warmup, scenarios: results }, null, 2)
);
